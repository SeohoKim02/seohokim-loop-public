// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { launchDesktop, captureDesktop, background } from './smoke-window.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = path.join(root, 'artifacts');
const development = process.argv.includes('--dev');
const mode = `parallel-${development ? 'development' : 'production'}`;
const ids = ['openai-compatible', 'anthropic']; const keys = ['fake-parallel-openai', 'fake-parallel-claude'];
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
for (const key of ['SEOHOKIM_LOOP_OPENAI_API_KEY', 'SEOHOKIM_LOOP_OPENAI_MODEL', 'SEOHOKIM_LOOP_OPENAI_BASE_URL', 'SEOHOKIM_LOOP_ANTHROPIC_API_KEY', 'SEOHOKIM_LOOP_ANTHROPIC_MODEL']) delete environment[key];
const servers = []; const profiles = []; const checks = []; const errors = []; const logs = [];
let desktop; let vite; let scenario; let total = 0;
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
async function deadline(promise) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Parallel smoke barrier timed out.')), 8000); })]); }
  finally { clearTimeout(timer); }
}
function prepare(kind, pool) {
  const refs = kind === 'sequential' || kind === 'legacy' ? [[], [1], [2], [3]]
    : kind === 'maximum' ? [[], [], [1, 2], [3], [4]] : [[], [], [1, 2], [3]];
  const plan = { title: '두 관점 비교', steps: refs.map((dependsOn, i) => ({ title: `비교 단계 ${i + 1}`, objective: `비교 목표 ${i + 1}`,
    role: i === refs.length - 1 ? 'deliver' : 'write', usesPreviousOutputs: dependsOn.length > 0, isFinal: i === refs.length - 1,
    ...(kind === 'legacy' ? {} : { dependsOn }) })) };
  scenario = { kind, pool, plan, refs, planner: 0, attempts: refs.map(() => 0), active: new Set(), maxActive: 0,
    arrivals: refs.map(deferred), releases: refs.map(deferred), closes: refs.map(deferred), finished: new Set(), originalFailed: deferred(),
    bodies: [], aborts: 0, overlaps: 0, fallback: 0 };
  return scenario;
}
const envelope = (id, text) => JSON.stringify(id === ids[0] ? { choices: [{ message: { content: text } }] }
  : { type: 'message', role: 'assistant', content: [{ type: 'text', text }] });
