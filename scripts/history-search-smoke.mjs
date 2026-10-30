// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import electronPath from 'electron';
import { launchDesktop } from './smoke-window.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = path.join(root, 'artifacts');
const development = process.argv.includes('--dev'); const mode = development ? 'development' : 'production';
const directory = await mkdtemp(path.join(tmpdir(), 'seohokim-search-smoke-'));
const profile = path.join(directory, 'profile'); const folder = path.join(profile, 'loop-history');
await mkdir(profile); await mkdir(artifacts, { recursive: true });
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
for (const name of Object.keys(environment)) if (name.startsWith('SEOHOKIM_LOOP_')) delete environment[name];
const errors = []; const logs = []; const checks = [];
const secret = 'fake-search-smoke-key';
const output = '# 결과 😀\r\nONLY_OUTPUT_MARKER\n```js\nconsole.log("text");\n```\n<script>window.searchExecuted=true</script>';
const start = '2026-10-14T01:00:00.000Z';
function record(title, userRequest, second) {
  const completedAt = `2026-10-14T01:00:0${second}.000Z`;
  return { schemaVersion: 1, id: randomUUID(), title, userRequest, executionMode: 'single', status: 'completed', createdAt: start, startedAt: start, completedAt,
    finalResult: output, steps: [{ id: randomUUID(), title: 'ONLY_STEP_MARKER', assignedProvider: { id: 'mock', displayName: 'Mock AI' },
      status: 'completed', output, retryCount: 0, startedAt: start, completedAt }] };
}
const records = [record('전기차 시장 비교 2026', '원래 요청 시장 비교', 2),
  record('AI Service Plan', '물류 운영 개선 Logistics 2027', 3),
  record('배터리 기술', '전기차 안전 .*+?[]()\\$^ <script>', 4)];
