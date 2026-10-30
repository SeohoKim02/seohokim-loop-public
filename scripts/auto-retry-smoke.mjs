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
const mode = `auto-retry-${development ? 'development' : 'production'}`;
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
for (const name of ['SEOHOKIM_LOOP_OPENAI_API_KEY', 'SEOHOKIM_LOOP_OPENAI_BASE_URL', 'SEOHOKIM_LOOP_OPENAI_MODEL',
  'SEOHOKIM_LOOP_ANTHROPIC_API_KEY', 'SEOHOKIM_LOOP_ANTHROPIC_MODEL']) delete environment[name];
const secrets = ['fake-retry-desktop-openai', 'fake-retry-desktop-claude'];
const requestText = '두 방법을 비교하는 간단한 안내를 작성해주세요.';
const errors = []; const logs = []; const requests = []; const profiles = []; const servers = []; const checks = [];
let desktop; let vite; let scenario; let aborts = 0;
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
async function deadline(promise) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Retry smoke deadline exceeded.')), 5000); })]); }
  finally { clearTimeout(timer); }
}
function prepare(kind, ids) {
  const count = kind === 'maximum' ? 5 : 3;
  const plan = { title: '비교 안내', steps: Array.from({ length: count }, (_, i) => ({ title: `비교 단계 ${i + 1}`,
    objective: `비교 목표 ${i + 1}`, role: i === count - 1 ? 'deliver' : 'write', usesPreviousOutputs: i > 0, isFinal: i === count - 1 })) };
  scenario = { kind, ids, plan, planner: 0, attempts: Array(count).fill(0), bodies: [],
    arrived: deferred(), aborted: deferred(), release: deferred(), failedAt: undefined, retriedAt: undefined };
  return scenario;
}
const envelope = (id, output) => JSON.stringify(id === 'anthropic'
  ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: output }] }
  : { choices: [{ message: { content: output } }] });
