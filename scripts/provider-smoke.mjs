// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { launchDesktop, captureDesktop } from './smoke-window.mjs';

const live = process.argv.includes('--live');
const checkOnly = process.argv.includes('--check-only');
const development = process.argv.includes('--dev');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.SEOHOKIM_LOOP_ANTHROPIC_API_KEY;
delete environment.SEOHOKIM_LOOP_ANTHROPIC_MODEL;
const names = ['SEOHOKIM_LOOP_OPENAI_API_KEY', 'SEOHOKIM_LOOP_OPENAI_BASE_URL', 'SEOHOKIM_LOOP_OPENAI_MODEL'];
if (live && names.some((name) => !environment[name]?.trim())) {
  console.log('SKIP: live Provider smoke requires all three SEOHOKIM_LOOP_OPENAI_* environment variables.');
  process.exit(0);
}

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'seohokim-loop-provider-smoke-'));
const mode = `provider-${live ? 'live' : 'local'}${development ? '-dev' : ''}${checkOnly ? '-connection' : ''}`;
const secret = live ? environment.SEOHOKIM_LOOP_OPENAI_API_KEY.trim() : 'local-smoke-fake-credential';
let calls = 0;
let checkCalls = 0;
let workCalls = 0;
let responseMode = 'success';
let releaseCheck;
let checkArrived;
const serverErrors = [];
const server = live ? undefined : createServer(async (request, response) => {
  try {
    calls += 1;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    assert.equal(body.model, 'local-test-model');
    assert.equal(body.stream, false);
    assert.equal(body.messages[0].role, 'user');
    assert.ok(!text.includes(secret));
    if (body.max_completion_tokens !== undefined) {
      checkCalls += 1;
      assert.equal(body.max_completion_tokens, 16);
      assert.deepEqual(body.messages, [{ role: 'user', content: 'Reply with OK.' }]);
    } else {
      workCalls += 1;
    }
    if (responseMode === 'delayed-success') {
      checkArrived();
      await new Promise((resolve) => { releaseCheck = resolve; });
    }
    response.setHeader('Content-Type', 'application/json');
    if (responseMode === 'http-error') {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { message: `Must not reach renderer: ${secret}` } }));
    } else if (responseMode === 'parse-error') {
      response.end(`invalid JSON ${secret}`);
    } else if (responseMode === 'server-error') {
      response.writeHead(500);
      response.end(JSON.stringify({ error: secret }));
    } else if (responseMode === 'bad-shape') {
      response.end(JSON.stringify({ debug: secret }));
    } else if (responseMode === 'network-error') {
      response.destroy();
    } else {
      response.end(JSON.stringify({ choices: [{ message: { content: responseMode === 'delayed-success' ? secret : 'SEOHOKIM_LOOP_SMOKE_OK' } }] }));
    }
  } catch {
    serverErrors.push('Unexpected local test request.');
    response.writeHead(500);
    response.end('{}');
  }
});

if (server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  environment.SEOHOKIM_LOOP_OPENAI_API_KEY = secret;
  environment.SEOHOKIM_LOOP_OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  environment.SEOHOKIM_LOOP_OPENAI_MODEL = 'local-test-model';
}