let desktop; let page; let vite;
async function launch() {
  desktop = await launchDesktop({ executablePath: electronPath, args: [root, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`], cwd: root, env: environment, timeout: 30_000 });
  desktop.process().stdout?.on('data', (data) => logs.push(data.toString())); desktop.process().stderr?.on('data', (data) => logs.push(data.toString()));
  page = await desktop.firstWindow();
  page.on('pageerror', () => errors.push('Renderer error'));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push('Renderer console error'); });
  page.on('request', (request) => { if (!request.url().startsWith('file:') && !request.url().startsWith('http://127.0.0.1:')) errors.push('External renderer request'); });
  await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
  assert.equal(await desktop.evaluate(({ app }) => app.getPath('userData')), profile);
  await desktop.evaluate(({ ipcMain, safeStorage, BrowserWindow }) => {
    const state = globalThis.searchTest = { lists: 0, executions: 0, checks: 0, fetches: 0, decryptions: 0, failRefresh: false };
    const decrypt = safeStorage.decryptStringAsync.bind(safeStorage);
    safeStorage.decryptStringAsync = async (...args) => { state.decryptions++; return decrypt(...args); };
    // Test-only interception retains the actual IPC validation and store.
    for (const [channel, field] of [['seohokim-loop:history:list', 'lists'], ['seohokim-loop:providers:execute', 'executions'], ['seohokim-loop:providers:test-connection', 'checks']]) {
      const handler = ipcMain._invokeHandlers.get(channel); if (typeof handler !== 'function') throw new Error('Missing handler');
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args) => {
        state[field]++;
        if (field === 'lists' && args.length === 0 && state.failRefresh) { state.failRefresh = false; return { ok: false, code: 'unavailable' }; }
        const reply = await handler(event, ...args);
        if (field === 'lists' && state.holdQuery !== undefined && args[0]?.query === state.holdQuery) {
          state.holdQuery = undefined; await new Promise((resolve) => { state.release = resolve; });
        }
        return reply;
      });
    }
    globalThis.fetch = async () => { state.fetches++; throw new Error('No external traffic allowed'); };
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    if (!prefs.contextIsolation || prefs.nodeIntegration || !prefs.sandbox) throw new Error('Isolation regression');
  });
  assert.deepEqual(await page.evaluate(() => [typeof window.require, typeof window.process, Object.keys(window.seohoKimLoop).length]), ['undefined', 'undefined', 14]);
}
const nav = (name) => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
const settled = () => page.getByTestId('history').getByText('기록을 불러오는 중…', { exact: true }).waitFor({ state: 'hidden' });
const ids = () => page.locator('[data-history-id]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-history-id')));
async function search(query, expected) {
  await page.getByRole('searchbox', { name: '기록 검색', exact: true }).fill(query); await settled();
  assert.deepEqual(await ids(), expected.map((item) => item.id));
}
const counts = () => desktop.evaluate(() => ({ lists: globalThis.searchTest.lists, executions: globalThis.searchTest.executions,
  checks: globalThis.searchTest.checks, fetches: globalThis.searchTest.fetches, decryptions: globalThis.searchTest.decryptions }));
const save = async (input) => { assert.equal((await page.evaluate((input) => window.seohoKimLoop.saveHistory(input), input)).ok, true); };
async function refresh() { await page.getByRole('button', { name: '기록 새로고침', exact: true }).click(); await settled(); }
try {
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  await launch(); await nav('기록'); await settled();
  await search('기록이 없는 검색', []); await page.getByText('아직 저장된 작업이 없습니다.', { exact: true }).waitFor();
  assert.equal((await page.evaluate((config) => window.seohoKimLoop.saveConfiguration(config), {
    providerId: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'local-test', apiKey: secret,
  })).ok, true);
  const credentialFile = path.join(profile, 'openai-compatible-connection.json'); const credential = await readFile(credentialFile);
  for (const item of records) await save(item);
  await refresh(); await page.getByText('검색 결과가 없습니다.', { exact: true }).waitFor();
  await page.getByRole('button', { name: '검색어 지우기', exact: true }).click(); await settled();
  assert.deepEqual(await ids(), [records[2].id, records[1].id, records[0].id]);
  const before = await counts(); const ciphertext = await Promise.all(records.map((item) => readFile(path.join(folder, `${item.id}.loop`))));
  for (const [query, expected] of [['시장 비교', [records[0]]], ['물류 운영', [records[1]]], ['ai', [records[1]]], ['AI', [records[1]]],
    ['logistics', [records[1]]], ['2026', [records[0]]], ['배터리', [records[2]]], ['.*+?[]()\\$^', [records[2]]], ['<script>', [records[2]]],
    ['  전기차 \t', [records[2], records[0]]], ['ONLY_OUTPUT_MARKER', []], ['ONLY_STEP_MARKER', []], ['없는 검색어', []]]) await search(query, expected);
  await page.getByText('검색 결과가 없습니다.', { exact: true }).waitFor();
  const after = await counts(); assert.equal(after.decryptions, before.decryptions); assert.equal(after.executions, before.executions);
  assert.equal(after.fetches, 0); assert.equal(after.checks, 0);
  const response = await page.evaluate(() => window.seohoKimLoop.listHistory({ query: '전기차' }));
  assert.equal(response.ok, true); assert.doesNotMatch(JSON.stringify(response), /userRequest|finalResult|"steps"|"output"|apiKey|Authorization/);
  for (let i = 0; i < records.length; i++) assert.deepEqual(await readFile(path.join(folder, `${records[i].id}.loop`)), ciphertext[i]);
  assert.deepEqual(await readFile(credentialFile), credential);
  checks.push('title/request Korean/English/case/numbers/specials/trim; no full-body matches; newest order; empty vs no match; no repeated disk decryption, AI or external traffic');

  await desktop.evaluate(() => { globalThis.searchTest.holdQuery = '전기차'; });
  await page.getByRole('searchbox', { name: '기록 검색' }).fill('전기차');
  await desktop.evaluate(async () => { while (!globalThis.searchTest.release) await new Promise((resolve) => setTimeout(resolve, 10)); });
  await search('물류', [records[1]]);
  await desktop.evaluate(() => globalThis.searchTest.release());
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
  assert.deepEqual(await ids(), [records[1].id]);
  await page.getByRole('searchbox', { name: '기록 검색' }).pressSequentially('x'.repeat(15), { delay: 5 });
  await search('전기차', [records[2], records[0]]);
  const added = record('추가 전기차 조사', '신규 요청', 5); await save(added); await refresh();
  assert.equal(await page.getByRole('searchbox', { name: '기록 검색' }).inputValue(), '전기차');
  assert.deepEqual(await ids(), [added.id, records[2].id, records[0].id]);
  checks.push('late replies cannot replace latest query; rapid typing; explicit refresh preserves query and includes new records');

  const selected = page.locator(`[data-history-id="${records[2].id}"]`);
  await selected.getByRole('button', { name: '기록 열기', exact: true }).click();
  const detail = page.getByTestId('history-detail'); await detail.waitFor(); await settled();
  assert.equal(await detail.getByTestId('loop-request').textContent(), records[2].userRequest);
  assert.equal(await detail.getByTestId('final-result').textContent(), output);
  await detail.getByText('단계 결과 보기', { exact: true }).click(); assert.equal(await detail.locator('.step-output').textContent(), output);
  assert.equal(await page.evaluate(() => window.searchExecuted), undefined);
  const filePath = path.join(directory, 'searched-result.md');
  await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, filePath);
  await detail.getByRole('button', { name: 'Markdown 저장', exact: true }).click(); await detail.getByText('파일이 저장되었습니다.', { exact: true }).waitFor();
  assert.deepEqual(await readFile(filePath), Buffer.from(output, 'utf8'));
  await selected.getByRole('button', { name: '기록 삭제', exact: true }).click();
  await selected.getByRole('button', { name: '취소', exact: true }).click(); assert.deepEqual(await ids(), [added.id, records[2].id, records[0].id]);
  await selected.getByRole('button', { name: '기록 삭제', exact: true }).click();
  await selected.getByRole('button', { name: '삭제 확인', exact: true }).click(); await settled();
  assert.deepEqual(await ids(), [added.id, records[0].id]); assert.equal(await detail.count(), 0);
  await page.getByRole('button', { name: '검색어 지우기', exact: true }).click(); await settled();
  assert.deepEqual(await ids(), [added.id, records[1].id, records[0].id]);
  checks.push('searched detail, inert outputs, byte-exact Markdown export, delete cancel/confirm, other records preserved, clear restores full list');

  await writeFile(path.join(folder, `${records[1].id}.loop`), 'corrupt test fixture');
  await search('전기차', [added, records[0]]); await refresh();
  await page.getByText('일부 기록을 불러오지 못했습니다.', { exact: true }).waitFor(); assert.deepEqual(await ids(), [added.id, records[0].id]);
  await desktop.evaluate(() => { globalThis.searchTest.failRefresh = true; });
  await refresh(); await page.getByText('기록을 불러오지 못했습니다.', { exact: true }).waitFor();
  await page.getByRole('searchbox', { name: '기록 검색' }).fill('물류');
  await page.getByText('기록을 불러오지 못했습니다.', { exact: true }).waitFor();
  await refresh(); await search('전기차', [added, records[0]]);
  assert.equal((await counts()).executions, 0); assert.equal((await counts()).fetches, 0); assert.equal((await counts()).checks, 0);
  checks.push('corrupt record isolation; list failure remains recoverable while editing query; search triggers zero AI/check/network calls');

  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640)); await page.setViewportSize({ width: 860, height: 640 });
  await page.locator('.history-search').evaluate((node) => node.scrollIntoView({ block: 'start' }));
  assert.deepEqual(await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
    overlap: document.querySelector('.history-search').getBoundingClientRect().bottom > document.querySelector('.history-list').getBoundingClientRect().top,
    clipped: [...document.querySelectorAll('.history-search input, .history-search button')].some((node) => node.getBoundingClientRect().right > innerWidth) })),
  { overflow: false, overlap: false, clipped: false });
  await page.screenshot({ path: path.join(artifacts, `history-search-${mode}-minimum.png`) });
  await desktop.close(); desktop = undefined; await launch(); await nav('기록'); await settled();
  assert.equal(await page.getByRole('searchbox', { name: '기록 검색' }).inputValue(), '');
  await search('전기차', [added, records[0]]); assert.deepEqual(await readFile(credentialFile), credential);
  await nav('Connections'); await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 수정', exact: true }).waitFor();
  await nav('Loop'); await page.locator('#execution-mode').selectOption('single'); await page.locator('#provider').selectOption('mock');
  await page.locator('#request').fill('새로운 전기차 Mock 실행'); await page.getByRole('button', { name: 'Start Loop', exact: true }).click();
  await nav('기록'); await settled(); await search('새로운 전기차', []);
  await page.waitForFunction(() => document.querySelector('[data-testid="history-save"]')?.getAttribute('data-phase') === 'saved', { timeout: 15_000 });
  assert.deepEqual(await ids(), []); await refresh();
  assert.equal(await page.locator('[data-history-id]').count(), 1);
  assert.equal(await page.getByRole('searchbox', { name: '기록 검색' }).inputValue(), '새로운 전기차');
  await nav('Loop'); assert.equal(await page.getByTestId('loop').getAttribute('data-status'), 'completed');
  assert.equal((await counts()).fetches, 0); assert.equal((await counts()).checks, 0);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.ok(!logs.join('').includes(secret)); assert.deepEqual(errors, []);
  checks.push('minimum layout; actual restart restores searchable records and resets query; credentials unchanged; Connections and Mock run; no polling, refresh applies query to newly completed Loop');
  await writeFile(path.join(artifacts, `history-search-${mode}.json`), JSON.stringify({ mode, checks, searchAiRequests: 0,
    nativeSaveDialog: 'Selection simulated; actual writer verified, native dialog interaction unverified', errors }, null, 2));
  console.log(`PASS: ${mode} local History search — ${checks.join('; ')}`);
} finally {
  await desktop?.close(); await vite?.close();
  assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('seohokim-search-smoke-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
