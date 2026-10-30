// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { launchDesktop, captureDesktop, background } from './smoke-window.mjs';

const live = process.argv.includes('--live');
const development = process.argv.includes('--dev');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
for (const name of ['SEOHOKIM_LOOP_OPENAI_API_KEY', 'SEOHOKIM_LOOP_OPENAI_BASE_URL', 'SEOHOKIM_LOOP_OPENAI_MODEL']) delete environment[name];
if (live && (!environment.SEOHOKIM_LOOP_ANTHROPIC_API_KEY?.trim() || !environment.SEOHOKIM_LOOP_ANTHROPIC_MODEL?.trim())) {
  console.log('SKIP: external Claude smoke requires Anthropic API key and model environment settings.');
  process.exit(0);
}
if (!live) {
  delete environment.SEOHOKIM_LOOP_ANTHROPIC_API_KEY;
  delete environment.SEOHOKIM_LOOP_ANTHROPIC_MODEL;
}
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'seohokim-anthropic-smoke-'));
const mode = `anthropic-${live ? 'live' : development ? 'development' : 'production'}`;
const secret = live ? environment.SEOHOKIM_LOOP_ANTHROPIC_API_KEY.trim() : 'fake-desktop-claude-key';
const replacement = 'fake-desktop-claude-replacement';
const openaiSecret = 'fake-desktop-openai-regression';
const fallback = 'fake-desktop-claude-fallback';
let expectedKey = secret;
let expectedModel = 'test-claude-model';
let responseMode = 'success';
let claudeCalls = 0;
let openaiCalls = 0;
const failures = [];
const logs = [];
const server = live ? undefined : createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(request.method, 'POST'); assert.equal(body.stream, false);
    assert.equal(body.messages.length, 1); assert.equal(body.messages[0].role, 'user');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/chat/completions') {
      openaiCalls++;
      assert.equal(request.headers.authorization, `Bearer ${openaiSecret}`);
      response.end(JSON.stringify({ choices: [{ message: { content: 'OPENAI_REGRESSION_OK' } }] }));
      return;
    }
    claudeCalls++;
    assert.equal(request.url, '/v1/messages');
    assert.equal(request.headers['x-api-key'], expectedKey);
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    assert.equal(body.model, expectedModel);
    assert.ok([16, 2048].includes(body.max_tokens));
    if (body.max_tokens === 16) assert.equal(body.messages[0].content, 'Reply with OK.');
    if (responseMode === 'network') { response.destroy(); return; }
    if (responseMode === '401' || responseMode === '500') {
      response.writeHead(Number(responseMode)); response.end(JSON.stringify({ error: expectedKey })); return;
    }
    if (responseMode === 'malformed') { response.end(expectedKey); return; }
    response.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'CLAUDE_DESKTOP_OK' }] }));
  } catch {
    failures.push('Unexpected local request.'); response.writeHead(500); response.end('{}');
  }
});
if (server) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = server ? `http://127.0.0.1:${server.address().port}` : undefined;
let desktop;
let vite;
async function launch(env = environment) {
  desktop = await launchDesktop({ executablePath: electronPath,
    args: [root, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`], cwd: root, env, timeout: 30_000 });
  desktop.process().stdout?.on('data', (data) => logs.push(data.toString()));
  desktop.process().stderr?.on('data', (data) => logs.push(data.toString()));
  const page = await desktop.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', () => failures.push('Renderer error.'));
  page.on('console', (entry) => { if (entry.type() === 'error') failures.push('Renderer console error.'); });
  await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
  assert.equal(await page.locator('#execution-mode').inputValue(), 'auto');
  await page.locator('#execution-mode').selectOption('single');
  if (!background) await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window.isVisible()) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Desktop did not show.')), 5_000);
      window.once('show', () => { clearTimeout(timer); resolve(); });
    });
  });
  if (!live) {
    // Playwright-only main transport substitution. No test endpoint/env/IPC exists in the app.
    await desktop.evaluate((_electron, base) => {
      const original = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        if (String(url) === 'https://api.anthropic.com/v1/messages') return original(`${base}/v1/messages`, init);
        if (String(url) === `${base}/v1/chat/completions`) return original(url, init);
        throw new Error('Unexpected smoke transport target.');
      };
    }, base);
  }
  const preferences = await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { visible: window.isVisible(), ...window.webContents.getLastWebPreferences() };
  });
  assert.equal(preferences.visible, !background); assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  assert.equal(await desktop.evaluate(() => process.env.SEOHOKIM_LOOP_ANTHROPIC_API_KEY === undefined), true);
  await page.getByRole('navigation').getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('article', { name: 'Claude', exact: true }).waitFor();
  return page;
}
const card = (page, name = 'Claude') => page.getByRole('article', { name, exact: true });
async function edit(page, { model, key, baseUrl } = {}) {
  const target = card(page, baseUrl ? 'OpenAI-compatible' : 'Claude');
  await target.getByRole('button', { name: /연결 설정|연결 수정/ }).click();
  const password = target.getByLabel('API Key', { exact: true });
  assert.equal(await password.inputValue(), '');
  if (baseUrl) await target.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  else assert.equal(await target.getByLabel('Base URL', { exact: true }).count(), 0);
  if (model) await target.getByLabel('Model', { exact: true }).fill(model);
  if (key) await password.fill(key);
  await target.getByRole('button', { name: '저장', exact: true }).click();
  await target.getByRole('form').waitFor({ state: 'detached' });
}
async function check(page, state = 'success') {
  await card(page).getByRole('button', { name: '연결 확인', exact: true }).click();
  await card(page).locator(`[data-check-status="${state}"]`).waitFor({ timeout: 20_000 });
}
async function noSecrets(page) {
  const data = await page.evaluate(async () => [await window.seohoKimLoop.listProviders(),
    await window.seohoKimLoop.getConfiguration('anthropic'), await window.seohoKimLoop.getConfiguration('openai-compatible')]);
  const text = JSON.stringify(data) + await page.locator('body').innerText() + logs.join('');
  for (const key of [secret, replacement, openaiSecret, fallback]) assert.ok(!text.includes(key), 'No credentials in public objects, DOM or logs.');
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(await page.evaluate(() => Object.keys(window.seohoKimLoop).sort()),
    ['cancelExecution', 'deleteHistory', 'executeProvider', 'exportMarkdown', 'getConfiguration', 'getHistory', 'listHistory', 'listProviders', 'removeConfiguration', 'saveConfiguration', 'saveHistory', 'selectOllamaModel', 'selectTextFiles', 'testConnection']);
}
async function loop(page, id, expected) {
  await page.getByRole('navigation').getByRole('button', { name: 'Loop', exact: true }).click();
  await page.getByRole('combobox', { name: '사용할 AI' }).selectOption(id);
  await page.getByRole('textbox', { name: '새 작업' }).fill('간단한 결과를 작성해주세요.');
  await page.getByRole('button', { name: 'Start Loop', exact: true }).click();
  await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
  assert.match(await page.getByTestId('final-result').innerText(), expected);
  assert.equal(await page.getByTestId('step').count(), id === 'mock' ? 5 : 1);
  await page.getByRole('navigation').getByRole('button', { name: 'Connections', exact: true }).click();
}

try {
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  let page = await launch();
  assert.equal(await page.getByTestId('connection-card').count(), 5);
  assert.equal(await page.locator('[data-provider-id="codex-cli-local"]').getByRole('heading', { name: 'Codex CLI', exact: true }).count(), 1);
  if (live) {
    await check(page); await noSecrets(page);
  } else {
    assert.equal(await card(page).getByRole('button', { name: '연결 확인', exact: true }).isDisabled(), true);
    await edit(page, { model: 'test-openai', key: openaiSecret, baseUrl: `${base}/v1` });
    const openaiFile = path.join(profile, 'openai-compatible-connection.json');
    const claudeFile = path.join(profile, 'anthropic-connection.json');
    const preservedOpenAI = await readFile(openaiFile, 'utf8');
    await card(page, 'OpenAI-compatible').getByRole('button', { name: '연결 확인', exact: true }).click();
    await card(page, 'OpenAI-compatible').locator('[data-check-status="success"]').waitFor();
    const openaiCheckedAt = await card(page, 'OpenAI-compatible').locator('time').getAttribute('datetime');
    await edit(page, { model: expectedModel, key: secret });
    assert.equal(claudeCalls, 0, 'Save does not call Claude.');
    assert.equal(await card(page, 'OpenAI-compatible').locator('time').getAttribute('datetime'), openaiCheckedAt);
    const disk = await readFile(claudeFile, 'utf8');
    assert.ok(!disk.includes(secret)); assert.ok(!disk.includes(Buffer.from(secret).toString('base64')));
    assert.deepEqual(Object.keys(JSON.parse(disk)).sort(), ['encryptedApiKey', 'model', 'providerId', 'version']);
    assert.equal(await readFile(openaiFile, 'utf8'), preservedOpenAI);
    await noSecrets(page); await check(page);
    for (const [failure, reason] of [['401', '인증 정보를 확인해주세요.'], ['500', '서버 응답에 오류가 있습니다.'],
      ['malformed', '지원하지 않는 응답입니다.'], ['network', '서버에 연결할 수 없습니다.']]) {
      responseMode = failure; await check(page, 'failed');
      assert.ok((await card(page).getByRole('alert').innerText()).includes(reason)); await noSecrets(page);
    }
    responseMode = 'success'; expectedModel = 'edited-claude-model';
    await edit(page, { model: expectedModel }); await check(page);
    expectedKey = replacement;
    await edit(page, { key: replacement }); await check(page);
    assert.equal(await card(page, 'OpenAI-compatible').locator('time').getAttribute('datetime'), openaiCheckedAt);
    const calls = claudeCalls + openaiCalls;
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await card(page).getByRole('button', { name: '연결 수정', exact: true }).waitFor();
    assert.equal(claudeCalls + openaiCalls, calls);
    await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-connections.png`), fullPage: true });
    await loop(page, 'anthropic', /CLAUDE_DESKTOP_OK/);
    await loop(page, 'openai-compatible', /OPENAI_REGRESSION_OK/);
    const beforeMock = claudeCalls + openaiCalls;
    await loop(page, 'mock', /Mock AI/); assert.equal(claudeCalls + openaiCalls, beforeMock);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
    await card(page).getByRole('button', { name: '연결 수정', exact: true }).click();
    assert.equal(await card(page).getByLabel('API Key', { exact: true }).inputValue(), '');
    await card(page).getByLabel('Model', { exact: true }).scrollIntoViewIfNeeded();
    await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-minimum.png`), fullPage: false });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth
      || [...document.querySelectorAll('.connection-card, .connection-editor')].some((element) => element.scrollWidth > element.clientWidth + 1)), false);
    await card(page).getByRole('button', { name: '취소', exact: true }).click(); await noSecrets(page);
    await desktop.close(); desktop = undefined;
    page = await launch({ ...environment, SEOHOKIM_LOOP_ANTHROPIC_API_KEY: fallback, SEOHOKIM_LOOP_ANTHROPIC_MODEL: 'fallback-model' });
    const restored = await page.evaluate(() => window.seohoKimLoop.getConfiguration('anthropic'));
    assert.equal(restored.value.source, 'saved'); assert.equal(restored.value.model, expectedModel);
    await check(page); await noSecrets(page);
    await card(page).getByRole('button', { name: '연결 제거', exact: true }).click();
    await card(page).getByText('개발 환경의 연결을 사용합니다.', { exact: false }).waitFor();
    await assert.rejects(readFile(claudeFile), { code: 'ENOENT' });
    assert.equal(await readFile(openaiFile, 'utf8'), preservedOpenAI);
    expectedKey = fallback; expectedModel = 'fallback-model'; await check(page);
    await edit(page, { model: expectedModel });
    const preservedClaude = await readFile(claudeFile, 'utf8');
    await card(page, 'OpenAI-compatible').getByRole('button', { name: '연결 제거', exact: true }).click();
    await card(page, 'OpenAI-compatible').getByRole('button', { name: '연결 설정', exact: true }).waitFor();
    assert.equal(await readFile(claudeFile, 'utf8'), preservedClaude); await check(page);
    await noSecrets(page);
    for (const file of await readdir(path.join(root, 'dist/assets'))) {
      if (!file.endsWith('.js')) continue;
      const bundle = await readFile(path.join(root, 'dist/assets', file), 'utf8');
      assert.doesNotMatch(bundle, /api\.anthropic\.com|SEOHOKIM_LOOP_ANTHROPIC_API_KEY|x-api-key|chat\/completions/);
      for (const key of [secret, replacement, openaiSecret, fallback]) assert.ok(!bundle.includes(key));
    }
  }
  assert.deepEqual(failures, []);
  await writeFile(path.join(artifacts, `${mode}-smoke.json`), JSON.stringify({ status: 'passed', mode, externalApi: live,
    claudeCalls, openaiCalls, checks: live ? ['one explicit tiny connection check', 'no credential readback'] :
      ['three cards', 'official transport mapped only in test main', 'Windows encrypted separate files', 'blank key retention and replacement',
        'explicit check success/auth/server/parse/network failures', 'other check state retained', 'one-provider Loop for Claude and OpenAI',
        'offline Mock', 'minimum editor', 'restart DPAPI restore', 'saved priority and environment fallback', 'delete isolation both ways',
        'no secrets in summaries/logs/bundle', 'seven restricted IPC methods including scoped cancellation'] }, null, 2));
  console.log(`PASS: ${mode} — ${live ? 'one external connection check' : 'local HTTP and encrypted independent connections'}.`);
} finally {
  await desktop?.close(); await vite?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(profile), path.resolve(tmpdir()));
  assert.ok(path.basename(profile).startsWith('seohokim-anthropic-smoke-'));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
