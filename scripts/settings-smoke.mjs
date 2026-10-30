// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { launchDesktop, captureDesktop } from './smoke-window.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const development = process.argv.includes('--dev');
const mode = `settings-${development ? 'development' : 'production'}`;
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'seohokim-settings-smoke-'));
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
for (const name of ['SEOHOKIM_LOOP_OPENAI_API_KEY', 'SEOHOKIM_LOOP_OPENAI_BASE_URL', 'SEOHOKIM_LOOP_OPENAI_MODEL', 'SEOHOKIM_LOOP_ANTHROPIC_API_KEY', 'SEOHOKIM_LOOP_ANTHROPIC_MODEL']) delete environment[name];
const secret = 'fake-desktop-settings-key';
const replacement = 'fake-desktop-replacement-key';
const fallbackKey = 'fake-desktop-fallback-key';
let expectedKey = secret;
let expectedModel = 'edited-model';
let expectedPath = '/v2/chat/completions';
let calls = 0;
let responseMode = 'success';
const failures = [];
const logs = [];
const server = createServer(async (request, response) => {
  try {
    calls += 1;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, expectedPath);
    assert.equal(request.headers.authorization, `Bearer ${expectedKey}`);
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    assert.equal(body.model, expectedModel);
    response.setHeader('Content-Type', 'application/json');
    if (responseMode === '401') {
      response.writeHead(401);
      response.end(JSON.stringify({ error: expectedKey }));
    } else response.end(JSON.stringify({ choices: [{ message: { content: 'SAVED_CONNECTION_OK' } }] }));
  } catch {
    failures.push('Unexpected local request.');
    response.writeHead(500);
    response.end('{}');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let desktop;
let vite;
async function launch(env = environment) {
  desktop = await launchDesktop({ executablePath: electronPath, args: [root, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`], cwd: root, env, timeout: 30_000 });
  desktop.process().stderr?.on('data', (data) => logs.push(data.toString()));
  desktop.process().stdout?.on('data', (data) => logs.push(data.toString()));
  const page = await desktop.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', () => failures.push('Renderer error.'));
  page.on('console', (message) => { if (message.type() === 'error') failures.push('Renderer console error.'); });
  await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
  assert.equal(await page.locator('#execution-mode').inputValue(), 'auto');
  await page.locator('#execution-mode').selectOption('single');
  await page.getByRole('navigation').getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 설정', exact: true }).or(page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 수정', exact: true })).waitFor();
  return page;
}
async function noSecrets(page) {
  const summaries = await page.evaluate(async () => [await window.seohoKimLoop.getConfiguration('openai-compatible'), await window.seohoKimLoop.listProviders()]);
  const text = JSON.stringify(summaries) + await page.locator('body').innerText();
  for (const key of [secret, replacement, fallbackKey]) assert.ok(!text.includes(key));
  assert.doesNotMatch(JSON.stringify(summaries), /encryptedApiKey|"apiKey"|Authorization|stack/);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
}
try {
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  let page = await launch();
  let card = page.getByRole('article', { name: 'OpenAI-compatible', exact: true });
  assert.equal(await page.getByRole('article', { name: 'Mock AI', exact: true }).getByRole('button').count(), 0);
  assert.equal(calls, 0);
  const preferences = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const file = await desktop.evaluate(({ app }) => `${app.getPath('userData')}/openai-compatible-connection.json`);
  assert.equal(path.dirname(path.resolve(file)), path.resolve(profile));
  await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 설정', exact: true }).click();
  await page.getByLabel('Base URL', { exact: true }).fill(`${base}/v1`);
  await page.getByLabel('Model', { exact: true }).fill('first-model');
  const password = page.getByLabel('API Key', { exact: true });
  assert.equal(await password.getAttribute('type'), 'password');
  await password.fill(secret);
  // Test unavailable encryption using the actual main path; no app-only test API.
  await desktop.evaluate(({ safeStorage }) => {
    globalThis.__settingsSmokeAvailability = safeStorage.isAsyncEncryptionAvailable;
    safeStorage.isAsyncEncryptionAvailable = async () => false;
  });
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '안전하게 저장할 수 없습니다' }).waitFor();
  assert.equal(await password.inputValue(), '', 'Clear newly entered keys even after a failed save.');
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await desktop.evaluate(({ safeStorage }) => { safeStorage.isAsyncEncryptionAvailable = globalThis.__settingsSmokeAvailability; delete globalThis.__settingsSmokeAvailability; });
  assert.equal(await desktop.evaluate(({ safeStorage }) => safeStorage.isAsyncEncryptionAvailable()), true);
  await password.fill(secret);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('form', { name: 'AI 연결 설정' }).waitFor({ state: 'detached' });
  assert.equal(await card.getAttribute('data-state'), 'ready');
  assert.equal(calls, 0, 'Saving configuration must not call AI.');
  let disk = await readFile(file, 'utf8');
  assert.ok(!disk.includes(secret));
  assert.ok(!disk.includes(Buffer.from(secret).toString('base64')));
  assert.equal(await desktop.evaluate(async ({ safeStorage }, { encrypted, expected }) =>
    (await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'))).result === expected,
  { encrypted: JSON.parse(disk).encryptedApiKey, expected: secret }), true, 'Actual Windows safeStorage round trip.');
  await noSecrets(page);
  await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 수정', exact: true }).click();
  assert.equal(await password.inputValue(), '', 'Never refill the stored key.');
  await page.getByLabel('Base URL', { exact: true }).fill(`${base}/v2`);
  await page.getByLabel('Model', { exact: true }).fill('edited-model');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('form', { name: 'AI 연결 설정' }).waitFor({ state: 'detached' });
  assert.equal(calls, 0);
  await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 확인', exact: true }).click();
  await card.locator('[data-check-status="success"]').waitFor();
  assert.equal(calls, 1, 'Blank-key edit must keep the key used by the server.');
  responseMode = '401';
  await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 확인', exact: true }).click();
  await card.getByRole('alert').filter({ hasText: '인증 정보를 확인해주세요.' }).waitFor();
  await noSecrets(page);
  responseMode = 'success';
  await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 수정', exact: true }).click();
  await password.fill(replacement);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('form', { name: 'AI 연결 설정' }).waitFor({ state: 'detached' });
  assert.equal(await card.locator('[data-check-status]').getAttribute('data-check-status'), 'not_checked');
  expectedKey = replacement;
  await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 확인', exact: true }).click();
  await card.locator('[data-check-status="success"]').waitFor();
  const beforeRefresh = calls;
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.getByRole('button', { name: '새로고침', exact: true }).waitFor();
  assert.equal(calls, beforeRefresh);
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-saved.png`), fullPage: true });

  await page.getByRole('navigation').getByRole('button', { name: 'Loop', exact: true }).click();
  const input = page.getByRole('textbox', { name: '새 작업' });
  await input.fill('저장 연결 검증');
  await page.getByRole('button', { name: 'Start Loop', exact: true }).click();
  await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
  assert.match(await page.getByTestId('final-result').innerText(), /Mock AI/);
  assert.equal(calls, beforeRefresh);
  await page.getByRole('combobox', { name: '사용할 AI' }).selectOption('openai-compatible');
  await page.getByRole('button', { name: 'Start Loop', exact: true }).click();
  await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
  assert.equal(await page.getByTestId('final-result').innerText(), 'SAVED_CONNECTION_OK');
  assert.equal(await page.getByTestId('step').count(), 1);
  await page.getByRole('navigation').getByRole('button', { name: 'Connections', exact: true }).click();
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
  await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 수정', exact: true }).click();
  assert.equal(await password.inputValue(), '');
  await page.getByLabel('Model', { exact: true }).scrollIntoViewIfNeeded();
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-editor-minimum.png`), fullPage: false });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth
    || [...document.querySelectorAll('.connection-card, .connection-editor')].some((element) => element.scrollWidth > element.clientWidth + 1)), false);
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await desktop.close(); desktop = undefined;

  // Real restart with the same profile verifies DPAPI-backed recovery and priority.
  page = await launch({ ...environment, SEOHOKIM_LOOP_OPENAI_API_KEY: fallbackKey, SEOHOKIM_LOOP_OPENAI_BASE_URL: `${base}/fallback`, SEOHOKIM_LOOP_OPENAI_MODEL: 'fallback-model' });
  card = page.getByRole('article', { name: 'OpenAI-compatible', exact: true });
  assert.equal((await page.evaluate(() => window.seohoKimLoop.getConfiguration('openai-compatible'))).value.source, 'saved');
  await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 확인', exact: true }).click();
  await card.locator('[data-check-status="success"]').waitFor();
  await noSecrets(page);
  await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 제거', exact: true }).click();
  await card.getByText('개발 환경의 연결을 사용합니다.', { exact: false }).waitFor();
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  expectedKey = fallbackKey; expectedModel = 'fallback-model'; expectedPath = '/fallback/chat/completions';
  await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 확인', exact: true }).click();
  await card.locator('[data-check-status="success"]').waitFor();
  assert.equal(await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 제거', exact: true }).count(), 0);
  await desktop.close(); desktop = undefined;

  // Malformed saved files stay visible as recoverable errors, not app crashes.
  await writeFile(file, 'invalid-test-settings');
  page = await launch();
  await page.getByRole('alert').filter({ hasText: '저장된 연결이 손상되었습니다.' }).waitFor();
  await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 제거', exact: true }).click();
  await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 제거', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 확인', exact: true }).isDisabled(), true);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await noSecrets(page);
  for (const key of [secret, replacement, fallbackKey]) assert.ok(!logs.join('').includes(key));
  assert.deepEqual(failures, []);
  assert.equal(calls, 6);
  await writeFile(path.join(artifacts, `${mode}-smoke.json`), `${JSON.stringify({ status: 'passed', mode, externalApi: false, localCalls: calls,
    checks: ['password input and immediate clear', 'unavailable encryption rejected', 'real Windows safeStorage round trip', 'ciphertext file outside repository', 'no credential readback', 'blank-key URL/model edit', 'key replacement', 'check success and auth failure', 'no API on save/refresh', 'offline Mock', 'saved Provider Loop', 'minimum window editor', 'restart recovery', 'saved-over-environment priority', 'remove and environment fallback', 'corrupt file recovery', 'secret-free summaries and logs'] }, null, 2)}\n`);
  console.log(`PASS: ${mode} — encrypted settings and local Provider integration.`);
} finally {
  await desktop?.close();
  await vite?.close();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(profile), path.resolve(tmpdir()));
  assert.ok(path.basename(profile).startsWith('seohokim-settings-smoke-'));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