let desktop;
let vite;
const errors = [];
try {
  if (development) {
    vite = await (await import('vite')).createServer();
    await vite.listen();
  }
  desktop = await launchDesktop({ executablePath: electronPath, args: [root, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`], cwd: root, env: environment, timeout: 30_000 });
  const page = await desktop.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', () => errors.push('Renderer runtime error.'));
  page.on('console', (message) => { if (message.type() === 'error') errors.push('Renderer console error.'); });
  await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
  assert.equal(await page.locator('#execution-mode').inputValue(), 'auto');
  await page.locator('#execution-mode').selectOption('single');
  const select = page.getByRole('combobox', { name: '사용할 AI' });
  await select.locator('option[value="openai-compatible"]').waitFor({ state: 'attached' });
  assert.equal(await select.inputValue(), 'mock', 'Single mode initially selects Mock.');
  assert.equal(calls, 0, 'Listing providers must not make API calls.');
  const summary = await page.evaluate(() => window.seohoKimLoop.listProviders());
  assert.equal(summary.ok, true);
  assert.equal(summary.value.find((entry) => entry.id === 'openai-compatible').configured, true);
  assert.ok(!JSON.stringify(summary).includes(secret));
  const navigation = page.getByRole('navigation', { name: '주 메뉴' });
  await navigation.getByRole('button', { name: 'Connections', exact: true }).click();
  const externalCard = page.getByRole('article', { name: 'OpenAI-compatible', exact: true });
  assert.equal(await externalCard.getAttribute('data-state'), 'ready');
  assert.match(await externalCard.innerText(), /설정 완료/);
  assert.match(await externalCard.innerText(), /설정 완료는 실제 연결 성공을 뜻하지 않습니다/);
  const checkButton = externalCard.getByRole('button', { name: '연결 확인', exact: true });
  assert.equal(await checkButton.isEnabled(), true);
  assert.equal(await externalCard.locator('[data-check-status]').getAttribute('data-check-status'), 'not_checked');
  assert.equal(await page.getByRole('article', { name: 'Mock AI', exact: true }).getByRole('button').count(), 0);
  assert.ok(!(await page.locator('body').innerText()).includes(secret));
  assert.equal(await page.locator('input:visible, textarea:visible').count(), 0);
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.getByRole('button', { name: '새로고침', exact: true }).waitFor();
  assert.equal(calls, 0, 'Connections navigation and refresh must not call the AI.');
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-connections.png`), fullPage: true });
  await navigation.getByRole('button', { name: 'Loop', exact: true }).click();
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await desktop.evaluate(() => process.env.SEOHOKIM_LOOP_OPENAI_API_KEY === undefined), true);
  const preferences = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.sandbox, true);
  const forbidden = await page.evaluate(() => window.seohoKimLoop.executeProvider({
    providerId: 'openai-compatible', url: 'https://unexpected.test',
    request: { userRequest: 'hello', stepTitle: 'work', previousOutputs: [], isFinalStep: true },
  }));
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'INVALID_REQUEST');
  const forbiddenCheck = await page.evaluate(() => window.seohoKimLoop.testConnection({ providerId: 'openai-compatible', url: 'https://unexpected.test' }));
  assert.equal(forbiddenCheck.ok, false);
  assert.equal(forbiddenCheck.code, 'unavailable');

  if (checkOnly) {
    await navigation.getByRole('button', { name: 'Connections', exact: true }).click();
    await checkButton.click();
    await externalCard.locator('[data-check-status="success"]').waitFor({ timeout: 20_000 });
    assert.equal(await externalCard.getAttribute('data-state'), 'ready');
    assert.equal(await externalCard.locator('time').count(), 1);
    assert.ok(!(await page.locator('body').innerText()).includes(secret));
    await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-checked.png`), fullPage: true });
  } else {
  await select.selectOption('openai-compatible');
  const input = page.getByRole('textbox', { name: '새 작업' });
  const start = page.getByRole('button', { name: 'Start Loop', exact: true });
  await input.fill('Reply with exactly: SEOHOKIM_LOOP_SMOKE_OK');
  await start.click();
  await page.locator('[data-testid="loop"][data-status="completed"]').waitFor({ timeout: 70_000 });
  assert.equal(await page.getByTestId('step').count(), 1);
  const result = await page.getByTestId('final-result').innerText();
  assert.ok(result.trim());
  assert.ok(!result.includes(secret));
  if (!live) {
    assert.equal(result, 'SEOHOKIM_LOOP_SMOKE_OK');
    assert.equal(calls, 1);
  }
  assert.ok(!(await page.locator('.demo-tag').innerText()).includes('예시 결과'));
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-completed.png`), fullPage: true });

  if (!live) {
    for (const [nextMode, errorCode] of [['http-error', 'HTTP_ERROR'], ['parse-error', 'RESPONSE_PARSE_ERROR']]) {
      responseMode = nextMode;
      await start.click();
      await page.locator('[data-testid="loop"][data-status="failed"]').waitFor();
      assert.equal(await page.locator('[data-testid="step"][data-status="failed"]').count(), 1);
      assert.equal(await page.getByTestId('final-result').count(), 0);
      assert.match(await page.getByRole('alert').innerText(), new RegExp(errorCode));
      assert.ok(!(await page.locator('body').innerText()).includes(secret));
    }
    await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-failed.png`), fullPage: true });
    responseMode = 'success';
    await start.click();
    await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
    assert.equal(calls, 4, 'One request per Loop; no retries.');

    // Connection checks use the actual preload/main/HTTP path, independently of Loop state.
    const preservedResult = await page.getByTestId('final-result').innerText();
    await navigation.getByRole('button', { name: 'Connections', exact: true }).click();
    responseMode = 'delayed-success';
    const arrived = new Promise((resolve) => { checkArrived = resolve; });
    await checkButton.evaluate((button) => { button.click(); button.click(); });
    await externalCard.locator('[data-check-status="checking"]').waitFor();
    await arrived;
    assert.equal(await externalCard.getByRole('button', { name: '확인 중…', exact: true }).isDisabled(), true);
    const duplicate = await page.evaluate(() => window.seohoKimLoop.testConnection('openai-compatible'));
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.code, 'busy');
    assert.equal(checkCalls, 1, 'Fast double-click and direct duplicate IPC must not send another request.');
    await navigation.getByRole('button', { name: 'Loop', exact: true }).click();
    assert.equal(await page.getByTestId('final-result').innerText(), preservedResult);
    await navigation.getByRole('button', { name: 'Connections', exact: true }).click();
    assert.equal(await externalCard.locator('[data-check-status]').getAttribute('data-check-status'), 'checking');
    releaseCheck();
    await externalCard.locator('[data-check-status="success"]').waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes(secret), 'Even a successful credential echo must be discarded.');
    const checkedAt = await externalCard.locator('time').getAttribute('datetime');
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.getByRole('button', { name: '새로고침', exact: true }).waitFor();
    assert.equal(await externalCard.locator('time').getAttribute('datetime'), checkedAt);
    assert.equal(checkCalls, 1, 'Refresh must retain check state without sending a check.');
    await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-check-success.png`), fullPage: true });

    for (const [nextMode, message] of [
      ['http-error', '인증 정보를 확인해주세요.'],
      ['server-error', '서버 응답에 오류가 있습니다.'],
      ['parse-error', '지원하지 않는 응답입니다.'],
      ['bad-shape', '지원하지 않는 응답입니다.'],
      ['network-error', '서버에 연결할 수 없습니다.'],
    ]) {
      responseMode = nextMode;
      await checkButton.click();
      await externalCard.locator('[data-check-status="failed"]').waitFor();
      assert.ok((await externalCard.getByRole('alert').innerText()).includes(message));
      assert.doesNotMatch(await externalCard.innerText(), /HTTP_ERROR|RESPONSE_PARSE_ERROR|Authorization|stack|HTTP \d/);
      assert.ok(!(await page.locator('body').innerText()).includes(secret));
      assert.equal(await externalCard.getAttribute('data-state'), 'ready', 'Connection failure must not rewrite configured state.');
      assert.equal(await checkButton.isEnabled(), true);
      await navigation.getByRole('button', { name: 'Loop', exact: true }).click();
      assert.equal(await select.inputValue(), 'openai-compatible');
      assert.equal(await input.inputValue(), 'Reply with exactly: SEOHOKIM_LOOP_SMOKE_OK');
      assert.equal(await page.getByTestId('final-result').innerText(), preservedResult);
      assert.equal(await page.getByTestId('loop').getAttribute('data-status'), 'completed');
      await navigation.getByRole('button', { name: 'Connections', exact: true }).click();
      assert.equal(await externalCard.locator('[data-check-status]').getAttribute('data-check-status'), 'failed');
    }
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
    await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-check-failed-minimum.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth
      || [...document.querySelectorAll('.connection-card, .connection-check')].some((element) => element.scrollWidth > element.clientWidth + 1)), false);
    responseMode = 'success';
    await checkButton.click();
    await externalCard.locator('[data-check-status="success"]').waitFor();
    assert.equal(checkCalls, 7, 'Exactly one HTTP request per explicit check, with no retries.');
    assert.equal(workCalls, 4);
    await navigation.getByRole('button', { name: 'Loop', exact: true }).click();
    await select.selectOption('mock');
    await start.click();
    await page.locator('[data-testid="loop"][data-status="completed"]').waitFor({ timeout: 15_000 });
    assert.equal(await page.getByTestId('step').count(), 5);
    assert.match(await page.getByTestId('final-result').innerText(), /Mock AI/);
    assert.equal(calls, 11, 'Switching back to Mock must remain offline.');
    await page.reload();
    await navigation.getByRole('button', { name: 'Connections', exact: true }).click();
    await externalCard.waitFor();
    assert.equal(await externalCard.locator('[data-check-status]').getAttribute('data-check-status'), 'not_checked');
    assert.equal(calls, 11, 'Window reload resets in-memory checks and must not contact the server.');
  }
  }
  for (const file of await readdir(path.join(root, 'dist/assets'))) {
    if (!file.endsWith('.js')) continue;
    const bundle = await readFile(path.join(root, 'dist/assets', file), 'utf8');
    assert.ok(!bundle.includes(secret));
    assert.ok(!bundle.includes('SEOHOKIM_LOOP_OPENAI_API_KEY'));
    assert.ok(!bundle.includes('chat/completions'));
  }
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, `${mode}-smoke.json`), `${JSON.stringify({ mode, status: 'passed', externalApi: live, localHttpCalls: calls, localCheckCalls: checkCalls, localWorkCalls: workCalls, checks: ['Auto default and explicit Single Mock selection', 'restricted IPC', 'renderer isolation', 'secret-free renderer bundle and metadata', 'configured Connections card without automatic API calls', ...(checkOnly ? ['one explicit connection check'] : ['one work step', 'Final Result']), ...(live ? [] : ['HTTP failure', 'parse failure', 'recovery', 'connection success', 'duplicate UI and IPC guard', 'check state across navigation and refresh', 'connection authentication/server/parse/network failures', 'Loop preserved after check failure', 'minimum window', 'return to offline Mock', 'reload resets check without network'])] }, null, 2)}\n`);
  console.log(`PASS: ${mode} Electron Provider smoke${live ? ' (one external request)' : ' (local HTTP only)'}.`);
} finally {
  releaseCheck?.();
  await desktop?.close();
  await vite?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
