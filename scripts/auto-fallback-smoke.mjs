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
const background = process.argv.includes('--background');
const mode = `auto-fallback-${development ? 'development' : 'production'}`;
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
for (const name of ['SEOHOKIM_LOOP_OPENAI_API_KEY', 'SEOHOKIM_LOOP_OPENAI_BASE_URL', 'SEOHOKIM_LOOP_OPENAI_MODEL',
  'SEOHOKIM_LOOP_ANTHROPIC_API_KEY', 'SEOHOKIM_LOOP_ANTHROPIC_MODEL']) delete environment[name];
const ids = ['openai-compatible', 'anthropic'];
const keys = ['fake-fallback-desktop-openai', 'fake-fallback-desktop-claude'];
const requestText = '두 방법을 비교하는 간단한 안내를 작성해주세요.';
const errors = []; const logs = []; const requests = []; const profiles = []; const servers = []; const checks = [];
let desktop; let vite; let scenario; let aborts = 0;
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
async function deadline(promise) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fallback smoke deadline exceeded.')), 8000); })]); }
  finally { clearTimeout(timer); }
}
function prepare(kind) {
  const count = kind === 'maximum' ? 5 : 3;
  const plan = { title: '비교 안내', steps: Array.from({ length: count }, (_, i) => ({ title: `비교 단계 ${i + 1}`,
    objective: `비교 목표 ${i + 1}`, role: i === count - 1 ? 'deliver' : kind === 'forward' && i === 1 ? 'review' : 'write',
    usesPreviousOutputs: i > 0, isFinal: i === count - 1 })) };
  scenario = { kind, plan, target: kind === 'reverse' ? 1 : kind === 'final' ? 2 : 0,
    planner: 0, attempts: Array(count).fill(0), bodies: [], arrived: deferred(), aborted: deferred(), release: deferred() };
  return scenario;
}
const envelope = (id, output) => JSON.stringify(id === ids[1]
  ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: output }] }
  : { choices: [{ message: { content: output } }] });
