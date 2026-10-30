// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { launchDesktop, captureDesktop, background } from './smoke-window.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'seohokim-loop-smoke-'));
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
// This default smoke is always offline, even in a configured developer shell.
for (const key of ['SEOHOKIM_LOOP_OPENAI_API_KEY', 'SEOHOKIM_LOOP_OPENAI_BASE_URL', 'SEOHOKIM_LOOP_OPENAI_MODEL', 'SEOHOKIM_LOOP_ANTHROPIC_API_KEY', 'SEOHOKIM_LOOP_ANTHROPIC_MODEL']) delete environment[key];
const development = process.argv.includes('--dev');
const mode = development ? 'development' : 'production';
const server = development ? await (await import('vite')).createServer() : undefined;
await server?.listen();
const desktop = await launchDesktop({
  executablePath: electronPath,
  args: [root, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`],
  cwd: root,
  env: environment,
  timeout: 30_000,
}).catch(async (error) => {
  await server?.close();
  throw error;
});
const errors = [];
const consoleErrors = [];
const processLog = [];
desktop.process().stderr?.on('data', (data) => processLog.push(data.toString()));
desktop.process().stdout?.on('data', (data) => processLog.push(data.toString()));

try {
  const page = await desktop.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('crash', () => errors.push('Renderer process crashed.'));
  const heading = page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' });
  await heading.waitFor();
  // Reload after attaching listeners so initial render errors are also checked.
  await page.reload();
  await heading.waitFor();
  if (!background) await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window.isVisible()) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Desktop window did not become visible.')), 5_000);
        window.once('show', () => { clearTimeout(timer); resolve(); });
      });
    }
  });
  const preferences = await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { visible: window.isVisible(), ...window.webContents.getLastWebPreferences() };
  });
  assert.equal(preferences.visible, !background, 'The real desktop window must be visible.');
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  assert.deepEqual(await page.evaluate(() => Object.keys(window.seohoKimLoop).sort()), ['cancelExecution', 'deleteHistory', 'executeProvider', 'exportMarkdown', 'getConfiguration', 'getHistory', 'listHistory', 'listProviders', 'removeConfiguration', 'saveConfiguration', 'saveHistory', 'selectOllamaModel', 'selectTextFiles', 'testConnection']);
  const connections = await page.evaluate(() => window.seohoKimLoop.listProviders());
  assert.equal(connections.ok, true);
  assert.equal(connections.value.find((provider) => provider.id === 'openai-compatible').configured, false);
  assert.equal(await page.locator('#execution-mode').inputValue(), 'auto');
  assert.equal(await page.locator('#provider').count(), 0);
  await page.getByRole('textbox', { name: '새 작업' }).fill('자동 실행 확인');
  assert.equal(await page.getByRole('button', { name: 'Start Loop', exact: true }).isDisabled(), true);
  assert.match(await page.locator('#request-help').innerText(), /먼저 사용할 AI를 연결해주세요/);
  await page.getByRole('button', { name: 'AI 연결하기', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Loop', exact: true }).click();
  await page.getByRole('textbox', { name: '새 작업' }).fill('');
  await page.locator('#execution-mode').selectOption('single');
  const providerChoice = page.getByRole('combobox', { name: '사용할 AI' });
  await providerChoice.locator('option[value="mock"]').waitFor({ state: 'attached' });
  assert.equal(await providerChoice.inputValue(), 'mock');
  assert.equal(await providerChoice.locator('option[value="openai-compatible"]').isDisabled(), true);

  const input = page.getByRole('textbox', { name: '새 작업' });
  const start = page.getByRole('button', { name: 'Start Loop', exact: true });
  assert.equal(await start.isDisabled(), true);
  await input.fill('   \n\t');
  assert.equal(await start.isDisabled(), true, 'Whitespace requests must be disabled.');
  assert.equal(await page.getByTestId('loop').count(), 0);
  await input.fill('전기차 시장을 조사해서 간단한 보고서를 만들어줘.');
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-01-ready.png`), fullPage: true });

  await page.evaluate(() => {
    window.__loopSmokeEvents = [];
    const observer = new MutationObserver(() => {
      const loop = document.querySelector('[data-testid="loop"]');
      if (loop) window.__loopSmokeEvents.push({
        status: loop.getAttribute('data-status'),
        steps: [...document.querySelectorAll('[data-testid="step"]')].map((step) => step.getAttribute('data-status')),
      });
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status'] });
  });

  await start.click();
  await page.locator('[data-testid="loop"][data-status="running"]').waitFor();
  assert.equal(await input.isDisabled(), true);
  assert.equal(await providerChoice.isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Loop 진행 중' }).isDisabled(), true);
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-02-running.png`), fullPage: true });
  await page.locator('[data-testid="loop"][data-status="completed"]').waitFor({ timeout: 15_000 });
  const result = await page.getByTestId('final-result').innerText();
  assert.match(result, /전기차 시장/);
  assert.match(result, /Mock AI/);
  assert.equal(await page.locator('[data-testid="step"][data-status="completed"]').count(), 5);
  assert.equal(await input.isEnabled(), true);

  const transitions = await page.evaluate(() => window.__loopSmokeEvents);
  for (let step = 0; step < 5; step += 1) {
    assert.ok(transitions.some((event) => event.steps[step] === 'running'), `Step ${step + 1} must visibly run.`);
    assert.ok(transitions.some((event) => event.steps[step] === 'completed'), `Step ${step + 1} must complete.`);
  }
  for (const event of transitions) {
    assert.ok(event.steps.filter((status) => status === 'running').length <= 1);
  }
  await page.getByText('단계 결과 보기', { exact: true }).first().click();
  assert.equal(await page.locator('details[open]').count(), 1);
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-03-completed.png`), fullPage: true });

  const navigation = page.getByRole('navigation', { name: '주 메뉴' });
  const loopNavigation = navigation.getByRole('button', { name: 'Loop', exact: true });
  const connectionsNavigation = navigation.getByRole('button', { name: 'Connections', exact: true });
  await connectionsNavigation.click();
  await page.getByRole('heading', { name: 'AI 연결', exact: true }).waitFor();
  assert.equal(await connectionsNavigation.getAttribute('aria-current'), 'page');
  const mockCard = page.getByRole('article', { name: 'Mock AI', exact: true });
  const externalCard = page.getByRole('article', { name: 'OpenAI-compatible', exact: true });
  assert.match(await mockCard.innerText(), /테스트용 AI/);
  assert.match(await mockCard.innerText(), /사용 가능/);
  assert.equal(await mockCard.getAttribute('data-state'), 'ready');
  assert.match(await externalCard.innerText(), /설정 필요/);
  assert.match(await externalCard.innerText(), /AI 연결 설정이 필요합니다/);
  assert.match(await externalCard.innerText(), /앱을 다시 시작해야 반영/);
  assert.equal(await externalCard.getAttribute('data-state'), 'needs_configuration');
  assert.equal(await mockCard.getByRole('button', { name: '연결 확인', exact: true }).count(), 0);
  assert.equal(await externalCard.getByRole('button', { name: '연결 확인', exact: true }).isDisabled(), true);
  assert.equal(await externalCard.locator('[data-check-status]').getAttribute('data-check-status'), 'not_checked');
  const unconfiguredCheck = await page.evaluate(() => window.seohoKimLoop.testConnection('openai-compatible'));
  assert.equal(unconfiguredCheck.ok, false);
  assert.equal(unconfiguredCheck.code, 'configuration_required');
  assert.equal(await page.locator('input:visible, textarea:visible').count(), 0, 'Connections must have no credential input.');
  assert.doesNotMatch(await externalCard.innerText(), /Authorization|CONFIG_MISSING|IPC|Registry|Adapter/);
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.getByRole('button', { name: '새로고침', exact: true }).waitFor();
  const refreshedConnections = await page.evaluate(() => window.seohoKimLoop.listProviders());
  assert.equal(refreshedConnections.ok, true);
  // Local metadata checks update their timestamp on each refresh.
  for (const item of refreshedConnections.value) if (item.ollama) {
    assert.ok(Date.parse(item.ollama.checkedAt) >= Date.parse(connections.value.find((old) => old.id === item.id).ollama.checkedAt));
    item.ollama.checkedAt = connections.value.find((old) => old.id === item.id).ollama.checkedAt;
  }
  assert.deepEqual(refreshedConnections, connections);
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-05-connections.png`), fullPage: true });
  await loopNavigation.click();
  assert.equal(await loopNavigation.getAttribute('aria-current'), 'page');
  assert.equal(await input.inputValue(), '전기차 시장을 조사해서 간단한 보고서를 만들어줘.');
  assert.equal(await page.getByTestId('final-result').innerText(), result, 'Navigation must preserve the Loop result.');

  // Exercise the supported minimum window, long text, and a second request.
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
  const longRequest = `긴 요청 표시 확인 ${'아주긴텍스트'.repeat(45)}\n여러 줄의 요청도 확인합니다.`;
  await input.fill(longRequest);
  await start.click();
  await page.locator('[data-testid="loop"][data-status="running"]').waitFor();
  assert.equal(await page.getByTestId('final-result').count(), 0, 'The previous result must be cleared.');
  await connectionsNavigation.click();
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.getByRole('button', { name: '새로고침', exact: true }).waitFor();
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-06-connections-minimum.png`), fullPage: true });
  const connectionsLayout = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="connection-card"]')];
    const rectangles = cards.map((card) => card.getBoundingClientRect());
    return {
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      overflowing: cards.some((card) => card.scrollWidth > card.clientWidth + 1),
      overlap: rectangles.some((a, index) => rectangles.slice(index + 1).some((b) =>
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)),
    };
  });
  assert.deepEqual(connectionsLayout, { horizontalOverflow: false, overflowing: false, overlap: false });
  await loopNavigation.click();
  await page.locator('[data-testid="loop"][data-status="completed"]').waitFor({ timeout: 15_000 });
  assert.ok((await page.getByTestId('final-result').innerText()).includes(longRequest));
  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    contentWidth: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('.card, .step-content, .request-preview, .final-output')]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.className),
  }));
  assert.ok(layout.contentWidth <= layout.width, 'The desktop must not overflow horizontally.');
  assert.deepEqual(layout.overflowing, []);
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-04-minimum-window.png`), fullPage: true });

  // Exercise both a failed IPC reply and a rejected invocation without adding app test APIs.
  for (const failure of ['reply', 'rejection']) {
    await desktop.evaluate(({ ipcMain }, mode) => {
      ipcMain.removeHandler('seohokim-loop:providers:list');
      ipcMain.handle('seohokim-loop:providers:list', () => {
        if (mode === 'rejection') throw new Error('connection-smoke-private-detail');
        return { ok: false, error: { code: 'EXECUTION_FAILED', message: 'connection-smoke-private-detail' } };
      });
    }, failure);
    await connectionsNavigation.click();
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'AI 연결 상태를 불러오지 못했습니다.' }).waitFor();
    assert.equal(await page.getByTestId('connection-card').count(), 0, 'A failed lookup must not leave stale ready cards.');
    assert.ok(!(await page.locator('body').innerText()).includes('connection-smoke-private-detail'));
    await loopNavigation.click();
    assert.equal(await start.isDisabled(), true);
    assert.equal(await providerChoice.isDisabled(), true);
    assert.ok((await page.getByTestId('final-result').innerText()).includes(longRequest));
    await desktop.evaluate(({ ipcMain }, summary) => {
      ipcMain.removeHandler('seohokim-loop:providers:list');
      ipcMain.handle('seohokim-loop:providers:list', () => summary);
    }, connections);
    await connectionsNavigation.click();
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await mockCard.waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    await loopNavigation.click();
    assert.equal(await start.isEnabled(), true);
  }
  assert.deepEqual(errors, [], 'Renderer runtime errors must be absent.');
  assert.deepEqual(consoleErrors, [], 'Renderer console errors must be absent.');

  const report = {
    mode,
    platform: process.platform,
    processId: desktop.process().pid,
    checks: [background ? 'hidden Electron window' : 'visible Electron window', 'renderer isolation', 'limited preload bridge', 'Auto default without implicit Mock', 'Single Mock and unconfigured provider disabled', 'empty input rejection', 'task entry', 'Start Loop', 'five sequential steps through IPC', 'final result', 'step output', 'second Loop', 'minimum window and long text', 'Connections cards and missing configuration', 'Mock has no check button', 'unconfigured check disabled and safely rejected by main', 'shared connection refresh', 'navigation preserves input and results', 'navigation during execution', 'Connections minimum window', 'safe lookup failure and recovery'],
    transitions,
    layout,
    connectionsLayout,
    errors,
    consoleErrors,
  };
  await writeFile(path.join(artifacts, `${mode}-smoke.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PASS: ${mode} desktop smoke — ${report.checks.join(', ')}`);
} catch (error) {
  const page = desktop.windows()[0];
  if (page && !page.isClosed()) await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-failure.png`), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await desktop.close();
  await server?.close();
  await writeFile(path.join(artifacts, `${mode}-process.log`), processLog.join(''));
}
