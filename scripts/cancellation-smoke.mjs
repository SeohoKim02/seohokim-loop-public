// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { launchDesktop, captureDesktop } from './smoke-window.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = path.join(root, 'artifacts');
const development = process.argv.includes('--dev');
const mode = `cancellation-${development ? 'development' : 'production'}`;
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
for (const name of ['SEOHOKIM_LOOP_OPENAI_API_KEY', 'SEOHOKIM_LOOP_OPENAI_BASE_URL', 'SEOHOKIM_LOOP_OPENAI_MODEL',
  'SEOHOKIM_LOOP_ANTHROPIC_API_KEY', 'SEOHOKIM_LOOP_ANTHROPIC_MODEL']) delete environment[name];
const secrets = ['fake-cancel-desktop-openai', 'fake-cancel-desktop-claude'];
const errors = []; const logs = []; const requests = []; const servers = []; const aborts = [];
const profile = await mkdtemp(path.join(tmpdir(), 'seohokim-cancellation-smoke-'));
const requestText = '두 가지 작업 방식을 비교하는 짧은 안내를 작성해주세요.';
const plan = { title: '동적 안내', steps: ['특징 정리', '내용 검토', '안내 완성'].map((title, i) => ({ title,
  role: i === 1 ? 'review' : i === 2 ? 'deliver' : 'write', objective: title, usesPreviousOutputs: i > 0, isFinal: i === 2 })) };
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { resolve, promise }; }
async function deadline(promise, message) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5000); })]); }
  finally { clearTimeout(timer); }
}
let scenario; let desktop; let vite; let checkResponse; const checkArrived = deferred();
let checkAborted = false;
function prepare(kind, sequence, holdAt = -1, bodyHold = false) {
  scenario = { kind, sequence, holdAt, bodyHold, index: 0, outputs: [], arrived: deferred(), closed: deferred() };
  return scenario;
}
const responseBody = (id, output) => JSON.stringify(id === 'anthropic'
  ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: output }] }
  : { choices: [{ message: { content: output } }] });
