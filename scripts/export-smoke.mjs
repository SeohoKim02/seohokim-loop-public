// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { launchDesktop } from './smoke-window.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = path.join(root, 'artifacts');
const development = process.argv.includes('--dev');
const mode = development ? 'development' : 'production';
const directory = await mkdtemp(path.join(tmpdir(), 'seohokim-export-smoke-'));
const profile = path.join(directory, 'profile');
const exports = path.join(directory, 'exports');
await mkdir(exports); await mkdir(profile); await mkdir(artifacts, { recursive: true });
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
for (const name of Object.keys(environment)) if (name.startsWith('SEOHOKIM_LOOP_')) delete environment[name];
const secret = 'fake-export-smoke-key';
const original = '  # 한국어 English 😀\r\n\r\n|항목|값|\n|---|---|\n|원문|<>&|\n\n```js\nconsole.log("한글");\n```\n<script>window.exportExecuted=true</script>\n![외부 그림](https://example.test/no-download.png)\n  ';
let calls = 0; let fail = false;
const errors = []; const logs = [];
const api = createServer(async (request, response) => {
  try {
    calls++;
    assert.equal(request.method, 'POST');
    assert.ok(['/v1/messages', '/v1/chat/completions'].includes(request.url));
    assert.equal(request.url === '/v1/messages' ? request.headers['x-api-key'] : request.headers.authorization,
      request.url === '/v1/messages' ? secret : `Bearer ${secret}`);
    let raw = ''; for await (const chunk of request) raw += chunk;
    assert.ok(!raw.includes(secret));
    if (fail) { response.writeHead(401); response.end('{}'); return; }
    const planning = JSON.parse(raw).messages[0].content.includes('작업 계획 준비');
    const output = planning ? JSON.stringify({ title: '저장 검증', steps: [
      { title: '분석 A', role: 'analyze', objective: '주요 내용', usesPreviousOutputs: false, dependsOn: [], isFinal: false },
      { title: '작성 B', role: 'write', objective: '독립 초안', usesPreviousOutputs: false, dependsOn: [], isFinal: false },
      { title: '최종 정리', role: 'deliver', objective: '두 결과 통합', usesPreviousOutputs: true, dependsOn: [1, 2], isFinal: true },
    ] }) : original;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/v1/messages'
      ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: output }] }
      : { choices: [{ message: { content: output } }] }));
  } catch { errors.push('Unexpected local export request'); response.writeHead(500); response.end('{}'); }
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${api.address().port}`;
Object.assign(environment, { SEOHOKIM_LOOP_OPENAI_API_KEY: secret, SEOHOKIM_LOOP_OPENAI_BASE_URL: `${base}/v1`,
  SEOHOKIM_LOOP_OPENAI_MODEL: 'test-openai', SEOHOKIM_LOOP_ANTHROPIC_API_KEY: secret, SEOHOKIM_LOOP_ANTHROPIC_MODEL: 'test-claude' });
let desktop; let vite;
const checks = [];
try {
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  desktop = await launchDesktop({ executablePath: electronPath, args: [root, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`],
    cwd: root, env: environment, timeout: 30_000 });
  desktop.process().stdout?.on('data', (data) => logs.push(data.toString()));
  desktop.process().stderr?.on('data', (data) => logs.push(data.toString()));
  const page = await desktop.firstWindow();
  page.on('pageerror', () => errors.push('Renderer error'));
  page.on('console', (message) => { if (message.type() === 'error') errors.push('Renderer console error'); });
  page.on('request', (request) => { if (!request.url().startsWith('file:') && !request.url().startsWith('http://127.0.0.1:')) errors.push('Unexpected renderer request'); });
  await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
  await desktop.evaluate(({ dialog, BrowserWindow }, base) => {
    const fetch = globalThis.fetch;
    globalThis.fetch = (url, init) => fetch(String(url) === 'https://api.anthropic.com/v1/messages' ? `${base}/v1/messages` : url, init);
    // Test-only replacement of the native dialog, not the export handler or file writer.
    // The real OS dialog is intentionally not opened over the user's other work.
    globalThis.exportChoices = []; globalThis.exportDialogs = [];
    dialog.showSaveDialog = async (owner, options) => {
      globalThis.exportDialogs.push({ options, correctOwner: owner === BrowserWindow.getAllWindows()[0] });
      const choice = globalThis.exportChoices.shift();
      if (!choice) throw new Error('No scripted save selection');
      if (choice.hold) await new Promise((resolve) => { globalThis.releaseExport = resolve; });
      if (choice.throw) throw new Error('private-dialog-key stack');
      return { canceled: choice.canceled ?? false, filePath: choice.filePath ?? '' };
    };
  }, base);
  const choose = (choice) => desktop.evaluate((_electron, choice) => { globalThis.exportChoices.push(choice); }, choice);
  const dialogCount = () => desktop.evaluate(() => globalThis.exportDialogs.length);
  // Read the actual common Loop prop through React's DOM fiber, without adding product test APIs.
  const snapshot = () => page.evaluate(() => {
    const node = document.querySelector('.work-grid');
    let fiber = node[Object.keys(node).find((key) => key.startsWith('__reactFiber$'))];
    while (fiber.return) fiber = fiber.return;
    const pending = [fiber.stateNode.current];
    while (pending.length) {
      const current = pending.pop();
      if (current.memoizedProps?.loop) return JSON.parse(JSON.stringify(current.memoizedProps.loop));
      if (current.child) pending.push(current.child);
      if (current.sibling) pending.push(current.sibling);
    }
    throw new Error('Loop snapshot unavailable');
  });
  const saveButton = () => page.getByRole('button', { name: 'Markdown 저장', exact: true });
  const modeChoice = page.locator('#execution-mode');
  const start = () => page.getByRole('button', { name: 'Start Loop', exact: true }).click();
  const completed = () => page.locator('[data-testid="loop"][data-status="completed"]').waitFor({ timeout: 15_000 });
  const save = async (name) => {
    const before = await snapshot(); const requestCount = calls; const filePath = path.join(exports, name);
    await choose({ filePath }); await saveButton().click();
    await page.getByText('파일이 저장되었습니다.', { exact: true }).waitFor();
    assert.deepEqual(await readFile(filePath), Buffer.from(before.finalResult, 'utf8'));
    assert.deepEqual(await snapshot(), before); assert.equal(calls, requestCount);
    return filePath;
  };
  await modeChoice.selectOption('single');
  await page.locator('#request').fill('최종 결과 저장 확인');
  await start();
  await page.locator('[data-testid="loop"][data-status="running"]').waitFor();
  assert.equal(await saveButton().count(), 0);
  await completed();
  const mockFile = await save('Single Mock 결과.md');
  assert.equal(calls, 0);
  checks.push('Single Mock exact UTF-8 file, zero AI calls');

  const before = await snapshot(); const filesBeforeCancel = await readdir(exports);
  await choose({ canceled: true, filePath: mockFile }); await saveButton().click();
  await page.getByRole('button', { name: 'Markdown 저장', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.result-export button').disabled);
  assert.equal(await page.locator('.result-export [role]').count(), 0);
  assert.deepEqual(await readdir(exports), filesBeforeCancel);
  assert.equal(await readFile(mockFile, 'utf8'), before.finalResult);
  assert.deepEqual(await snapshot(), before);
  await save('취소 후 다시 저장.md');

  await choose({ filePath: path.join(exports, 'missing', 'result.md') }); await saveButton().click();
  await page.getByRole('alert').filter({ hasText: '파일을 저장하지 못했습니다.' }).waitFor();
  assert.deepEqual(await snapshot(), before);
  assert.equal(await readFile(mockFile, 'utf8'), before.finalResult);
  await save('오류 후 다시 저장.md');
  checks.push('dialog cancellation, real filesystem failure, unchanged Loop and retry');

  const heldPath = path.join(exports, '중복 방지.md'); const count = await dialogCount();
  await choose({ filePath: heldPath, hold: true });
  await saveButton().evaluate((button) => { button.click(); button.click(); });
  await page.getByRole('button', { name: '저장 중…', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '저장 중…', exact: true }).isDisabled(), true);
  assert.equal(await dialogCount(), count + 1);
  const duplicate = await page.evaluate((finalResult) => window.seohoKimLoop.exportMarkdown({ status: 'completed', finalResult }), before.finalResult);
  assert.deepEqual(duplicate, { status: 'failed' });
  assert.equal(await dialogCount(), count + 1);
  await page.getByRole('navigation').getByRole('button', { name: 'Connections', exact: true }).click();
  assert.equal(await page.getByTestId('connection-card').count(), 5);
  assert.equal(await page.locator('[data-provider-id="codex-cli-local"]').count(), 1);
  await desktop.evaluate(() => globalThis.releaseExport());
  await page.getByRole('navigation').getByRole('button', { name: 'Loop', exact: true }).click();
  await page.getByText('파일이 저장되었습니다.', { exact: true }).waitFor();
  assert.deepEqual(await snapshot(), before); assert.equal(calls, 0);
  assert.equal(await readFile(heldPath, 'utf8'), before.finalResult);
  checks.push('renderer/main duplicate guards and navigation during save');

  for (const execution of ['single', 'collaboration', 'auto']) {
    await modeChoice.selectOption(execution);
    if (execution !== 'auto') await page.locator('#provider').selectOption('openai-compatible');
    if (execution === 'collaboration') await page.locator('#reviewer').selectOption('anthropic');
    const requestsBefore = calls;
    await start(); await completed();
    assert.equal(calls - requestsBefore, execution === 'single' ? 1 : execution === 'collaboration' ? 3 : 4);
    assert.equal((await snapshot()).finalResult, original);
    assert.equal(await page.locator('.result-export [role]').count(), 0, 'Old Loop save notice must not leak.');
    await save(`${execution} 결과.md`);
    assert.equal(await page.evaluate(() => window.exportExecuted), undefined);
    assert.equal(await page.locator('.final-output script, .final-output img').count(), 0);
  }
  checks.push('Single/Manual/Auto exports, parallel Auto completion, exact original, no extra requests, inert Markdown');
  await writeFile(path.join(exports, '기존.md'), 'replace me');
  await save('기존.md');

  const windowSize = await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(860, 640);
    return window.getSize();
  });
  // Windows DPI conversion can round native bounds by one or two DIP.
  assert.ok(windowSize[0] >= 860 && windowSize[0] <= 862 && windowSize[1] >= 640 && windowSize[1] <= 642);
  // Hidden/offscreen Windows resizing does not always propagate to Chromium.
  // Explicitly size the actual renderer viewport too, before checking CSS and pixels.
  await page.setViewportSize({ width: 860, height: 640 });
  await page.waitForFunction(() => innerWidth <= 860 && innerHeight <= 640);
  await page.locator('.result-card').evaluate((card) => card.scrollIntoView({ block: 'start' }));
  const layout = await page.evaluate(() => {
    const button = document.querySelector('.result-export button').getBoundingClientRect();
    const heading = document.querySelector('#result-title').getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      cardOverflow: [...document.querySelectorAll('.card')].some((card) => card.scrollWidth > card.clientWidth + 1),
      buttonVisible: button.top >= 0 && button.bottom <= innerHeight, headingOverlap: button.top < heading.bottom };
  });
  assert.deepEqual(layout, { overflow: false, cardOverflow: false, buttonVisible: true, headingOverlap: false });
  // CDP captures the explicitly sized renderer viewport, rather than the native
  // offscreen paint surface, which can retain its original size after emulation.
  const minimumImage = await page.screenshot({ path: path.join(artifacts, `export-${mode}-minimum.png`) });
  assert.equal(minimumImage.readUInt32BE(16), 860);
  assert.equal(minimumImage.readUInt32BE(20), 640);
  checks.push('minimum window export button without overlap or clipping');

  const dialogsBefore = await dialogCount();
  for (const input of [null, { status: 'completed', finalResult: original, filePath: mockFile },
    { status: 'running', finalResult: original }, { status: 'completed', finalResult: 'x'.repeat(200_001) }]) {
    assert.deepEqual(await page.evaluate((data) => window.seohoKimLoop.exportMarkdown(data), input), { status: 'failed' });
  }
  assert.equal(await dialogCount(), dialogsBefore);
  for (const record of await desktop.evaluate(() => globalThis.exportDialogs)) {
    assert.equal(record.correctOwner, true);
    assert.equal(record.options.defaultPath, 'SeohoKim-Loop-Result.md');
    assert.deepEqual(record.options.filters, [{ name: 'Markdown', extensions: ['md'] }]);
    assert.ok(record.options.properties.includes('showOverwriteConfirmation'));
  }
  await modeChoice.selectOption('single'); await page.locator('#provider').selectOption('mock');
  await start(); await page.getByRole('button', { name: '작업 중지', exact: true }).click();
  await page.locator('[data-testid="loop"][data-status="cancelled"]').waitFor();
  assert.equal(await saveButton().count(), 0);
  fail = true; await page.locator('#provider').selectOption('openai-compatible'); await start();
  await page.locator('[data-testid="loop"][data-status="failed"]').waitFor();
  assert.equal(await saveButton().count(), 0);
  assert.equal(await dialogCount(), dialogsBefore);
  checks.push('failed/cancelled results cannot export and hostile payloads cannot choose paths');
  const preferences = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  const files = await readdir(exports);
  assert.ok(files.every((name) => name.endsWith('.md')));
  for (const name of files) assert.ok(!(await readFile(path.join(exports, name), 'utf8')).includes(secret));
  assert.ok(!(await page.locator('body').innerText() + logs.join('')).includes(secret));
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, `export-${mode}.json`), JSON.stringify({ mode, checks, files: files.length, requests: calls,
    nativeDialog: 'Selection simulated in Electron main; native Windows GUI interaction not verified.', errors }, null, 2));
  console.log(`PASS: ${mode} export — ${files.length} real UTF-8 files; ${checks.join('; ')}. Native dialog GUI unverified.`);
} finally {
  await desktop?.close(); await vite?.close();
  api.closeAllConnections(); await new Promise((resolve) => api.close(resolve));
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith('seohokim-export-smoke-'));
  await rm(directory, { recursive: true, force: true });
}