async function serverFor(id) {
  const server = createServer(async (request, response) => {
    try {
      const current = scenario; assert.ok(current);
      assert.equal(request.method, 'POST'); assert.equal(request.url, id === ids[1] ? '/v1/messages' : '/v1/chat/completions');
      assert.equal(id === ids[1] ? request.headers['x-api-key'] : request.headers.authorization,
        id === ids[1] ? keys[1] : `Bearer ${keys[0]}`);
      assert.equal(id === ids[1] ? request.headers.authorization : request.headers['x-api-key'], undefined);
      let raw = ''; for await (const chunk of request) raw += chunk;
      assert.ok(keys.every((s) => !raw.includes(s)));
      const body = JSON.parse(raw); const content = body.messages[0].content;
      assert.ok(content.includes(requestText)); assert.equal(body.stream, false);
      response.setHeader('Content-Type', 'application/json');
      if (content.includes('현재 작업: 작업 계획')) {
        current.planner++; assert.equal(id, ids[0]);
        assert.ok(current.planner <= (current.kind === 'maximum' ? 2 : 1));
        requests.push({ kind: current.kind, id, phase: 'planner' });
        response.end(envelope(id, current.kind === 'maximum' && current.planner === 1 ? 'private-invalid-plan' : JSON.stringify(current.plan))); return;
      }
      const step = current.plan.steps.findIndex((s) => content.includes(`현재 작업: ${s.title}`)); assert.ok(step >= 0);
      const attempt = ++current.attempts[step]; assert.ok(attempt <= 3);
      const fallback = current.kind === 'spent-retry' ? step === 1 && attempt === 2 : step === current.target && attempt === 3;
      const original = ids[step % 2];
      const expectedId = fallback ? ids.find((candidate) => candidate !== original)
        : current.kind === 'forward' && step === 1 ? ids[0] : original;
      assert.equal(id, expectedId);
      assert.ok(content.includes(current.plan.steps[step].objective));
      for (let previous = 0; previous < step; previous++) assert.ok(content.includes(`완료 결과 ${previous + 1}`));
      assert.ok(!content.includes('private-error-body') && !content.includes('private-invalid-plan'));
      if (attempt === 1) current.bodies[step] = content; else assert.equal(content, current.bodies[step]);
      requests.push({ kind: current.kind, id, phase: 'step', step, attempt, fallback });
      const temporary = current.kind === 'spent-retry' ? (step === 0 || step === 1) && attempt === 1
        : current.kind !== 'normal' && current.kind !== 'auth' && step === current.target && attempt <= 2;
      if (temporary || current.kind === 'spent-fallback' && step === 1 || current.kind === 'failure' && fallback) {
        response.writeHead(current.kind === 'forward' ? 502 : current.kind === 'maximum' ? 504 : 503);
        response.end(JSON.stringify({ error: `private-error-body ${keys.join(' ')}` })); return;
      }
      if (current.kind === 'auth' && step === 0) {
        response.writeHead(401); response.end(JSON.stringify({ error: keys.join(' ') })); return;
      }
      if (fallback && ['forward', 'reverse', 'final', 'cancel'].includes(current.kind)) {
        response.on('close', () => { if (!response.writableEnded) { aborts++; current.aborted.resolve(); } });
        current.arrived.resolve(); await current.release.promise;
        if (response.destroyed) return;
      }
      response.end(envelope(id, `완료 결과 ${step + 1}`));
    } catch {
      errors.push('Unexpected local fallback request.'); if (!response.headersSent) response.writeHead(500); response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function noSecrets(page) {
  const publicData = await page.evaluate(async () => [await window.seohoKimLoop.listProviders(),
    await window.seohoKimLoop.getConfiguration('openai-compatible'), await window.seohoKimLoop.getConfiguration('anthropic')]);
  const text = JSON.stringify(publicData) + await page.locator('body').innerText() + logs.join('');
  for (const forbidden of [...keys, 'private-error-body', 'private-invalid-plan']) assert.ok(!text.includes(forbidden));
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
}
async function launch(both, bases) {
  const profile = await mkdtemp(path.join(tmpdir(), 'seohokim-fallback-smoke-')); profiles.push(profile);
  const env = { ...environment, SEOHOKIM_LOOP_OPENAI_API_KEY: keys[0], SEOHOKIM_LOOP_OPENAI_BASE_URL: `${bases[0]}/v1`, SEOHOKIM_LOOP_OPENAI_MODEL: 'test-openai' };
  if (both) Object.assign(env, { SEOHOKIM_LOOP_ANTHROPIC_API_KEY: keys[1], SEOHOKIM_LOOP_ANTHROPIC_MODEL: 'test-claude' });
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
  if (background) assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert.deepEqual(await page.evaluate(() => Object.keys(window.seohoKimLoop).sort()), ['cancelExecution', 'deleteHistory', 'executeProvider', 'exportMarkdown', 'getConfiguration', 'getHistory', 'listHistory', 'listProviders', 'removeConfiguration', 'saveConfiguration', 'saveHistory', 'selectOllamaModel', 'selectTextFiles', 'testConnection']);
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined'); assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await page.locator('#request').fill(requestText); return page;
}
try {
  await mkdir(artifacts, { recursive: true }); const bases = [await serverFor(ids[0]), await serverFor(ids[1])];
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  for (const kinds of [['normal', 'forward', 'reverse', 'final', 'failure', 'cancel', 'spent-retry', 'spent-fallback', 'auth', 'maximum', 'normal'], ['removed'], ['no-candidate']]) {
    const page = await launch(kinds.length > 1, bases);
    if (kinds[0] === 'removed') {
      assert.equal((await page.evaluate((apiKey) => window.seohoKimLoop.saveConfiguration({ providerId: 'anthropic', model: 'test-claude', apiKey }), keys[1])).ok, true);
      // Reload public connection summaries before planning; remove later while retry waits.
      await page.reload(); await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
      await page.locator('#request').fill(requestText);
    }
    const start = page.getByRole('button', { name: 'Start Loop', exact: true }); const stop = page.getByRole('button', { name: '작업 중지', exact: true });
    for (const kind of kinds) {
      const before = requests.length; const current = prepare(kind);
      await start.evaluate((button) => { button.click(); button.click(); });
      if (kind === 'removed') {
        await page.locator('[data-testid="step"][data-retry-pending="true"]').waitFor();
        assert.equal((await page.evaluate(() => window.seohoKimLoop.removeConfiguration('anthropic'))).ok, true);
      }
      if (['forward', 'reverse', 'final', 'cancel'].includes(kind)) {
        await deadline(current.arrived.promise); await page.getByTestId('step-fallback').waitFor();
        const active = page.locator('[data-testid="step"][data-status="running"]');
        assert.equal(await active.getAttribute('data-fallback-count'), '1'); assert.equal(await active.getAttribute('data-retry-count'), '1');
        assert.equal(await active.getAttribute('data-provider-id'), ids.find((id) => id !== ids[current.target % 2]));
        assert.match(await active.getByTestId('provider-change').innerText(), /에서 .+로 변경됨/);
        assert.equal(await page.getByTestId('final-result').count(), 0); assert.equal(await page.locator('#execution-mode').isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: 'Loop 진행 중', exact: true }).isDisabled(), true);
        await page.getByRole('navigation').getByRole('button', { name: 'Connections', exact: true }).click();
        for (const button of await page.getByRole('button', { name: /연결 수정|연결 설정/, exact: true }).all()) assert.equal(await button.isDisabled(), true);
        await page.getByRole('navigation').getByRole('button', { name: 'Loop', exact: true }).click();
        await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
        await page.getByTestId('step-fallback').scrollIntoViewIfNeeded();
        const layout = await page.evaluate(() => {
          const rects = [...document.querySelectorAll('.work-grid > .card')].map((e) => e.getBoundingClientRect());
          return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
            || [...document.querySelectorAll('.card, .step-content, .execution-actions button')].some((e) => e.scrollWidth > e.clientWidth + 1),
          overlap: rects.some((a, i) => rects.slice(i + 1).some((b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)) };
        }); assert.deepEqual(layout, { overflow: false, overlap: false });
        await noSecrets(page);
        await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-${kind}.png`), fullPage: true });
        if (kind === 'cancel') {
          await stop.click(); await page.locator('[data-testid="loop"][data-status="cancelled"]').waitFor(); await deadline(current.aborted.promise);
          current.release.resolve(); await new Promise((resolve) => setImmediate(resolve));
          assert.equal(await page.getByTestId('loop').getAttribute('data-status'), 'cancelled');
        } else current.release.resolve();
      }
      const expected = kind === 'cancel' ? 'cancelled' : ['failure', 'spent-fallback', 'auth', 'removed', 'no-candidate'].includes(kind) ? 'failed' : 'completed';
      await page.locator(`[data-testid="loop"][data-status="${expected}"]`).waitFor();
      const attempts = { normal: [1, 1, 1], forward: [3, 1, 1], reverse: [1, 3, 1], final: [1, 1, 3], failure: [3, 0, 0], cancel: [3, 0, 0],
        'spent-retry': [2, 2, 1], 'spent-fallback': [3, 1, 0], auth: [1, 0, 0], maximum: [3, 1, 1, 1, 1], removed: [2, 0, 0], 'no-candidate': [2, 0, 0] }[kind];
      assert.deepEqual(current.attempts, attempts); assert.equal(current.planner, kind === 'maximum' ? 2 : 1);
      assert.equal(requests.length - before, current.planner + attempts.reduce((a, b) => a + b, 0)); assert.ok(requests.length - before <= 9);
      const fallbackIndex = ['normal', 'auth', 'removed', 'no-candidate'].includes(kind) ? -1 : kind === 'spent-retry' ? 1 : current.target;
      assert.deepEqual(await page.getByTestId('step').evaluateAll((els) => els.map((e) => Number(e.dataset.fallbackCount))), attempts.map((_, i) => Number(i === fallbackIndex)));
      if (expected === 'completed') assert.equal(await page.getByTestId('final-result').innerText(), `완료 결과 ${current.plan.steps.length}`);
      else assert.equal(await page.getByTestId('final-result').count(), 0);
      if (kind === 'forward') assert.equal(await page.getByTestId('step').nth(1).getAttribute('data-provider-id'), ids[0]);
      if (kind === 'final') assert.match(await page.locator('.demo-tag').innerText(), /Claude/);
      if (['removed', 'no-candidate'].includes(kind)) assert.match(await page.getByRole('alert').innerText(), /다른 사용 가능한 AI가 없어/);
      assert.equal(await start.isEnabled(), true); await noSecrets(page);
      if (background) assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
      checks.push({ scenario: kind, status: expected, plannerCalls: current.planner, stepAttempts: current.attempts });
    }
    await desktop.close(); desktop = undefined;
  }
  assert.equal(aborts, 1); assert.equal(requests.length, 62); assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, `${mode}-smoke.json`), JSON.stringify({ status: 'passed', mode, background, externalApi: false,
    localRequests: requests.length, serverObservedFallbackAborts: aborts, checks }, null, 2));
  console.log(`PASS: ${mode} — ${requests.length} local requests; bidirectional/final/review/budgets/cancel/auth/removed/max-nine, ${aborts} server-observed fallback abort.`);
} finally {
  scenario?.release.resolve(); await desktop?.close(); await vite?.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  for (const profile of profiles) {
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith('seohokim-fallback-smoke-'));
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}