async function serverFor(id) {
  const server = createServer(async (request, response) => {
    try {
      const current = scenario; assert.ok(current);
      assert.equal(request.method, 'POST'); assert.equal(request.url, id === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
      assert.equal(id === 'anthropic' ? request.headers['x-api-key'] : request.headers.authorization,
        id === 'anthropic' ? secrets[1] : `Bearer ${secrets[0]}`);
      let raw = ''; for await (const chunk of request) raw += chunk;
      assert.ok(secrets.every((s) => !raw.includes(s)));
      const body = JSON.parse(raw); const content = body.messages[0].content;
      assert.ok(content.includes(requestText)); assert.equal(body.stream, false);
      response.setHeader('Content-Type', 'application/json');
      if (content.includes('현재 작업: 작업 계획')) {
        current.planner++; assert.equal(id, current.ids[0]);
        assert.ok(current.planner <= (current.kind === 'maximum' ? 2 : 1));
        requests.push({ kind: current.kind, id, phase: 'planner' });
        response.end(envelope(id, current.kind === 'maximum' && current.planner === 1 ? 'private-invalid-plan' : JSON.stringify(current.plan))); return;
      }
      const step = current.plan.steps.findIndex((s) => content.includes(`현재 작업: ${s.title}`)); assert.ok(step >= 0);
      const attempt = ++current.attempts[step];
      const fallback = current.ids.length === 2 && ((current.kind === 'failure' && step === 1 && attempt === 3)
        || (current.kind === 'budget' && step === 2 && attempt === 2));
      const assigned = current.ids[step % current.ids.length];
      assert.equal(id, fallback ? current.ids.find((candidate) => candidate !== assigned) : assigned);
      assert.ok(attempt <= (fallback ? 3 : 2));
      assert.ok(content.includes(current.plan.steps[step].objective));
      for (let previous = 0; previous < step; previous++) assert.ok(content.includes(`완료 결과 ${previous + 1}`));
      assert.ok(!content.includes('private-error-body') && !content.includes('private-invalid-plan'));
      if (attempt === 1) current.bodies[step] = raw;
      else if (fallback) assert.equal(content, JSON.parse(current.bodies[step]).messages[0].content);
      else assert.equal(raw, current.bodies[step]);
      requests.push({ kind: current.kind, id, phase: 'step', step, attempt });
      const transient = ['success', 'failure', 'budget', 'maximum'].includes(current.kind) && step === 1
        && (attempt === 1 || current.kind === 'failure');
      const stopTransient = ['wait-cancel', 'http-cancel'].includes(current.kind) && step === 0 && attempt === 1;
      if (transient || stopTransient || (current.kind === 'budget' && step === 2)) {
        current.failedAt = Date.now(); response.writeHead(503); response.end(JSON.stringify({ error: `private-error-body ${secrets.join(' ')}` })); return;
      }
      if (['auth', 'quota'].includes(current.kind) && step === 0) {
        response.writeHead(current.kind === 'auth' ? 401 : 429, { 'Retry-After': '999999' });
        response.end(JSON.stringify({ error: { code: 'insufficient_quota', message: secrets.join(' ') } })); return;
      }
      if (attempt === 2) {
        current.retriedAt = Date.now(); assert.ok(current.retriedAt - current.failedAt >= 900, 'Retry must wait, not spin.');
        response.on('close', () => { if (!response.writableEnded) { aborts++; current.aborted.resolve(); } });
        current.arrived.resolve();
        if (['success', 'http-cancel'].includes(current.kind)) await current.release.promise;
        if (response.destroyed) return;
      }
      response.end(envelope(id, `완료 결과 ${step + 1}`));
    } catch {
      errors.push('Unexpected local step retry request.'); if (!response.headersSent) response.writeHead(500); response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function noSecrets(page) {
  const publicData = await page.evaluate(async () => [await window.seohoKimLoop.listProviders(),
    await window.seohoKimLoop.getConfiguration('openai-compatible'), await window.seohoKimLoop.getConfiguration('anthropic')]);
  const text = JSON.stringify(publicData) + await page.locator('body').innerText() + logs.join('');
  for (const forbidden of [...secrets, 'private-error-body', 'private-invalid-plan', 'insufficient_quota']) assert.ok(!text.includes(forbidden));
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
}
async function launch(ids, bases) {
  const profile = await mkdtemp(path.join(tmpdir(), 'seohokim-retry-smoke-')); profiles.push(profile);
  const env = { ...environment };
  if (ids.includes('anthropic')) Object.assign(env, { SEOHOKIM_LOOP_ANTHROPIC_API_KEY: secrets[1], SEOHOKIM_LOOP_ANTHROPIC_MODEL: 'test-claude' });
  if (ids.includes('openai-compatible')) Object.assign(env, { SEOHOKIM_LOOP_OPENAI_API_KEY: secrets[0], SEOHOKIM_LOOP_OPENAI_BASE_URL: `${bases[0]}/v1`, SEOHOKIM_LOOP_OPENAI_MODEL: 'test-openai' });
  desktop = await launchDesktop({ executablePath: electronPath, args: [root, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`], cwd: root, env, timeout: 30000 });
  desktop.process().stdout?.on('data', (d) => logs.push(d.toString())); desktop.process().stderr?.on('data', (d) => logs.push(d.toString()));
  const page = await desktop.firstWindow(); page.on('pageerror', () => errors.push('Renderer error.'));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push('Renderer console error.'); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
  await desktop.evaluate((_electron, base) => { const original = globalThis.fetch;
    globalThis.fetch = (url, init) => original(String(url) === 'https://api.anthropic.com/v1/messages' ? `${base}/v1/messages` : url, init);
  }, bases[1]);
  const prefs = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.sandbox, true);
  assert.deepEqual(await page.evaluate(() => Object.keys(window.seohoKimLoop).sort()), ['cancelExecution', 'deleteHistory', 'executeProvider', 'exportMarkdown', 'getConfiguration', 'getHistory', 'listHistory', 'listProviders', 'removeConfiguration', 'saveConfiguration', 'saveHistory', 'selectOllamaModel', 'selectTextFiles', 'testConnection']);
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined'); assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.locator('#execution-mode').inputValue(), 'auto'); await page.locator('#request').fill(requestText);
  return page;
}
try {
  await mkdir(artifacts, { recursive: true }); const bases = [await serverFor('openai-compatible'), await serverFor('anthropic')];
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  for (const ids of [['openai-compatible', 'anthropic'], ['openai-compatible'], ['anthropic']]) {
    const page = await launch(ids, bases); const start = page.getByRole('button', { name: 'Start Loop', exact: true });
    const stop = page.getByRole('button', { name: '작업 중지', exact: true });
    for (const kind of ['normal', 'success', 'failure', 'wait-cancel', 'http-cancel', 'auth', 'quota', 'budget', 'maximum', 'normal']) {
      const before = requests.length; const current = prepare(kind, ids);
      await start.evaluate((button) => { button.click(); button.click(); });
      if (kind === 'wait-cancel') {
        await page.locator('[data-testid="step"][data-retry-pending="true"]').waitFor();
        await stop.click(); await page.locator('[data-testid="loop"][data-status="cancelled"]').waitFor();
        assert.deepEqual(current.attempts, [1, 0, 0]);
      } else if (['success', 'http-cancel'].includes(kind)) {
        await deadline(current.arrived.promise); await page.getByTestId('step-retry').waitFor();
        assert.equal(await page.locator('#execution-mode').isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: 'Loop 진행 중', exact: true }).isDisabled(), true);
        assert.equal(await page.getByTestId('final-result').count(), 0);
        const active = page.locator('[data-testid="step"][data-status="running"]'); assert.equal(await active.getAttribute('data-retry-count'), '1');
        await page.getByRole('navigation').getByRole('button', { name: 'Connections', exact: true }).click();
        for (const button of await page.getByRole('button', { name: /연결 수정|연결 설정/, exact: true }).all()) assert.equal(await button.isDisabled(), true);
        await page.getByRole('navigation').getByRole('button', { name: 'Loop', exact: true }).click();
        await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
        await page.getByTestId('step-retry').scrollIntoViewIfNeeded();
        const layout = await page.evaluate(() => {
          const rects = [...document.querySelectorAll('.work-grid > .card')].map((e) => e.getBoundingClientRect());
          return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
            || [...document.querySelectorAll('.card, .step-content, .execution-actions button')].some((e) => e.scrollWidth > e.clientWidth + 1),
          overlap: rects.some((a, i) => rects.slice(i + 1).some((b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)) };
        }); assert.deepEqual(layout, { overflow: false, overlap: false });
        await noSecrets(page); await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-${ids.join('-')}-${kind}.png`), fullPage: true });
        if (kind === 'http-cancel') {
          await stop.click(); await page.locator('[data-testid="loop"][data-status="cancelled"]').waitFor(); await deadline(current.aborted.promise);
          current.release.resolve(); await new Promise((resolve) => setImmediate(resolve));
          assert.equal(await page.getByTestId('loop').getAttribute('data-status'), 'cancelled');
        } else current.release.resolve();
      }
      const expected = ['wait-cancel', 'http-cancel'].includes(kind) ? 'cancelled'
        : ['failure', 'auth', 'quota', 'budget'].includes(kind) ? 'failed' : 'completed';
      await page.locator(`[data-testid="loop"][data-status="${expected}"]`).waitFor();
      const expectedAttempts = { normal: [1, 1, 1], success: [1, 2, 1], failure: [1, ids.length === 2 ? 3 : 2, 0], 'wait-cancel': [1, 0, 0],
        'http-cancel': [2, 0, 0], auth: [1, 0, 0], quota: [1, 0, 0], budget: [1, 2, ids.length === 2 ? 2 : 1], maximum: [1, 2, 1, 1, 1] }[kind];
      assert.deepEqual(current.attempts, expectedAttempts); assert.equal(current.planner, kind === 'maximum' ? 2 : 1);
      assert.equal(requests.length - before, current.planner + expectedAttempts.reduce((a, b) => a + b, 0));
      assert.ok(requests.length - before <= 8);
      const retryIndex = kind === 'http-cancel' ? 0 : ['success', 'failure', 'budget', 'maximum'].includes(kind) ? 1 : -1;
      assert.deepEqual(await page.getByTestId('step').evaluateAll((els) => els.map((e) => Number(e.dataset.retryCount))), expectedAttempts.map((_, i) => Number(i === retryIndex)));
      if (expected === 'completed') assert.equal(await page.getByTestId('final-result').innerText(), `완료 결과 ${current.plan.steps.length}`);
      else assert.equal(await page.getByTestId('final-result').count(), 0);
      if (expected === 'failed') assert.match(await page.getByRole('alert').innerText(), /작업을 완료하지 못했습니다/);
      if (expected === 'cancelled') assert.equal(await page.getByRole('alert').count(), 0);
      assert.equal(await start.isEnabled(), true); await noSecrets(page);
      checks.push({ providers: ids, scenario: kind, status: expected, plannerCalls: current.planner, stepAttempts: current.attempts });
    }
    await desktop.close(); desktop = undefined;
  }
  assert.equal(aborts, 3); assert.equal(requests.length, 119); assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, `${mode}-smoke.json`), JSON.stringify({ status: 'passed', mode, externalApi: false,
    localRequests: requests.length, serverObservedRetryAborts: aborts, checks }, null, 2));
  console.log(`PASS: ${mode} — ${requests.length} local requests; success/failure/budget/cancel/auth/quota/max-eight, ${aborts} server-observed retry aborts.`);
} finally {
  scenario?.release.resolve(); await desktop?.close(); await vite?.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  for (const profile of profiles) {
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith('seohokim-retry-smoke-'));
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}
