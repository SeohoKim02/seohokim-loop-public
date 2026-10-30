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

const live = process.argv.includes('--live');
const development = process.argv.includes('--dev');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const names = ['SEOHOKIM_LOOP_OPENAI_API_KEY', 'SEOHOKIM_LOOP_OPENAI_BASE_URL', 'SEOHOKIM_LOOP_OPENAI_MODEL',
  'SEOHOKIM_LOOP_ANTHROPIC_API_KEY', 'SEOHOKIM_LOOP_ANTHROPIC_MODEL'];
if (live && names.some((name) => !environment[name]?.trim())) {
  console.log('SKIP: external collaboration requires both Provider credentials and complete environment settings.');
  process.exit(0);
}
const secrets = live ? [environment.SEOHOKIM_LOOP_OPENAI_API_KEY.trim(), environment.SEOHOKIM_LOOP_ANTHROPIC_API_KEY.trim()]
  : ['fake-collaboration-desktop-openai', 'fake-collaboration-desktop-claude'];
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'seohokim-collaboration-smoke-'));
const mode = `collaboration-${live ? 'live' : development ? 'development' : 'production'}`;
const requestText = '테스트 계획에 대한 짧은 설명을 작성해주세요.';
const errors = [];
const logs = [];
const requests = [];
let scenario;
const servers = [];
const releases = [];
let desktop;
let vite;
function prepare(sequence, { hold = false, failAt = -1, collaboration = true } = {}) {
  const arrivals = [];
  const arrived = sequence.map(() => new Promise((resolve) => arrivals.push(resolve)));
  scenario = { sequence, index: 0, hold, failAt, collaboration, arrivals, arrived, outputs: [] };
  return scenario;
}
async function localServer(id) {
  const server = createServer(async (request, response) => {
    try {
      const current = scenario;
      const index = current.index++;
      assert.equal(current.sequence[index], id);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, id === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
      assert.equal(id === 'anthropic' ? request.headers['x-api-key'] : request.headers.authorization,
        id === 'anthropic' ? secrets[1] : `Bearer ${secrets[0]}`);
      assert.equal(id === 'anthropic' ? request.headers.authorization : request.headers['x-api-key'], undefined);
      let raw = ''; for await (const chunk of request) raw += chunk;
      for (const key of secrets) assert.ok(!raw.includes(key));
      const body = JSON.parse(raw);
      assert.equal(body.stream, false); assert.equal(body.messages.length, 1);
      const content = body.messages[0].content;
      assert.ok(content.includes(requestText));
      if (current.collaboration) {
        for (const output of current.outputs) assert.ok(content.includes(output), 'Completed output must reach the next AI.');
        assert.ok(content.includes(index === 0 ? '초안 작성' : index === 1 ? '개선점만' : '검토 의견을 반영'));
      }
      requests.push({ id, index }); current.arrivals[index]();
      if (current.hold) await new Promise((resolve) => releases.push(resolve));
      if (index === current.failAt) {
        response.writeHead(401); response.end(JSON.stringify({ error: secrets.join(' ') })); return;
      }
      const output = `${id} ${current.collaboration ? ['초안', '검토 의견', '개선본'][index] : '단일 결과'} ${requests.length}`;
      current.outputs.push(output);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(id === 'anthropic'
        ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: output }] }
        : { choices: [{ message: { content: output } }] }));
    } catch {
      errors.push('Unexpected local collaboration request.'); response.writeHead(500); response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function noSecrets(page) {
  const publicData = await page.evaluate(async () => [await window.seohoKimLoop.listProviders(),
    await window.seohoKimLoop.getConfiguration('openai-compatible'), await window.seohoKimLoop.getConfiguration('anthropic')]);
  const text = JSON.stringify(publicData) + await page.locator('body').innerText() + logs.join('');
  for (const key of secrets) assert.ok(!text.includes(key), 'Secrets must not reach public data, output or logs.');
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
}

try {
  let claudeBase;
  if (!live) {
    const openaiBase = await localServer('openai-compatible'); claudeBase = await localServer('anthropic');
    Object.assign(environment, { SEOHOKIM_LOOP_OPENAI_API_KEY: secrets[0], SEOHOKIM_LOOP_OPENAI_BASE_URL: `${openaiBase}/v1`,
      SEOHOKIM_LOOP_OPENAI_MODEL: 'test-openai', SEOHOKIM_LOOP_ANTHROPIC_API_KEY: secrets[1], SEOHOKIM_LOOP_ANTHROPIC_MODEL: 'test-claude' });
  }
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  desktop = await launchDesktop({ executablePath: electronPath, args: [root, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`],
    cwd: root, env: environment, timeout: 30_000 });
  desktop.process().stdout?.on('data', (data) => logs.push(data.toString()));
  desktop.process().stderr?.on('data', (data) => logs.push(data.toString()));
  const page = await desktop.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', () => errors.push('Renderer error.'));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push('Renderer console error.'); });
  await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
  if (!live) await desktop.evaluate((_electron, base) => {
    const original = globalThis.fetch;
    globalThis.fetch = (url, init) => original(String(url) === 'https://api.anthropic.com/v1/messages' ? `${base}/v1/messages` : url, init);
  }, claudeBase);
  const preferences = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined'); assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  const modeChoice = page.getByRole('combobox', { name: '실행 방식', exact: true });
  const input = page.getByRole('textbox', { name: '새 작업' });
  const start = page.getByRole('button', { name: 'Start Loop', exact: true });
  const navigation = page.getByRole('navigation');
  const goConnections = () => navigation.getByRole('button', { name: 'Connections', exact: true }).click();
  const goLoop = () => navigation.getByRole('button', { name: 'Loop', exact: true }).click();
  const completed = () => page.locator('[data-testid="loop"][data-status="completed"]').waitFor({ timeout: live ? 190_000 : 15_000 });
  await input.fill(live ? '한 문장으로 작은 소프트웨어 테스트의 목적을 설명해주세요.' : requestText);
  assert.equal(await modeChoice.inputValue(), 'auto');
  await modeChoice.selectOption('single');
  if (!live) {
    await start.click(); await completed(); assert.match(await page.getByTestId('final-result').innerText(), /Mock AI/);
    assert.equal(requests.length, 0);
  }
  await goConnections(); assert.equal(await page.getByTestId('connection-card').count(), 5);
  assert.equal(await page.locator('[data-provider-id="codex-cli-local"]').count(), 1); await goLoop();
  await modeChoice.selectOption('collaboration');
  const primaryChoice = page.getByRole('combobox', { name: '작업 AI', exact: true });
  const reviewerChoice = page.getByRole('combobox', { name: '검토 AI', exact: true });
  assert.equal(await start.isDisabled(), true, 'Reviewer must be explicitly selected.');
  assert.ok((await page.locator('#request-help').innerText()).includes('3회'));
  for (const [primary, reviewer] of live ? [['openai-compatible', 'anthropic']] : [['openai-compatible', 'anthropic'], ['anthropic', 'openai-compatible']]) {
    await primaryChoice.selectOption(primary); await reviewerChoice.selectOption(reviewer);
    assert.equal(await reviewerChoice.locator(`option[value="${primary}"]`).isDisabled(), true);
    const before = requests.length;
    const current = live ? undefined : prepare([primary, reviewer, primary], { hold: true });
    assert.equal(requests.length, before, 'Selecting roles must not call AI.');
    // Two synchronous DOM clicks exercise the hook's guard before React disables the button.
    await start.evaluate((button) => { button.click(); button.click(); });
    if (current) {
      for (let index = 0; index < 3; index++) {
        await Promise.race([current.arrived[index], new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Step did not arrive.')), 15_000); timer.unref(); })]);
        const step = page.getByTestId('step').nth(index);
        await step.locator('[class*="text-running"]').waitFor();
        assert.equal(await step.getAttribute('data-provider-id'), index === 1 ? reviewer : primary);
        assert.equal(await step.getAttribute('data-role'), index === 1 ? 'reviewer' : 'primary');
        assert.equal(await primaryChoice.isDisabled(), true); assert.equal(await reviewerChoice.isDisabled(), true); assert.equal(await modeChoice.isDisabled(), true);
        assert.equal(requests.length, before + index + 1);
        if (index === 1) {
          await goConnections();
          for (const button of await page.getByRole('button', { name: '연결 수정', exact: true }).all()) assert.equal(await button.isDisabled(), true);
          await goLoop(); assert.equal(await reviewerChoice.inputValue(), reviewer);
          await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-${primary}-reviewing.png`), fullPage: true });
        }
        releases.shift()();
      }
    }
    await completed();
    assert.equal(await page.getByTestId('step').count(), 3);
    const result = await page.getByTestId('final-result').innerText();
    assert.ok(result.trim());
    if (current) { assert.equal(result, current.outputs[2]); assert.notEqual(result, current.outputs[1]); assert.equal(requests.length, before + 3); }
    for (let index = 0; index < 3; index++) {
      const step = page.getByTestId('step').nth(index);
      await step.getByText('단계 결과 보기', { exact: true }).click();
      if (current) assert.equal(await step.locator('.step-output').innerText(), current.outputs[index]);
      assert.ok((await step.locator('.step-time').innerText()).includes('종료'));
    }
    await goConnections(); await goLoop(); assert.equal(await page.getByTestId('final-result').innerText(), result);
    await noSecrets(page);
    if (!live) await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-${primary}-completed.png`), fullPage: true });
  }
  if (!live) {
    await primaryChoice.selectOption('openai-compatible'); await reviewerChoice.selectOption('anthropic');
    for (const failAt of [0, 1, 2]) {
      const before = requests.length; prepare(['openai-compatible', 'anthropic', 'openai-compatible'], { failAt });
      await start.click(); await page.locator('[data-testid="loop"][data-status="failed"]').waitFor();
      assert.equal(requests.length, before + failAt + 1);
      assert.equal(await page.getByTestId('final-result').count(), 0);
      assert.equal(await page.getByTestId('step').nth(failAt).getAttribute('data-status'), 'failed');
      assert.ok((await page.getByRole('alert').innerText()).includes(failAt === 1 ? 'Claude 검토' : failAt === 0 ? 'OpenAI-compatible 초안 작성' : 'OpenAI-compatible 개선'));
      await noSecrets(page);
    }
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
    await primaryChoice.scrollIntoViewIfNeeded();
    await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-minimum.png`), fullPage: false });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth
      || [...document.querySelectorAll('.card, .step-content, .provider-choice')].some((element) => element.scrollWidth > element.clientWidth + 1)), false);
    await modeChoice.selectOption('single');
    for (const id of ['openai-compatible', 'anthropic', 'mock']) {
      await page.getByRole('combobox', { name: '사용할 AI', exact: true }).selectOption(id);
      const before = requests.length;
      const current = id === 'mock' ? undefined : prepare([id], { collaboration: false });
      await start.click(); await completed();
      assert.equal(requests.length, before + (current ? 1 : 0));
      assert.equal(await page.getByTestId('step').count(), current ? 1 : 5);
      if (current) assert.equal(await page.getByTestId('final-result').innerText(), current.outputs[0]);
    }
    // Public refresh may reveal an unavailable AI; neither role may advertise it as executable.
    await desktop.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('seohokim-loop:providers:list');
      ipcMain.handle('seohokim-loop:providers:list', () => ({ ok: true, value: [
        { id: 'mock', displayName: 'Mock AI', type: 'mock', configured: true, supportsConnectionCheck: false },
        { id: 'anthropic', displayName: 'Claude', type: 'anthropic', configured: false, supportsConnectionCheck: true, unavailableReason: 'CONFIG_MISSING' },
      ] }));
    });
    await goConnections(); await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.locator('[data-provider-id="anthropic"][data-state="needs_configuration"]').waitFor();
    await goLoop(); await modeChoice.selectOption('collaboration');
    assert.equal(await primaryChoice.locator('option[value="anthropic"]').isDisabled(), true);
    assert.equal(await reviewerChoice.locator('option[value="anthropic"]').isDisabled(), true);
    assert.equal(await start.isDisabled(), true);
    assert.equal(requests.length, 14);
  }
  await noSecrets(page); assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, `${mode}-smoke.json`), JSON.stringify({ status: 'passed', mode, externalApi: live,
    localRequests: requests, checks: live ? ['one explicit three-request collaboration', 'improved final result', 'secret-free public data'] :
      ['OpenAI to Claude to OpenAI', 'Claude to OpenAI to Claude', 'exact draft/review context at both HTTP servers',
        'three visible sequential steps', 'role and time records', 'expandable outputs', 'improvement is final result',
        'duplicate Start guard', 'no requests on selection', 'navigation preserves active/completed state', 'all three failure positions',
        'single-provider regression for all three', 'unconfigured roles disabled', 'minimum window', 'credential-free context and logs'] }, null, 2));
  console.log(`PASS: ${mode} — ${live ? 'one external collaboration (3 requests)' : 'bidirectional local HTTP collaboration and single-provider regression'}.`);
} finally {
  for (const release of releases) release();
  await desktop?.close(); await vite?.close();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith('seohokim-collaboration-smoke-'));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
