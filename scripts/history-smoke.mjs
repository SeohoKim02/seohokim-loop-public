// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import electronPath from 'electron';
import { launchDesktop } from './smoke-window.mjs';
import { historySnapshot } from '../src/domain/loop-history.ts';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = path.join(root, 'artifacts');
const development = process.argv.includes('--dev');
const mode = development ? 'development' : 'production';
const directory = await mkdtemp(path.join(tmpdir(), 'seohokim-history-smoke-'));
const profile = path.join(directory, 'profile'); const folder = path.join(profile, 'loop-history');
await mkdir(profile); await mkdir(artifacts, { recursive: true });
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
for (const name of Object.keys(environment)) if (name.startsWith('SEOHOKIM_LOOP_')) delete environment[name];
const secret = 'fake-history-smoke-credential';
const original = '# 과거 결과 😀\r\n|항목|값|\n|---|---|\n```js\nconsole.log("보관");\n```\n<script>window.historyExecuted=true</script>\n![그림](https://example.test/not-requested.png)';
let calls = 0; let fail = false; let hold; let arrived;
const errors = []; const logs = []; const checks = [];
const api = createServer(async (request, response) => {
  try {
    calls++; assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, `Bearer ${secret}`);
    let raw = ''; for await (const chunk of request) raw += chunk;
    assert.ok(!raw.includes(secret));
    const planning = JSON.parse(raw).messages[0].content.includes('작업 계획 준비');
    arrived?.(); if (hold) await hold;
    if (fail) { response.writeHead(401); response.end('{}'); return; }
    const content = planning ? JSON.stringify({ title: '자동 기록 검증', steps: [
      { title: '초안', role: 'write', objective: '내용 작성', usesPreviousOutputs: false, dependsOn: [], isFinal: false },
      { title: '최종 정리', role: 'deliver', objective: '최종 정리', usesPreviousOutputs: true, dependsOn: [1], isFinal: true },
    ] }) : original;
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  } catch { errors.push('Unexpected local history request'); response.writeHead(500); response.end('{}'); }
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${api.address().port}/v1`;
let desktop; let page; let vite;
async function launch() {
  desktop = await launchDesktop({ executablePath: electronPath, args: [root, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`], cwd: root, env: environment, timeout: 30_000 });
  desktop.process().stdout?.on('data', (data) => logs.push(data.toString()));
  desktop.process().stderr?.on('data', (data) => logs.push(data.toString()));
  page = await desktop.firstWindow();
  page.on('pageerror', () => errors.push('Renderer error'));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push('Renderer console error'); });
  page.on('request', (request) => { if (!request.url().startsWith('file:') && !request.url().startsWith('http://127.0.0.1:')) errors.push('Unexpected renderer request'); });
  await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
  assert.equal(await desktop.evaluate(({ app }) => app.getPath('userData')), profile);
  const preferences = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined'); assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
}
const nav = (name) => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
const listing = async () => {
  const reply = await page.evaluate(() => window.seohoKimLoop.listHistory()); assert.equal(reply.ok, true); return reply.value;
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
const completed = async () => {
  await page.locator('[data-testid="loop"][data-status="completed"]').waitFor({ timeout: 15_000 });
  await page.getByText('기록에 보관되었습니다.', { exact: true }).waitFor();
  const loop = await liveLoop(); assert.deepEqual(await detail(loop.id), historySnapshot(loop)); return loop;
};
async function run(mode, provider = 'mock') {
  await nav('Loop'); await page.locator('#execution-mode').selectOption(mode);
  if (mode !== 'auto') await page.locator('#provider').selectOption(provider);
  if (mode === 'collaboration') await page.locator('#reviewer').selectOption('mock');
  await page.locator('#request').fill(`기록 검증 ${mode} ${provider}`);
  await page.getByRole('button', { name: 'Start Loop', exact: true }).click();
}
async function openRecord(id) {
  await nav('기록');
  await page.locator(`[data-history-id="${id}"]`).getByRole('button', { name: '기록 열기', exact: true }).click();
  await page.getByTestId('history-detail').waitFor();
}
async function exportDetail(expected, fileName = '과거 결과.md') {
  const filePath = path.join(directory, fileName); const before = calls;
  await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, filePath);
  await page.getByTestId('history-detail').getByRole('button', { name: 'Markdown 저장', exact: true }).click();
  await page.getByTestId('history-detail').getByText('파일이 저장되었습니다.', { exact: true }).waitFor();
  assert.deepEqual(await readFile(filePath), Buffer.from(expected, 'utf8')); assert.equal(calls, before);
}
try {
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  await launch(); await nav('기록'); await page.getByText('아직 저장된 작업이 없습니다.', { exact: true }).waitFor();
  const configured = await page.evaluate((config) => window.seohoKimLoop.saveConfiguration(config),
    { providerId: 'openai-compatible', baseUrl: base, model: 'history-test', apiKey: secret });
  assert.equal(configured.ok, true);
  await nav('Connections'); await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.getByRole('article', { name: 'OpenAI-compatible', exact: true }).getByRole('button', { name: '연결 수정', exact: true }).waitFor();
  const credentialFile = path.join(profile, 'openai-compatible-connection.json'); const credentialBefore = await readFile(credentialFile);
  await run('single');
  await page.locator('[data-testid="loop"][data-status="running"]').waitFor(); const runningId = (await liveLoop()).id;
  await nav('기록'); await page.getByText('아직 저장된 작업이 없습니다.', { exact: true }).waitFor(); await nav('Loop');
  assert.equal((await liveLoop()).id, runningId);
  const mockLoop = await completed(); const mockRecord = await detail(mockLoop.id);
  assert.equal(mockRecord.executionMode, 'single'); assert.equal(calls, 0);
  const bytes = await readFile(path.join(folder, `${mockLoop.id}.loop`));
  assert.ok(!bytes.includes(Buffer.from(mockLoop.userRequest))); assert.ok(!bytes.includes(Buffer.from(mockLoop.finalResult)));
  const decrypted = await desktop.evaluate(async ({ safeStorage }, encrypted) => {
    return JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'))).result);
  }, bytes.toString('base64'));
  assert.deepEqual(decrypted, mockRecord);
  await openRecord(mockLoop.id);
  const history = page.getByTestId('history-detail');
  assert.equal(await history.getByTestId('loop-request').textContent(), mockLoop.userRequest);
  assert.equal(await history.getByTestId('final-result').textContent(), mockLoop.finalResult);
  for (let i = 0; i < 5; i++) {
    await history.getByTestId('step').nth(i).getByText('단계 결과 보기', { exact: true }).click();
    assert.equal(await history.locator('.step-output').nth(i).textContent(), mockLoop.steps[i].output);
  }
  assert.equal(await history.getByRole('button', { name: /Start Loop|작업 중지/ }).count(), 0);
  assert.deepEqual(await liveLoop(), mockLoop); assert.equal(calls, 0);
  checks.push('Mock completed-only automatic encrypted snapshot and navigation without state changes');

  await desktop.close(); desktop = undefined; await launch();
  assert.equal(await page.getByTestId('loop').count(), 0);
  assert.deepEqual(await detail(mockLoop.id), mockRecord);
  await openRecord(mockLoop.id); await exportDetail(mockLoop.finalResult);
  const card = page.locator(`[data-history-id="${mockLoop.id}"]`);
  await card.getByRole('button', { name: '기록 삭제', exact: true }).click(); await card.getByRole('button', { name: '취소', exact: true }).click();
  assert.equal((await listing()).items.length, 1);
  await card.getByRole('button', { name: '기록 삭제', exact: true }).click(); await card.getByRole('button', { name: '삭제 확인', exact: true }).click();
  await page.getByText('아직 저장된 작업이 없습니다.', { exact: true }).waitFor();
  assert.deepEqual(await readFile(credentialFile), credentialBefore);
  await assert.rejects(readFile(path.join(folder, `${mockLoop.id}.loop`)), { code: 'ENOENT' });
  await desktop.close(); desktop = undefined; await launch();
  assert.deepEqual(await listing(), { items: [], partial: false }); assert.equal(calls, 0);
  checks.push('complete app restart restores disk data; past export; delete confirmation/cancel; restart preserves deletion; credential unchanged; zero AI calls');

  await run('single', 'openai-compatible'); const single = await completed(); assert.equal(calls, 1);
  await run('collaboration', 'openai-compatible'); const manual = await completed(); assert.equal(calls, 3);
  assert.equal((await detail(manual.id)).executionMode, 'manual');
  let release; hold = new Promise((resolve) => { release = resolve; }); const arrival = new Promise((resolve) => { arrived = resolve; });
  await run('auto'); await arrival;
  const autoRunning = await liveLoop(); const beforeRead = calls;
  await openRecord(manual.id); assert.equal(calls, beforeRead);
  await nav('Loop'); assert.equal((await liveLoop()).id, autoRunning.id); assert.equal((await liveLoop()).status, 'running');
  hold = undefined; arrived = undefined; release(); const auto = await completed(); assert.equal(calls, 6);
  assert.equal((await detail(auto.id)).executionMode, 'auto');
  const all = await listing(); assert.deepEqual(all.items.map((item) => item.id), [auto.id, manual.id, single.id]);
  assert.doesNotMatch(JSON.stringify(all), /userRequest|finalResult|output|"steps"/);
  await openRecord(auto.id); await exportDetail(original, '자동 과거 결과.md');
  assert.equal(await page.evaluate(() => window.historyExecuted), undefined);
  assert.equal(await page.getByTestId('history-detail').locator('script, img').count(), 0);
  const autoRecord = await detail(auto.id);
  for (let i = 0; i < 3; i++) assert.equal((await page.evaluate((data) => window.seohoKimLoop.saveHistory(data), autoRecord)).ok, true);
  assert.equal((await listing()).items.length, 3); assert.equal(calls, 6);
  checks.push('Single/Manual/Auto exact records; lightweight recent summaries; read during Auto; idempotent save; inert text and reused export');

  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
  await page.setViewportSize({ width: 860, height: 640 });
  await page.getByTestId('history-detail').evaluate((node) => node.scrollIntoView({ block: 'start' }));
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
    cardOverflow: [...document.querySelectorAll('.history-page .card')].some((card) => card.scrollWidth > card.clientWidth + 1),
    duplicateIds: [...document.querySelectorAll('[id]')].map((el) => el.id).filter((id, i, all) => all.indexOf(id) !== i) }));
  assert.deepEqual(layout, { overflow: false, cardOverflow: false, duplicateIds: [] });
  await page.screenshot({ path: path.join(artifacts, `history-${mode}-minimum.png`) });
  checks.push('minimum viewport and shared detail component with unique IDs');

  fail = true; await run('single', 'openai-compatible');
  await page.locator('[data-testid="loop"][data-status="failed"]').waitFor(); fail = false;
  assert.equal((await listing()).items.length, 3);
  await run('single'); await page.getByRole('button', { name: '작업 중지', exact: true }).click();
  await page.locator('[data-testid="loop"][data-status="cancelled"]').waitFor(); assert.equal((await listing()).items.length, 3);
  await desktop.evaluate(({ safeStorage }) => {
    globalThis.historyAvailability = safeStorage.isAsyncEncryptionAvailable; safeStorage.isAsyncEncryptionAvailable = async () => false;
  });
  await run('single'); await page.getByRole('alert').filter({ hasText: '기록을 안전하게 암호화할 수 없어 보관하지 못했습니다.' }).waitFor();
  const failedSaveLoop = await liveLoop(); assert.equal(failedSaveLoop.status, 'completed'); assert.ok(failedSaveLoop.finalResult);
  assert.equal(await page.getByRole('button', { name: 'Markdown 저장', exact: true }).isEnabled(), true);
  await desktop.evaluate(({ safeStorage }) => { safeStorage.isAsyncEncryptionAvailable = globalThis.historyAvailability; });
  assert.equal((await listing()).items.length, 3);
  assert.deepEqual(await readFile(credentialFile), credentialBefore);
  checks.push('failed/cancelled excluded; unavailable encryption preserves completed result and export; no plaintext fallback');

  await writeFile(path.join(folder, `${single.id}.loop`), Buffer.from('corrupted test bytes'));
  const future = { ...autoRecord, id: randomUUID(), schemaVersion: 9 };
  const futureCipher = await desktop.evaluate(async ({ safeStorage }, data) => (await safeStorage.encryptStringAsync(JSON.stringify(data))).toString('base64'), future);
  await writeFile(path.join(folder, `${future.id}.loop`), Buffer.from(futureCipher, 'base64'));
  await nav('기록'); await page.getByText('일부 기록을 불러오지 못했습니다.', { exact: true }).waitFor();
  assert.deepEqual((await listing()).items.map((item) => item.id), [auto.id, manual.id]);
  await page.locator(`[data-history-id="${manual.id}"]`).getByRole('button', { name: '기록 열기', exact: true }).click();
  await page.getByTestId('history-detail').waitFor(); assert.equal(await page.getByTestId('history-detail').getByTestId('final-result').textContent(), original);
  assert.deepEqual(await page.evaluate((id) => window.seohoKimLoop.deleteHistory(id), future.id), { ok: false, code: 'version' });
  for (const id of ['../openai-compatible-connection.json', 'C:/private', 'file.loop']) {
    assert.deepEqual(await page.evaluate((id) => window.seohoKimLoop.getHistory(id), id), { ok: false, code: 'invalid' });
    assert.deepEqual(await page.evaluate((id) => window.seohoKimLoop.deleteHistory(id), id), { ok: false, code: 'invalid' });
  }
  assert.deepEqual(await page.evaluate((data) => window.seohoKimLoop.saveHistory(data), { ...autoRecord, apiKey: secret }), { ok: false, code: 'invalid' });
  assert.equal((await readdir(folder)).filter((name) => name.endsWith('.loop')).length, 4);
  checks.push('corruption/unknown version isolation without automatic deletion; invalid paths and credential fields denied');

  // A graceful quit drains a write already accepted by main, even before its reply.
  await desktop.evaluate(({ safeStorage }) => {
    const encrypt = safeStorage.encryptStringAsync.bind(safeStorage);
    safeStorage.encryptStringAsync = async (text) => {
      globalThis.historyEncryptionStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 600)); return encrypt(text);
    };
  });
  await run('single');
  // Task 16 requires an explicit acknowledgement before replacing an unsaved result.
  await page.getByTestId('unsaved-confirm').waitFor();
  assert.deepEqual(await liveLoop(), failedSaveLoop);
  await page.getByRole('button', { name: '저장하지 않고 새 작업 시작', exact: true }).click();
  await page.getByText('기록을 보관하는 중…', { exact: true }).waitFor();
  const closingLoop = await liveLoop();
  await desktop.evaluate(async () => { while (!globalThis.historyEncryptionStarted) await new Promise((resolve) => setTimeout(resolve, 10)); });
  await desktop.close(); desktop = undefined; await launch();
  assert.deepEqual(await detail(closingLoop.id), historySnapshot(closingLoop));
  assert.equal(calls, 7);
  assert.deepEqual(await readFile(credentialFile), credentialBefore);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.ok(!logs.join('').includes(secret));
  for (const name of await readdir(folder)) {
    const data = await readFile(path.join(folder, name)); assert.ok(!data.includes(Buffer.from(secret)));
    assert.ok(!data.includes(Buffer.from(original))); assert.ok(!data.includes(Buffer.from(closingLoop.userRequest)));
  }
  assert.deepEqual(errors, []);
  checks.push('graceful shutdown drains accepted encryption/write; actual restart recovery; credentials and isolation intact');
  await writeFile(path.join(artifacts, `history-${mode}.json`), JSON.stringify({ mode, checks, localApiRequests: calls,
    historyApiRequests: 0, nativeSaveDialog: 'Selection simulated; existing native GUI interaction remains unverified', errors }, null, 2));
  console.log(`PASS: ${mode} History — actual Windows encrypted files, four app launches, restored/deleted records, ${calls} local AI requests and zero requests from History; ${checks.join('; ')}`);
} finally {
  await desktop?.close(); await vite?.close(); api.closeAllConnections(); await new Promise((resolve) => api.close(resolve));
  assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('seohokim-history-smoke-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
