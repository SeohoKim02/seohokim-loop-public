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
import { TaskPlanner } from '../src/application/task-planner.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';

const development = process.argv.includes('--dev');
const live = process.argv.includes('--live');
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = path.join(root, 'artifacts');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const names = ['SEOHOKIM_LOOP_OPENAI_API_KEY', 'SEOHOKIM_LOOP_OPENAI_BASE_URL', 'SEOHOKIM_LOOP_OPENAI_MODEL',
  'SEOHOKIM_LOOP_ANTHROPIC_API_KEY', 'SEOHOKIM_LOOP_ANTHROPIC_MODEL'];
const liveIds = [];
if (names.slice(0, 3).every((name) => environment[name]?.trim())) liveIds.push('openai-compatible');
if (names.slice(3).every((name) => environment[name]?.trim())) liveIds.push('anthropic');
if (live && !liveIds.length) {
  console.log('SKIP: Auto external planner smoke requires one fully configured Provider in environment. No external requests.');
  process.exit(0);
}
const secrets = live ? [environment[names[0]], environment[names[3]]].filter(Boolean)
  : ['fake-auto-desktop-openai', 'fake-auto-desktop-claude'];
const mode = `auto-${live ? 'live-planner' : development ? 'development' : 'production'}`;
const requestText = '두 가지 일정 관리 방법을 비교해서 짧은 안내를 만들어주세요.';
const errors = []; const logs = []; const requests = []; const servers = []; const profiles = []; const releases = [];
const diagnostics = [];
function diagnose(kind, detail) {
  // Detailed diagnostics are local-fixture-only. Never record paid responses or real credentials.
  if (live) return;
  let safe = JSON.stringify(detail);
  for (const value of [...secrets, 'private-malformed-plan', requestText]) safe = safe.split(value).join('[REDACTED]');
  diagnostics.push({ kind, requestCount: requests.length, phase: scenario?.index, detail: safe.slice(0, 8000) });
}
let desktop; let vite; let scenario;
const dynamicPlan = (count) => ({ title: '일정 관리 안내', steps: Array.from({ length: count }, (_, index) => ({
  title: ['방법별 특징 정리', '내용의 균형 검토', '실용적인 안내 작성', '선택 기준 정리', '최종 안내'][index],
  role: index === count - 1 ? 'deliver' : index === 1 ? 'review' : 'write',
  objective: `일정 관리의 목표 ${index + 1}`, usesPreviousOutputs: index > 0, isFinal: index === count - 1,
})) });
function prepare(ids, { count = 3, hold = false, failAt = -1, malformed = false, recovery } = {}) {
  recovery ??= malformed ? 'failure' : undefined;
  const plannerCalls = recovery ? 2 : 1;
  const sequence = [...Array(plannerCalls).fill(ids[0]), ...Array.from({ length: count }, (_, i) => ids[i % ids.length])];
  const arrivals = []; const arrived = sequence.map(() => new Promise((resolve) => arrivals.push(resolve)));
  let closed; const aborted = new Promise((resolve) => { closed = resolve; });
  scenario = { sequence, plan: dynamicPlan(count), plannerCalls, recovery, hold, failAt, arrivals, arrived, index: 0, outputs: [], closed, aborted };
  return scenario;
}
async function serverFor(id) {
  const server = createServer(async (request, response) => {
    try {
      const current = scenario; assert.ok(current);
      const index = current.index++;
      assert.equal(id, current.sequence[index]); assert.equal(request.method, 'POST');
      assert.equal(request.url, id === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
      assert.equal(id === 'anthropic' ? request.headers['x-api-key'] : request.headers.authorization,
        id === 'anthropic' ? secrets[1] : `Bearer ${secrets[0]}`);
      let raw = ''; for await (const chunk of request) raw += chunk;
      for (const secret of secrets) assert.ok(!raw.includes(secret));
      const body = JSON.parse(raw); assert.equal(body.stream, false); assert.equal(body.messages.length, 1);
      const content = body.messages[0].content; assert.ok(content.includes(requestText));
      if (index === 0) { assert.ok(content.includes('작업 계획 준비')); assert.ok(content.includes('usesPreviousOutputs')); }
      else if (index < current.plannerCalls) {
        assert.ok(content.includes('작업 계획 수정')); assert.ok(content.includes('검증 오류'));
        assert.ok(content.includes('신뢰되지 않은 데이터')); assert.ok(content.includes('untrustedPreviousPlan'));
        assert.ok(content.includes('private-malformed-plan'));
      } else {
        assert.ok(content.includes(current.plan.steps[index - current.plannerCalls].objective));
        for (const output of current.outputs) assert.ok(content.includes(output));
        assert.ok(!content.includes('"usesPreviousOutputs"'), 'Raw planner JSON is not step context.');
      }
      requests.push({ id, phase: index === 0 ? 'planning' : index < current.plannerCalls ? 'recovery' : 'step', index }); current.arrivals[index]();
      response.on('close', () => { if (!response.writableEnded) current.closed(); });
      if (current.hold) await new Promise((resolve) => releases.push(resolve));
      if (response.destroyed) return;
      if (index === current.failAt) { response.writeHead(401); response.end(JSON.stringify({ error: secrets.join(' ') })); return; }
      const output = index < current.plannerCalls ? current.recovery && (index === 0 || current.recovery === 'failure') ? 'private-malformed-plan' : JSON.stringify(current.plan)
        : `${id} 단계 ${index} 결과 ${requests.length}`;
      if (index >= current.plannerCalls) current.outputs.push(output);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(id === 'anthropic' ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: output }] }
        : { choices: [{ message: { content: output } }] }));
    } catch { errors.push('Unexpected local Auto request.'); response.writeHead(500); response.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function noSecrets(page) {
  const publicData = await page.evaluate(async () => [await window.seohoKimLoop.listProviders(),
    await window.seohoKimLoop.getConfiguration('openai-compatible'), await window.seohoKimLoop.getConfiguration('anthropic')]);
  const text = JSON.stringify(publicData) + await page.locator('body').innerText() + logs.join('');
  for (const secret of secrets) assert.ok(!text.includes(secret));
  assert.ok(!text.includes('private-malformed-plan'));
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
}
async function launch(ids, bases) {
  const profile = await mkdtemp(path.join(tmpdir(), 'seohokim-auto-smoke-')); profiles.push(profile);
  const env = { ...environment };
  if (!live) {
    for (const name of names) delete env[name];
    if (ids.includes('openai-compatible')) Object.assign(env, { [names[0]]: secrets[0], [names[1]]: `${bases[0]}/v1`, [names[2]]: 'test-openai' });
    if (ids.includes('anthropic')) Object.assign(env, { [names[3]]: secrets[1], [names[4]]: 'test-claude' });
  }
  desktop = await launchDesktop({ executablePath: electronPath, args: [root, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`],
    cwd: root, env, timeout: 30_000 });
  desktop.process().stdout?.on('data', (data) => logs.push(data.toString()));
  desktop.process().stderr?.on('data', (data) => logs.push(data.toString()));
  const page = await desktop.firstWindow();
  page.on('pageerror', (error) => { errors.push('Renderer error.'); diagnose('pageerror', { message: error.message, stack: error.stack }); });
  page.on('console', (entry) => { if (entry.type() === 'error') {
    errors.push('Renderer console error.'); diagnose('console', { message: entry.text(), location: entry.location() });
  } });
  if (!live) {
    const session = await page.context().newCDPSession(page);
    await session.send('Runtime.enable');
    session.on('Runtime.consoleAPICalled', (event) => {
      if (event.type === 'error') diagnose('console-stack', { stack: event.stackTrace });
    });
    page.on('requestfailed', (request) => diagnose('requestfailed', { url: request.url(), failure: request.failure() }));
    page.on('response', (response) => { if (response.status() >= 400) diagnose('renderer-http', { url: response.url(), status: response.status() }); });
    page.on('crash', () => diagnose('renderer-crash', {}));
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
  if (!live) await desktop.evaluate((_electron, base) => {
    const original = globalThis.fetch;
    globalThis.fetch = (url, init) => original(String(url) === 'https://api.anthropic.com/v1/messages' ? `${base}/v1/messages` : url, init);
  }, bases[1]);
  const preferences = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined'); assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  assert.deepEqual(await page.evaluate(() => Object.keys(window.seohoKimLoop).sort()),
    ['cancelExecution', 'deleteHistory', 'executeProvider', 'exportMarkdown', 'getConfiguration', 'getHistory', 'listHistory', 'listProviders', 'removeConfiguration', 'saveConfiguration', 'saveHistory', 'selectOllamaModel', 'selectTextFiles', 'testConnection']);
  assert.equal(await page.locator('#execution-mode').inputValue(), 'auto');
  assert.equal(await page.locator('#provider, #reviewer').count(), 0);
  await page.getByRole('textbox', { name: '새 작업' }).fill(requestText);
  return page;
}
const arrival = (promise) => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error('Auto request did not arrive.')), 15000); timer.unref();
})]);

try {
  await mkdir(artifacts, { recursive: true });
  const bases = live ? [] : [await serverFor('openai-compatible'), await serverFor('anthropic')];
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  if (live) {
    const page = await launch(liveIds, bases);
    const summary = await page.evaluate(() => window.seohoKimLoop.listProviders());
    assert.ok(summary.ok);
    const connection = summary.value.find((p) => p.type !== 'mock' && p.configured); assert.ok(connection);
    let calls = 0;
    // Guard before IPC: this optional external smoke never spends on recovery.
    const bridge = { executeProvider: async (input) => {
      if (calls >= 1) throw new Error('External smoke is limited to one request.');
      calls++; return page.evaluate((value) => window.seohoKimLoop.executeProvider(value), input);
    } };
    const parsed = await new TaskPlanner(new IpcProvider(connection, bridge)).plan('두 문장짜리 인사말 작성을 위한 2단계 계획만 만들어주세요.');
    assert.equal(calls, 1); assert.ok(parsed.steps.length >= 2 && parsed.steps.length <= 5);
    await noSecrets(page);
    await writeFile(path.join(artifacts, `${mode}-smoke.json`), JSON.stringify({ status: 'passed', mode, externalCalls: 1,
      fullAuto: false, checks: ['one planner request through actual Electron IPC', 'structured plan validated', 'no raw plan logged'] }, null, 2));
    console.log('PASS: external Auto planner only — one request; full paid Auto deliberately not executed.');
  } else {
    for (const ids of [['openai-compatible', 'anthropic'], ['openai-compatible'], ['anthropic']]) {
      const beforeLaunch = requests.length;
      const page = await launch(ids, bases);
      const navigation = page.getByRole('navigation');
      const goConnections = () => navigation.getByRole('button', { name: 'Connections', exact: true }).click();
      const goLoop = () => navigation.getByRole('button', { name: 'Loop', exact: true }).click();
      await goConnections(); await page.getByRole('button', { name: '새로고침', exact: true }).click(); await goLoop();
      await page.locator('#execution-mode').selectOption('single'); await page.locator('#execution-mode').selectOption('auto');
      assert.equal(requests.length, beforeLaunch, 'Startup, navigation, refresh and mode changes spend nothing.');
      const current = prepare(ids, { count: ids.length === 2 ? 5 : 2, hold: true });
      const start = page.getByRole('button', { name: 'Start Loop', exact: true });
      await start.evaluate((button) => { button.click(); button.click(); });
      for (let index = 0; index < current.sequence.length; index++) {
        await arrival(current.arrived[index]);
        assert.equal(requests.length, beforeLaunch + index + 1);
        assert.equal(await page.locator('#execution-mode').isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: 'Loop 진행 중', exact: true }).isDisabled(), true);
        assert.equal(await page.getByTestId('final-result').count(), 0);
        if (index === 0) {
          assert.match(await page.getByTestId('auto-plan').innerText(), /작업 계획 준비/);
          assert.equal(await page.getByTestId('step').count(), 0);
          await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-${ids.length}-${ids[0]}-planning.png`), fullPage: true });
        } else {
          const step = page.getByTestId('step').nth(index - 1);
          await step.locator('.text-running').waitFor();
          assert.equal(await step.getAttribute('data-provider-id'), current.sequence[index]);
          assert.equal(await step.getAttribute('data-role'), current.plan.steps[index - 1].role);
          assert.equal(await step.locator('h3').innerText(), current.plan.steps[index - 1].title);
          assert.equal(await page.getByTestId('step').count(), current.plan.steps.length);
        }
        if (index <= 1) {
          await goConnections();
          for (const button of await page.getByRole('button', { name: /연결 수정|연결 설정/, exact: true }).all()) assert.equal(await button.isDisabled(), true);
          await goLoop(); assert.equal(await page.locator('#execution-mode').inputValue(), 'auto');
        }
        releases.shift()();
      }
      await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
      assert.equal(await page.getByTestId('final-result').innerText(), current.outputs.at(-1));
      for (const [index, step] of (await page.getByTestId('step').all()).entries()) {
        await step.getByText('단계 결과 보기', { exact: true }).click();
        assert.equal(await step.locator('.step-output').innerText(), current.outputs[index]);
        assert.ok((await step.locator('.step-time').innerText()).includes('종료'));
      }
      await goConnections(); await goLoop(); assert.equal(await page.getByTestId('final-result').innerText(), current.outputs.at(-1));
      await noSecrets(page);
      await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-${ids.length}-${ids[0]}-completed.png`), fullPage: true });
      if (ids.length === 2) {
        await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
        await page.getByTestId('auto-plan').scrollIntoViewIfNeeded();
        const layout = await page.evaluate(() => {
          const elements = [...document.querySelectorAll('.work-grid > .card')];
          const rects = elements.map((el) => el.getBoundingClientRect());
          return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
            || [...document.querySelectorAll('.card, .step-content, .provider-choice')].some((el) => el.scrollWidth > el.clientWidth + 1),
          overlap: rects.some((a, i) => rects.slice(i + 1).some((b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)) };
        });
        assert.deepEqual(layout, { overflow: false, overlap: false });
        await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-minimum.png`), fullPage: false });
        for (const options of [{ failAt: 0 }, { malformed: true }, { failAt: 1 }, { failAt: 2 }, { failAt: 3 }]) {
          const before = requests.length; prepare(ids, options);
          await start.click(); await page.locator('[data-testid="loop"][data-status="failed"]').waitFor();
          assert.equal(requests.length, before + (options.malformed ? 2 : (options.failAt ?? 0) + 1));
          assert.equal(await page.getByTestId('final-result').count(), 0);
          if ((options.failAt ?? 0) === 0) {
            assert.equal(await page.getByTestId('step').count(), 0); assert.match(await page.getByRole('alert').innerText(), /작업 계획을 만들지 못했습니다/);
          } else {
            assert.equal(await page.getByTestId('step').nth(options.failAt - 1).getAttribute('data-status'), 'failed');
            assert.equal(await page.locator('[data-testid="step"][data-status="pending"]').count(), 3 - options.failAt);
          }
          await noSecrets(page);
        }
        await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-failed.png`), fullPage: true });
      }
      // Recovery uses the same planner through the real preload/main/HTTP path.
      for (const recovery of ['success', 'failure', 'cancel']) {
        const before = requests.length;
        const repair = prepare(ids, { count: 2, recovery, hold: true });
        await start.evaluate((button) => { button.click(); button.click(); });
        await arrival(repair.arrived[0]); releases.shift()();
        await arrival(repair.arrived[1]);
        assert.match(await page.getByTestId('auto-plan').innerText(), /작업 계획을 다시 정리하고 있습니다/);
        assert.equal(await page.getByTestId('step').count(), 0);
        assert.equal(await page.getByTestId('final-result').count(), 0);
        assert.equal(await page.locator('#execution-mode').isDisabled(), true);
        await goConnections(); await goLoop();
        await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
        await page.getByTestId('auto-plan').scrollIntoViewIfNeeded();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth
          || [...document.querySelectorAll('.card, .execution-actions button')].some((el) => el.scrollWidth > el.clientWidth + 1)), false);
        await noSecrets(page);
        if (ids.length === 2) await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-recovery-${recovery}.png`), fullPage: true });
        if (recovery === 'cancel') {
          await page.getByRole('button', { name: '작업 중지', exact: true }).click();
          await page.locator('[data-testid="loop"][data-status="cancelled"]').waitFor({ timeout: 5000 });
          await arrival(repair.aborted); // Real server observes client HTTP abort.
          releases.shift()(); // Late valid reply cannot revive the cancelled Loop.
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(await page.getByTestId('loop').getAttribute('data-status'), 'cancelled');
          assert.equal(await page.getByRole('alert').count(), 0);
        } else {
          releases.shift()();
          if (recovery === 'success') {
            for (let index = 2; index < 4; index++) {
              await arrival(repair.arrived[index]);
              const step = page.getByTestId('step').nth(index - 2);
              await step.locator('.text-running').waitFor();
              assert.equal(await step.getAttribute('data-provider-id'), repair.sequence[index]);
              releases.shift()();
            }
            await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
            assert.equal(await page.getByTestId('final-result').innerText(), repair.outputs.at(-1));
          } else {
            await page.locator('[data-testid="loop"][data-status="failed"]').waitFor();
            assert.match(await page.getByRole('alert').innerText(), /작업 계획을 만들지 못했습니다/);
          }
        }
        assert.equal(requests.length - before, recovery === 'success' ? 4 : 2);
        assert.deepEqual(requests.slice(before, before + 2).map((r) => r.id), [ids[0], ids[0]]);
        if (recovery !== 'success') {
          assert.equal(await page.getByTestId('step').count(), 0); assert.equal(await page.getByTestId('final-result').count(), 0);
        }
        await noSecrets(page);
      }
      const beforeFresh = requests.length; const fresh = prepare(ids, { count: 2 });
      await start.click(); await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
      assert.equal(requests.length - beforeFresh, 3); assert.equal(await page.getByTestId('final-result').innerText(), fresh.outputs.at(-1));
      await desktop.close(); desktop = undefined;
    }
    assert.equal(requests.length, 57); assert.deepEqual(errors, []);
    await writeFile(path.join(artifacts, `${mode}-smoke.json`), JSON.stringify({ status: 'passed', mode, externalApi: false,
      localRequests: requests, checks: ['Auto default with hidden provider controls', 'planning visible', 'dynamic 2/5-step plans',
        'real Electron IPC and two local HTTP adapters', 'OpenAI+Claude', 'OpenAI alone', 'Claude alone', 'bounded call count',
        'duplicate Start guard during planning/execution', 'exact objectives and output context', 'role/provider/time records',
        'validated final result', 'planner HTTP/parse failure', 'all three step failures stop', 'state preserved across navigation',
        'same-provider repair success and double-invalid failure', 'recovery UI at minimum window', 'three real recovery HTTP aborts',
        'no work after repair failure/cancel', 'late reply ignored and fresh Auto succeeds', 'first valid plan spends one planner call',
        'no background requests', 'minimum window without overlap', 'restricted preload with scoped cancellation', 'no secrets in context/UI/logs'] }, null, 2));
    console.log(`PASS: ${mode} — Auto regressions and recovery success/failure/cancel for both adapters (57 local HTTP requests; 3 recovery aborts).`);
  }
} catch (error) {
  const page = desktop?.windows()[0];
  if (page && !page.isClosed()) await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-failure.png`), fullPage: true }).catch(() => {});
  // Live failures must not echo generated text or a credential-bearing assertion value.
  if (live) throw new Error('External Auto planner smoke failed; check the configured connection.');
  throw error;
} finally {
  if (!live) await writeFile(path.join(artifacts, `${mode}-diagnostics.json`), JSON.stringify({ errors, diagnostics }, null, 2));
  for (const release of releases) release();
  await desktop?.close(); await vite?.close();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  for (const profile of profiles) {
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith('seohokim-auto-smoke-'));
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}