async function serverFor(id) {
  const server = createServer(async (request, response) => {
    const current = scenario; let tracked = false; let step = -1;
    try {
      assert.ok(current); assert.equal(request.method, 'POST');
      assert.equal(request.url, id === ids[0] ? '/v1/chat/completions' : '/v1/messages');
      assert.equal(id === ids[0] ? request.headers.authorization : request.headers['x-api-key'], id === ids[0] ? `Bearer ${keys[0]}` : keys[1]);
      assert.equal(id === ids[0] ? request.headers['x-api-key'] : request.headers.authorization, undefined);
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); const content = body.messages[0].content; assert.equal(body.stream, false);
      assert.ok(keys.every((key) => !raw.includes(key))); assert.ok(!content.includes('private-error'));
      response.setHeader('Content-Type', 'application/json'); total++;
      if (content.includes('현재 작업: 작업 계획')) {
        current.planner++; assert.equal(id, current.pool[0]); assert.ok(current.planner <= (current.kind === 'maximum' ? 2 : 1));
        response.end(envelope(id, current.kind === 'maximum' && current.planner === 1 ? JSON.stringify({ ...current.plan, steps: current.plan.steps.map((s, i) => i === 0 ? { ...s, dependsOn: [1] } : s) }) : JSON.stringify(current.plan))); return;
      }
      step = current.plan.steps.findIndex((s) => content.includes(`현재 작업: ${s.title}`)); assert.ok(step >= 0);
      const attempt = ++current.attempts[step]; assert.ok(attempt <= 3);
      assert.ok(!current.active.has(id), 'No same-provider HTTP overlap'); current.active.add(id); tracked = true;
      current.maxActive = Math.max(current.maxActive, current.active.size); assert.ok(current.active.size <= 2);
      if (current.active.size === 2) current.overlaps++;
      const cleanup = () => { if (tracked) { tracked = false; current.active.delete(id); } };
      response.on('finish', cleanup);
      response.on('close', () => { cleanup(); if (!response.writableEnded) { current.aborts++; current.closes[step].resolve(); } });
      const fallback = step === 0 && attempt === 3;
      assert.equal(id, fallback ? current.pool[1] : current.pool[step % current.pool.length]);
      if (fallback) current.fallback++;
      for (const ref of current.refs[step]) assert.ok(current.finished.has(ref - 1), 'Dependency started too early');
      const expectedRefs = current.kind === 'legacy' ? Array.from({ length: step }, (_, i) => i + 1) : current.refs[step];
      let last = -1;
      for (let i = 0; i < current.plan.steps.length; i++) {
        const at = content.indexOf(`결과-${i + 1}`);
        if (expectedRefs.includes(i + 1)) { assert.ok(at > last, 'Context must follow plan order'); last = at; }
        else assert.equal(at, -1, 'Unrelated output leaked into context');
      }
      if (attempt === 1) current.bodies[step] = content; else assert.equal(content, current.bodies[step]);
      current.arrivals[step].resolve();
      if (['recovery', 'maximum'].includes(current.kind) && step === 0 && attempt <= 2) {
        response.writeHead(503); response.end(JSON.stringify({ error: `private-error ${keys.join(' ')}` }));
        if (attempt === 2) current.originalFailed.resolve(); return;
      }
      const hold = ['normal', 'cancel', 'failure'].includes(current.kind) && step < 2
        || ['sequential', 'legacy', 'single'].includes(current.kind) && step === 0
        || ['recovery', 'maximum'].includes(current.kind) && step === 1;
      if (hold) await current.releases[step].promise;
      if (response.destroyed) return;
      if (current.kind === 'failure' && step === 0) { response.writeHead(401); response.end(JSON.stringify({ error: 'private-error' })); return; }
      current.finished.add(step); response.end(envelope(id, `결과-${step + 1}`));
    } catch {
      errors.push(`Unexpected local parallel request at step ${step + 1}.`);
      if (tracked) current.active.delete(id);
      if (!response.headersSent) response.writeHead(500); response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function launch(pool, bases) {
  const profile = await mkdtemp(path.join(tmpdir(), 'seohokim-parallel-smoke-')); profiles.push(profile);
  const env = { ...environment };
  if (pool.includes(ids[0])) Object.assign(env, { SEOHOKIM_LOOP_OPENAI_API_KEY: keys[0], SEOHOKIM_LOOP_OPENAI_MODEL: 'test-openai', SEOHOKIM_LOOP_OPENAI_BASE_URL: `${bases[0]}/v1` });
  if (pool.includes(ids[1])) Object.assign(env, { SEOHOKIM_LOOP_ANTHROPIC_API_KEY: keys[1], SEOHOKIM_LOOP_ANTHROPIC_MODEL: 'test-claude' });
  desktop = await launchDesktop({ executablePath: electronPath, args: [root, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`], cwd: root, env, timeout: 30000 });
  desktop.process().stdout?.on('data', (d) => logs.push(d.toString())); desktop.process().stderr?.on('data', (d) => logs.push(d.toString()));
  const page = await desktop.firstWindow(); page.on('pageerror', () => errors.push('Renderer error'));
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
  await desktop.evaluate((_electron, base) => { const fetch = globalThis.fetch; globalThis.fetch = (url, init) => fetch(String(url) === 'https://api.anthropic.com/v1/messages' ? `${base}/v1/messages` : url, init); }, bases[1]);
  const prefs = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.sandbox, true);
  assert.equal(await page.locator('#execution-mode').inputValue(), 'auto');
  await page.locator('#request').fill('서로 다른 두 관점을 비교해주세요.'); return page;
}
try {
  await mkdir(artifacts, { recursive: true }); const bases = [await serverFor(ids[0]), await serverFor(ids[1])];
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  for (const pool of [ids, [ids[0]], [ids[1]]]) {
    const page = await launch(pool, bases);
    for (const kind of pool.length === 2 ? ['normal', 'sequential', 'legacy', 'cancel', 'failure', 'recovery', 'maximum', 'normal'] : ['single']) {
      const current = prepare(kind, pool); const before = total;
      await page.getByRole('button', { name: 'Start Loop', exact: true }).evaluate((button) => { button.click(); button.click(); });
      await deadline(current.arrivals[0].promise);
      if (['normal', 'cancel', 'failure'].includes(kind)) {
        await deadline(current.arrivals[1].promise); assert.equal(current.active.size, 2); assert.ok(current.overlaps > 0);
        assert.deepEqual(current.attempts, [1, 1, 0, 0]);
        assert.equal(await page.locator('[data-testid="step"][data-status="running"]').count(), 2);
        assert.equal(await page.getByTestId('step').nth(2).getAttribute('data-status'), 'pending');
        assert.equal(await page.getByTestId('final-result').count(), 0);
        await page.getByRole('navigation').getByRole('button', { name: 'Connections', exact: true }).click();
        for (const button of await page.getByRole('button', { name: /연결 수정|연결 설정/, exact: true }).all()) assert.equal(await button.isDisabled(), true);
        await page.getByRole('navigation').getByRole('button', { name: 'Loop', exact: true }).click();
        assert.equal(await page.locator('[data-testid="step"][data-status="running"]').count(), 2);
        await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
        await page.getByTestId('loop').scrollIntoViewIfNeeded();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth
          || [...document.querySelectorAll('.card, .step-content')].some((el) => el.scrollWidth > el.clientWidth + 1)), false);
        await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-${kind}.png`), fullPage: true });
        if (kind === 'cancel') {
          await page.getByRole('button', { name: '작업 중지', exact: true }).click(); await deadline(Promise.all(current.closes.slice(0, 2).map((d) => d.promise)));
        } else if (kind === 'failure') { current.releases[0].resolve(); await deadline(current.closes[1].promise); }
        else {
          current.releases[1].resolve(); await page.locator('[data-testid="step"][data-status="completed"]').waitFor();
          assert.equal(current.attempts[2], 0); current.releases[0].resolve();
        }
      } else if (['recovery', 'maximum'].includes(kind)) {
        await deadline(current.arrivals[1].promise); await deadline(current.originalFailed.promise);
        assert.equal(current.fallback, 0); assert.equal(current.active.has(ids[1]), true); current.releases[1].resolve();
      } else { assert.deepEqual(current.attempts, [1, 0, 0, 0]); current.releases[0].resolve(); }
      const status = kind === 'cancel' ? 'cancelled' : kind === 'failure' ? 'failed' : 'completed';
      await page.locator(`[data-testid="loop"][data-status="${status}"]`).waitFor();
      for (const gate of current.releases) gate.resolve();
      if (status === 'completed') {
        assert.equal(await page.getByTestId('final-result').innerText(), `결과-${current.plan.steps.length}`);
        assert.ok(current.attempts.every((n, i) => n === (['recovery', 'maximum'].includes(kind) && i === 0 ? 3 : 1)));
      } else { assert.equal(await page.getByTestId('final-result').count(), 0); assert.deepEqual(current.attempts, [1, 1, 0, 0]); }
      assert.equal(current.aborts, kind === 'cancel' ? 2 : kind === 'failure' ? 1 : 0);
      assert.equal(current.active.size, 0); assert.ok(current.maxActive <= 2);
      if (pool.length === 1 || ['sequential', 'legacy'].includes(kind)) assert.equal(current.maxActive, 1);
      if (kind === 'maximum') assert.equal(total - before, 9); else assert.ok(total - before <= 7);
      const publicText = JSON.stringify(await page.evaluate(() => window.seohoKimLoop.listProviders())) + await page.locator('body').innerText() + logs.join('');
      for (const secret of [...keys, 'private-error']) assert.ok(!publicText.includes(secret));
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      if (background) assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
      checks.push({ kind, pool, status, requests: total - before, maximumConcurrentRequests: current.maxActive, overlaps: current.overlaps, httpAborts: current.aborts });
    }
    await desktop.close(); desktop = undefined;
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, `${mode}-smoke.json`), JSON.stringify({ status: 'passed', background, externalApi: false, requests: total, checks }, null, 2));
  console.log(`PASS: ${mode}; ${total} local requests; observed overlap, ordered dependencies, both HTTP aborts, failed sibling cleanup, shared recovery, max-nine, single-provider serialization.`);
} finally {
  for (const gate of scenario?.releases ?? []) gate.resolve(); await desktop?.close(); await vite?.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  for (const profile of profiles) {
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith('seohokim-parallel-smoke-'));
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}
