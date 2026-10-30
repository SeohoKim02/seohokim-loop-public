// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { launchDesktop } from './smoke-window.mjs';
import { historySnapshot } from '../src/domain/loop-history.ts';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = path.join(root, 'artifacts');
const development = process.argv.includes('--dev');
const mode = development ? 'development' : 'production';
const directory = await mkdtemp(path.join(tmpdir(), 'seohokim-resave-smoke-'));
const profile = path.join(directory, 'profile');
const folder = path.join(profile, 'loop-history');
await mkdir(profile); await mkdir(artifacts, { recursive: true });
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
for (const name of Object.keys(environment)) if (name.startsWith('SEOHOKIM_LOOP_')) delete environment[name];
const checks = []; const errors = [];
let desktop; let page; let vite;
async function launch() {
  desktop = await launchDesktop({ executablePath: electronPath, args: [root, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`],
    cwd: root, env: environment, timeout: 30_000 });
  page = await desktop.firstWindow();
  page.on('pageerror', () => errors.push('Renderer error'));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push('Renderer console error'); });
  await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
  assert.equal(await desktop.evaluate(({ app }) => app.getPath('userData')), profile);
  await desktop.evaluate(({ ipcMain, safeStorage, BrowserWindow }) => {
    globalThis.resaveTest = { saves: 0, executions: 0, connectionChecks: 0, fetches: 0, loseReply: false,
      available: safeStorage.isAsyncEncryptionAvailable.bind(safeStorage), encrypt: safeStorage.encryptStringAsync.bind(safeStorage) };
    const state = globalThis.resaveTest;
    // Test-only wrappers of Electron's registered handlers preserve the real sender
    // validation and store. No test controls or new channels enter the product.
    for (const [channel, field] of [['seohokim-loop:history:save', 'saves'], ['seohokim-loop:providers:execute', 'executions'],
      ['seohokim-loop:providers:test-connection', 'connectionChecks']]) {
      const handler = ipcMain._invokeHandlers.get(channel);
      if (typeof handler !== 'function') throw new Error('Expected registered IPC handler');
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        state[field]++;
        const reply = await handler(...args);
        if (field === 'saves' && state.loseReply && reply.ok) { state.loseReply = false; return { ok: false, code: 'unavailable' }; }
        return reply;
      });
    }
    globalThis.fetch = async () => { state.fetches++; throw new Error('No network expected'); };
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    if (!preferences.contextIsolation || preferences.nodeIntegration || !preferences.sandbox) throw new Error('Isolation regression');
  });
  assert.deepEqual(await page.evaluate(() => [typeof window.require, typeof window.process, Object.keys(window.seohoKimLoop).length]), ['undefined', 'undefined', 14]);
}
const nav = (name) => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
const phase = (value) => page.locator(`[data-testid="history-save"][data-phase="${value}"]`).waitFor();
const stats = () => desktop.evaluate(() => ({ saves: globalThis.resaveTest.saves, executions: globalThis.resaveTest.executions,
  connectionChecks: globalThis.resaveTest.connectionChecks, fetches: globalThis.resaveTest.fetches }));
const list = async () => {
  const reply = await page.evaluate(() => window.seohoKimLoop.listHistory()); assert.equal(reply.ok, true); return reply.value.items;
};
const detail = async (id) => {
  const reply = await page.evaluate((id) => window.seohoKimLoop.getHistory(id), id); assert.equal(reply.ok, true); return reply.value;
};
const liveLoop = () => page.evaluate(() => {
  const node = document.querySelector('.work-grid'); let fiber = node[Object.keys(node).find((key) => key.startsWith('__reactFiber$'))];
  while (fiber.return) fiber = fiber.return;
  const pending = [fiber.stateNode.current];
  while (pending.length) {
    const current = pending.pop();
    if (current.memoizedProps?.loop) return JSON.parse(JSON.stringify(current.memoizedProps.loop));
    if (current.sibling) pending.push(current.sibling); if (current.child) pending.push(current.child);
  }
  throw new Error('Current Loop unavailable');
});
async function startMock(label) {
  await nav('Loop'); await page.locator('#execution-mode').selectOption('single');
  await page.locator('#provider').selectOption('mock'); await page.locator('#request').fill(label);
  await page.getByRole('button', { name: 'Start Loop', exact: true }).click();
}
const complete = () => page.locator('[data-testid="loop"][data-status="completed"]').waitFor({ timeout: 15_000 });
async function availability(enabled) {
  await desktop.evaluate(({ safeStorage }, enabled) => {
    safeStorage.isAsyncEncryptionAvailable = enabled ? globalThis.resaveTest.available : async () => false;
  }, enabled);
}
async function holdEncryption() {
  await desktop.evaluate(({ safeStorage }) => {
    globalThis.resaveTest.encryptions = 0;
    safeStorage.encryptStringAsync = async (text) => {
      globalThis.resaveTest.encryptions++;
      await new Promise((resolve) => { globalThis.resaveTest.release = resolve; });
      return globalThis.resaveTest.encrypt(text);
    };
  });
}
async function releaseEncryption() {
  await desktop.evaluate(async ({ safeStorage }) => {
    while (!globalThis.resaveTest.release) await new Promise((resolve) => setTimeout(resolve, 10));
    safeStorage.encryptStringAsync = globalThis.resaveTest.encrypt; globalThis.resaveTest.release();
  });
}
try {
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  await launch(); await availability(false);
  await startMock('재저장 검증 원본 결과'); await complete(); await phase('failed');
  const original = await liveLoop(); assert.equal(original.status, 'completed'); assert.equal(original.steps.length, 5);
  const initial = await stats(); assert.equal(initial.saves, 1);
  assert.equal(await page.getByRole('button', { name: '다시 저장', exact: true }).isEnabled(), true);
  assert.deepEqual(await readdir(folder).catch(() => []), []);
  await nav('기록'); await page.getByText('아직 저장된 작업이 없습니다.', { exact: true }).waitFor();
  await nav('Connections'); await nav('Loop'); await phase('failed');
  assert.deepEqual(await liveLoop(), original); assert.deepEqual(await stats(), initial);
  await page.getByRole('button', { name: '다시 저장', exact: true }).click(); await phase('failed');
  await page.getByText('기록을 저장하지 못했습니다. 다시 시도할 수 있습니다.', { exact: true }).waitFor();
  assert.deepEqual(await liveLoop(), original); assert.equal((await stats()).saves, 2);
  assert.deepEqual(await readdir(folder).catch(() => []), []);
  checks.push('automatic failure, repeated explicit failure, full completed state preserved, navigation retained, no plaintext or automatic retry');

  const exportPath = path.join(directory, 'unsaved.md');
  await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
  await page.getByRole('button', { name: 'Markdown 저장', exact: true }).click();
  await page.getByText('파일이 저장되었습니다.', { exact: true }).waitFor();
  assert.deepEqual(await readFile(exportPath), Buffer.from(original.finalResult, 'utf8'));
  await page.locator('#request').fill('새 작업이 이전 결과를 조용히 지우지 않는다');
  await page.getByRole('button', { name: 'Start Loop', exact: true }).click();
  await page.getByTestId('unsaved-confirm').waitFor(); assert.deepEqual(await liveLoop(), original);
  await page.getByRole('button', { name: '이전 결과 유지', exact: true }).click();
  assert.equal(await page.getByTestId('unsaved-confirm').count(), 0); assert.deepEqual(await liveLoop(), original);
  checks.push('failed result Markdown export remains byte-exact; new Loop requires acknowledgement and cancel preserves old result');

  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
  await page.setViewportSize({ width: 860, height: 640 });
  await page.getByTestId('history-save').evaluate((node) => node.scrollIntoView({ block: 'start' }));
  assert.deepEqual(await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
    overlap: document.querySelector('[data-testid="history-save"]').getBoundingClientRect().bottom > document.querySelector('.work-grid').getBoundingClientRect().top,
    clipped: [...document.querySelectorAll('[data-testid="history-save"] button')].some((el) => el.scrollWidth > el.clientWidth + 1) })),
  { overflow: false, overlap: false, clipped: false });
  await page.screenshot({ path: path.join(artifacts, `history-resave-${mode}-minimum.png`) });

  await availability(true); await holdEncryption();
  const before = await stats();
  await page.getByRole('button', { name: '다시 저장', exact: true }).evaluate((button) => { button.click(); button.click(); });
  await phase('resaving');
  assert.equal(await page.getByRole('button', { name: '재저장 중…', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Start Loop', exact: true }).isDisabled(), true);
  // Programmatic submit also cannot replace a result while save acknowledgement is pending.
  await page.locator('form.request-card').evaluate((form) => form.requestSubmit());
  assert.deepEqual(await liveLoop(), original); assert.equal((await stats()).saves, before.saves + 1);
  await nav('기록'); await nav('Loop'); await phase('resaving');
  await releaseEncryption(); await phase('saved');
  await page.getByText('기록이 저장되었습니다.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '다시 저장', exact: true }).count(), 0);
  assert.deepEqual(await liveLoop(), original); assert.deepEqual(await detail(original.id), historySnapshot(original));
  assert.equal((await list()).length, 1);
  assert.deepEqual(await stats(), { ...before, saves: before.saves + 1 });
  assert.equal(await desktop.evaluate(() => globalThis.resaveTest.encryptions), 1);
  const encrypted = await readFile(path.join(folder, `${original.id}.loop`));
  assert.ok(!encrypted.includes(Buffer.from(original.finalResult))); assert.ok(!encrypted.includes(Buffer.from(original.userRequest)));
  checks.push('one request for synchronous double-click; manual pending blocks submit; restored encryption saves exact same ID; zero extra execution/check/fetch calls; minimum layout');

  // Simulate real successful storage followed by a lost acknowledgement.
  await desktop.evaluate(() => { globalThis.resaveTest.loseReply = true; });
  await startMock('응답 유실 검증'); await complete(); await phase('failed');
  const lost = await liveLoop(); const lostBytes = await readFile(path.join(folder, `${lost.id}.loop`));
  const lostBefore = await stats(); assert.equal((await list()).length, 2);
  await page.getByRole('button', { name: '다시 저장', exact: true }).click(); await phase('saved');
  assert.deepEqual(await readFile(path.join(folder, `${lost.id}.loop`)), lostBytes);
  assert.deepEqual(await readFile(path.join(folder, `${original.id}.loop`)), encrypted);
  assert.deepEqual(await liveLoop(), lost); assert.equal((await list()).length, 2);
  assert.deepEqual(await stats(), { ...lostBefore, saves: lostBefore.saves + 1 });
  checks.push('lost acknowledgement reuses existing encrypted file without rewrite or damage to another record');

  // Automatic save remains once-only while held across navigation and user submits.
  await holdEncryption(); await startMock('자동 저장 경쟁 검증'); await complete(); await phase('saving');
  const automatic = await liveLoop(); const autoBefore = await stats();
  assert.equal(await page.getByRole('button', { name: '다시 저장', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Start Loop', exact: true }).isDisabled(), true);
  await page.locator('form.request-card').evaluate((form) => form.requestSubmit());
  await nav('Connections'); await nav('Loop'); await phase('saving');
  assert.deepEqual(await liveLoop(), automatic); assert.deepEqual(await stats(), autoBefore);
  await releaseEncryption(); await phase('saved'); assert.equal((await list()).length, 3);
  checks.push('automatic save and manual/new-run entry are mutually exclusive before acknowledgement');

  await availability(false); await startMock('미보관 결과 교체 확인'); await complete(); await phase('failed');
  const abandoned = await liveLoop();
  await startMock('종료 후 복원되지 않는 미보관 결과'); await page.getByTestId('unsaved-confirm').waitFor();
  assert.deepEqual(await liveLoop(), abandoned);
  await page.getByRole('button', { name: '저장하지 않고 새 작업 시작', exact: true }).click();
  await complete(); await phase('failed'); const unsaved = await liveLoop(); assert.notEqual(unsaved.id, abandoned.id);
  await page.getByText('저장되지 않은 결과는 앱 종료 후 복원을 보장할 수 없습니다.', { exact: false }).waitFor();
  assert.equal((await stats()).fetches, 0); assert.equal((await stats()).connectionChecks, 0);
  await desktop.close(); desktop = undefined; await launch();
  assert.equal(await page.getByTestId('loop').count(), 0); assert.equal(await page.getByTestId('history-save').count(), 0);
  assert.deepEqual((await list()).map((item) => item.id).sort(), [original.id, lost.id, automatic.id].sort());
  for (const id of [unsaved.id, abandoned.id]) assert.deepEqual(await page.evaluate((id) => window.seohoKimLoop.getHistory(id), id), { ok: false, code: 'missing' });
  await nav('기록'); await page.locator(`[data-history-id="${original.id}"]`).waitFor();
  assert.equal(await page.locator(`[data-history-id="${original.id}"]`).count(), 1);
  await page.locator(`[data-history-id="${original.id}"]`).getByRole('button', { name: '기록 열기', exact: true }).click();
  await page.getByTestId('history-detail').waitFor();
  assert.equal(await page.getByTestId('history-detail').getByTestId('final-result').textContent(), original.finalResult);
  assert.deepEqual(await detail(original.id), historySnapshot(original));
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(errors, []);
  checks.push('explicit discard only; saved records restored after actual restart; failed unsaved results correctly absent; no storage or security surface changes');
  await writeFile(path.join(artifacts, `history-resave-${mode}.json`), JSON.stringify({ mode, checks, additionalAiRequests: 0,
    nativeSaveDialog: 'Selection simulated; actual writer verified, native dialog interaction unverified', errors }, null, 2));
  console.log(`PASS: ${mode} manual History re-save — ${checks.join('; ')}`);
} finally {
  await desktop?.close(); await vite?.close();
  assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('seohokim-resave-smoke-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