async function serverFor(id) {
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      for (const secret of secrets) assert.ok(!raw.includes(secret));
      const body = JSON.parse(raw);
      assert.equal(id === 'anthropic' ? request.headers['x-api-key'] : request.headers.authorization,
        id === 'anthropic' ? secrets[1] : `Bearer ${secrets[0]}`);
      response.setHeader('Content-Type', 'application/json');
      if (body.max_tokens === 16 || body.max_completion_tokens === 16) {
        checkResponse = response;
        response.on('close', () => { if (!response.writableEnded) checkAborted = true; });
        checkArrived.resolve(); return;
      }
      const current = scenario; assert.ok(current);
      const index = current.index++; assert.equal(current.sequence[index], id);
      assert.ok(body.messages[0].content.includes(requestText));
      requests.push({ kind: current.kind, id, index });
      if (index === current.holdAt) {
        current.response = response;
        // Exercise both waiting for headers and abort during a partial JSON body.
        if (current.bodyHold) { response.writeHead(200); response.write('{"partial":'); }
        response.on('close', () => {
          if (!response.writableEnded) { aborts.push({ kind: current.kind, id, index }); current.closed.resolve(); }
        });
        current.arrived.resolve(); return;
      }
      const output = current.kind === 'auto' && index === 0 ? JSON.stringify(plan) : `${id} 결과 ${index}`;
      if (!(current.kind === 'auto' && index === 0)) current.outputs.push(output);
      response.end(responseBody(id, output));
    } catch { errors.push('Unexpected local cancellation request.'); response.writeHead(500); response.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function noSecrets(page) {
  const publicData = await page.evaluate(async () => [await window.seohoKimLoop.listProviders(),
    await window.seohoKimLoop.getConfiguration('openai-compatible'), await window.seohoKimLoop.getConfiguration('anthropic')]);
  const text = JSON.stringify(publicData) + await page.locator('body').innerText() + logs.join('');
  for (const secret of secrets) assert.ok(!text.includes(secret));
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
}

try {
  await mkdir(artifacts, { recursive: true });
  const openaiBase = await serverFor('openai-compatible'); const claudeBase = await serverFor('anthropic');
  Object.assign(environment, { SEOHOKIM_LOOP_OPENAI_API_KEY: secrets[0], SEOHOKIM_LOOP_OPENAI_BASE_URL: `${openaiBase}/v1`,
    SEOHOKIM_LOOP_OPENAI_MODEL: 'test-openai', SEOHOKIM_LOOP_ANTHROPIC_API_KEY: secrets[1], SEOHOKIM_LOOP_ANTHROPIC_MODEL: 'test-claude' });
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  desktop = await launchDesktop({ executablePath: electronPath, args: [root, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`],
    cwd: root, env: environment, timeout: 30_000 });
  desktop.process().stdout?.on('data', (data) => logs.push(data.toString())); desktop.process().stderr?.on('data', (data) => logs.push(data.toString()));
  const page = await desktop.firstWindow();
  page.on('pageerror', () => errors.push('Renderer error.')); page.on('console', (entry) => { if (entry.type() === 'error') errors.push('Renderer console error.'); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
  await desktop.evaluate((_electron, base) => {
    const original = globalThis.fetch;
    globalThis.fetch = (url, init) => original(String(url) === 'https://api.anthropic.com/v1/messages' ? `${base}/v1/messages` : url, init);
  }, claudeBase);
  const preferences = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined'); assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  assert.deepEqual(await page.evaluate(() => Object.keys(window.seohoKimLoop).sort()),
    ['cancelExecution', 'deleteHistory', 'executeProvider', 'exportMarkdown', 'getConfiguration', 'getHistory', 'listHistory', 'listProviders', 'removeConfiguration', 'saveConfiguration', 'saveHistory', 'selectOllamaModel', 'selectTextFiles', 'testConnection']);
  const modeChoice = page.locator('#execution-mode');
  const start = page.getByRole('button', { name: 'Start Loop', exact: true });
  const stop = page.getByRole('button', { name: '작업 중지', exact: true });
  const navigation = page.getByRole('navigation');
  const goConnections = () => navigation.getByRole('button', { name: 'Connections', exact: true }).click();
  const goLoop = () => navigation.getByRole('button', { name: 'Loop', exact: true }).click();
  await page.locator('#request').fill(requestText);
  assert.equal(await modeChoice.inputValue(), 'auto'); assert.equal(await stop.count(), 0);

  async function cancelledRun(kind, sequence, holdAt, { bodyHold = false, connectionCheck = false } = {}) {
    const before = requests.length; const current = prepare(kind, sequence, holdAt, bodyHold);
    await start.click(); await deadline(current.arrived.promise, 'Slow request did not arrive.');
    if (kind === 'auto' && holdAt === 0) {
      assert.match(await page.getByTestId('auto-plan').innerText(), /작업 계획 준비/); assert.equal(await page.getByTestId('step').count(), 0);
    }
    await stop.waitFor(); assert.equal(await modeChoice.isDisabled(), true);
    await goConnections();
    if (connectionCheck) {
      await page.getByRole('article', { name: 'Claude', exact: true }).getByRole('button', { name: '연결 확인', exact: true }).click();
      await deadline(checkArrived.promise, 'Connection check did not arrive.');
    }
    await goLoop(); assert.equal(await stop.isEnabled(), true);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
    await stop.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    const buttons = await page.locator('.execution-actions button').evaluateAll((elements) => elements.map((e) => {
      const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: e.clientWidth, content: e.scrollWidth };
    }));
    assert.equal(buttons.length, 2); assert.ok(buttons.every((b) => b.content <= b.width + 1));
    const [a, b] = buttons; assert.equal(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top, false);
    if (kind === 'auto' && holdAt === 0) await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-running-minimum.png`) });
    const cancelStarted = Date.now();
    await stop.evaluate((button) => { button.click(); button.click(); button.click(); });
    await page.locator('[data-testid="loop"][data-status="cancelled"]').waitFor({ timeout: 5000 });
    await deadline(current.closed.promise, 'Client HTTP connection did not close after cancellation.');
    assert.ok(Date.now() - cancelStarted < 5000);
    assert.equal(requests.length, before + holdAt + 1); assert.equal(await page.getByTestId('final-result').count(), 0);
    assert.equal(await page.getByRole('alert').count(), 0); assert.equal(await stop.count(), 0); assert.equal(await start.isEnabled(), true);
    const cancelledIndex = holdAt - (kind === 'auto' ? 1 : 0);
    if (cancelledIndex >= 0) {
      const steps = page.getByTestId('step'); assert.equal(await steps.nth(cancelledIndex).getAttribute('data-status'), 'cancelled');
      for (let i = 0; i < cancelledIndex; i++) {
        assert.equal(await steps.nth(i).getAttribute('data-status'), 'completed');
        await steps.nth(i).getByText('단계 결과 보기', { exact: true }).click();
        assert.equal(await steps.nth(i).locator('.step-output').innerText(), current.outputs[i]);
      }
      for (let i = cancelledIndex + 1; i < await steps.count(); i++) assert.match(await steps.nth(i).innerText(), /실행되지 않음/);
    }
    // A server attempting a late result sees a destroyed stream; no UI update follows.
    assert.equal(current.response.destroyed, true);
    current.response.end(responseBody(sequence[holdAt], 'late result must not be final'));
    if (connectionCheck) {
      assert.equal(checkAborted, false); assert.equal(checkResponse.destroyed, false);
      checkResponse.end(responseBody('anthropic', 'OK'));
      await goConnections(); await page.locator('[data-provider-id="anthropic"] [data-check-status="success"]').waitFor(); await goLoop();
    } else { await goConnections(); await goLoop(); }
    assert.equal(await page.getByTestId('loop').getAttribute('data-status'), 'cancelled');
    assert.equal(await page.getByTestId('final-result').count(), 0); await noSecrets(page);
    await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-${kind}-${holdAt}-${sequence[holdAt]}-cancelled.png`), fullPage: true });
  }
  async function normalRun(kind, sequence) {
    const before = requests.length; const current = prepare(kind, sequence);
    await start.click(); await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
    assert.equal(requests.length, before + sequence.length); assert.equal(await page.getByTestId('final-result').innerText(), current.outputs.at(-1));
    assert.equal(await stop.count(), 0); assert.equal(await start.isEnabled(), true);
    const unknown = await page.evaluate(() => window.seohoKimLoop.cancelExecution(crypto.randomUUID()));
    assert.deepEqual(unknown, { ok: true, value: { cancelled: false } });
    assert.equal(await page.getByTestId('loop').getAttribute('data-status'), 'completed');
  }
  const autoSequence = ['openai-compatible', 'openai-compatible', 'anthropic', 'openai-compatible'];
  for (const index of [0, 1, 2, 3]) await cancelledRun('auto', autoSequence, index, { bodyHold: index === 2, connectionCheck: index === 0 });
  await normalRun('auto', autoSequence);
  await modeChoice.selectOption('single');
  for (const id of ['openai-compatible', 'anthropic']) {
    await page.locator('#provider').selectOption(id);
    await cancelledRun('single', [id], 0, { bodyHold: id === 'openai-compatible' }); await normalRun('single', [id]);
  }
  await page.locator('#provider').selectOption('mock');
  const beforeMock = requests.length;
  await start.click(); await page.locator('[data-testid="step"][data-status="running"]').waitFor(); await stop.click();
  await page.locator('[data-testid="loop"][data-status="cancelled"]').waitFor(); assert.equal(await page.getByTestId('final-result').count(), 0);
  await start.click(); await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
  assert.match(await page.getByTestId('final-result').innerText(), /Mock AI/); assert.equal(requests.length, beforeMock);
  await modeChoice.selectOption('collaboration'); await page.locator('#provider').selectOption('openai-compatible'); await page.locator('#reviewer').selectOption('anthropic');
  const manual = ['openai-compatible', 'anthropic', 'openai-compatible'];
  for (const index of [0, 1, 2]) await cancelledRun('manual', manual, index);
  await normalRun('manual', manual);
  assert.equal(aborts.length, 9); assert.equal(requests.length, 27); assert.equal(checkAborted, false);
  // Closing the real app during active work also releases the underlying HTTP connection.
  await modeChoice.selectOption('single'); await page.locator('#provider').selectOption('openai-compatible');
  const closing = prepare('app-close', ['openai-compatible'], 0); await start.click(); await deadline(closing.arrived.promise, 'Close test request missing.');
  await noSecrets(page); await desktop.close(); desktop = undefined;
  await deadline(closing.closed.promise, 'App close did not end active request.');
  assert.equal(aborts.length, 10); assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, `${mode}-smoke.json`), JSON.stringify({ status: 'passed', mode, externalApi: false,
    workRequests: requests.length, abortedConnections: aborts, checks: ['Auto planner and every step cancellation', 'both real Single adapters',
      'all Manual positions', 'Mock immediate cancellation and recovery', 'server observed actual client disconnect', 'partial-body abort',
      'normal Auto/Single/Manual recovery', 'completed output preserved', 'no final result or later calls', 'duplicate cancel',
      'navigation preserves cancellation', 'connection check unaffected', 'late response ignored', 'minimum window layout',
      'app close aborts active work', 'secret-free UI/public data/logs', 'seven restricted IPC methods'] }, null, 2));
  console.log(`PASS: ${mode} — 10 server-observed disconnects, all modes cancel and recover, connection check remains independent.`);
} catch (error) {
  const page = desktop?.windows()[0];
  if (page && !page.isClosed()) await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-failure.png`), fullPage: true }).catch(() => {});
  throw error;
} finally {
  checkResponse?.destroy(); await desktop?.close(); await vite?.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith('seohokim-cancellation-smoke-'));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
