// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { launchDesktop } from './smoke-window.mjs';
import { ATTACHMENT_POLICY } from '../src/providers/text-attachments.ts';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const development = process.argv.includes('--dev'); const mode = development ? 'development' : 'production';
const pdfMode = process.argv.includes('--pdf'); const kind = pdfMode ? 'pdf' : 'attachments';
const primaryName = pdfMode ? 'report.pdf' : 'korea.txt';
const requestText = pdfMode ? '첨부 PDF를 분석하고 두 자료의 차이를 정리해줘.' : '이 두 파일을 비교해서 보고서를 작성해줘.';
const artifacts = path.join(root, 'artifacts');
const directory = await mkdtemp(path.join(tmpdir(), 'seohokim-attachments-smoke-'));
const profile = path.join(directory, 'profile'); await mkdir(profile); await mkdir(artifacts, { recursive: true });
const sources = [['korea.txt', '한국 전기차 시장 자료\r\n판매량 100 & < > 😀\n<script>window.attachmentExecuted=true</script>'],
  ['america.csv', '지역,판매량\n미국,150'], ['notes.md', '# 분석 참고\n보급률 비교\n<img src="https://preview.invalid/image" onerror="window.attachmentExecuted=true">\n[링크](https://preview.invalid/)\n$(whoami); powershell -Command echo secret'], ['data.json', '{"지역":"한국"}']];
for (const [name, content] of sources) await writeFile(path.join(directory, name), content, 'utf8');
if (pdfMode) {
  const { pdfFixture, PDF_KOREAN, PDF_ENGLISH } = await import('../tests/pdf-fixtures.ts');
  await writeFile(path.join(directory, primaryName), pdfFixture([PDF_KOREAN, PDF_ENGLISH]));
  sources[0] = [primaryName, `[Page 1]\n${PDF_KOREAN}\n\n[Page 2]\n${PDF_ENGLISH}`];
  for (const [name, bytes] of [['scan.pdf', pdfFixture([''], { image: true })], ['sparse.pdf', pdfFixture([PDF_KOREAN, '1'], { image: true })],
    ['password.pdf', pdfFixture([PDF_KOREAN], { password: 'test-only-password' })], ['31pages.pdf', pdfFixture(Array(31).fill(PDF_KOREAN))],
    ['corrupt.pdf', Buffer.from('%PDF-1.7\nprivate-corrupt-source')], ['renamed.pdf', Buffer.from('MZ executable')],
    ['oversize.pdf', Buffer.alloc(5 * 1024 * 1024 + 1)]]) await writeFile(path.join(directory, name), bytes);
}
await writeFile(path.join(directory, 'oversize.txt'), 'x'.repeat(128 * 1024 + 1));
await writeFile(path.join(directory, 'escaped.txt'), '"'.repeat(16_000));
const longText = '한국 English 123 & < > 😀\r\n'.repeat(500) + '마지막 문단\n' + 'x'.repeat(1000);
await writeFile(path.join(directory, 'long.txt'), longText);
await mkdir(path.join(directory, 'duplicate'));
await writeFile(path.join(directory, 'same.txt'), '첫 번째 같은 이름\r\nA 내용');
await writeFile(path.join(directory, 'duplicate', 'same.txt'), '두 번째 같은 이름\nB 내용');
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(environment)) if (key.startsWith('SEOHOKIM_LOOP_')) delete environment[key];
const secret = 'fake-attachment-http-key'; const errors = []; const logs = []; const checks = []; const requests = [];
let expected = []; let scenario; let desktop; let page; let vite;
const plan = { title: '두 시장 비교', steps: [
  { title: '자료 분석', role: 'analyze', objective: '두 파일의 차이를 분석', usesPreviousOutputs: false, isFinal: false },
  { title: '분석 검토', role: 'review', objective: '초안 검토', usesPreviousOutputs: true, isFinal: false },
  { title: '보고서 작성', role: 'deliver', objective: '검토를 반영한 비교 보고서', usesPreviousOutputs: true, isFinal: true },
] };
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.ok(['/v1/messages', '/v1/chat/completions'].includes(request.url));
    const claude = request.url === '/v1/messages';
    assert.equal(claude ? request.headers['x-api-key'] : request.headers.authorization, claude ? secret : `Bearer ${secret}`);
    let raw = ''; for await (const chunk of request) raw += chunk;
    assert.ok(!raw.includes(secret)); const body = JSON.parse(raw); const content = body.messages.at(-1).content;
    assert.equal(body.messages.at(-1).role, 'user'); assert.ok(content.includes(requestText));
    if (expected.length) {
      assert.equal(claude ? body.system : body.messages[0].content, ATTACHMENT_POLICY);
      assert.equal(body.messages.length, claude ? 1 : 2);
      const marker = '{"untrustedAttachments":'; const start = content.indexOf(marker); assert.ok(start >= 0);
      for (const [name, text] of expected) { assert.ok(content.includes(JSON.stringify(name))); assert.ok(content.includes(JSON.stringify(text))); }
      assert.equal(content.split(marker).length, 2, 'Attachments are not accumulated across steps');
      assert.ok(!content.includes(directory));
    } else { assert.equal(body.messages.length, 1); assert.ok(!body.system); assert.ok(!content.includes('untrustedAttachments')); }
    const current = scenario; assert.ok(current); requests.push({ provider: claude ? 'claude' : 'openai', planning: content.includes('작업 계획') });
    current.arrived?.();
    if (current.hold) {
      response.on('close', () => { if (!response.writableEnded) current.aborted = true; });
      await current.hold; if (response.destroyed) return;
    }
    let output;
    if (content.includes('작업 계획 준비') && current.recover) output = 'invalid planner JSON';
    else if (content.includes('작업 계획 준비') || content.includes('작업 계획 수정')) output = JSON.stringify(plan);
    else {
      for (const earlier of current.outputs) assert.ok(content.includes(earlier));
      output = `검증 결과 ${requests.length}: 자료를 비교했습니다.`; current.outputs.push(output);
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(claude ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: output }] }
      : { choices: [{ message: { content: output } }] }));
  } catch { errors.push('Unexpected local attachment request'); response.writeHead(500); response.end('{}'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
Object.assign(environment, { SEOHOKIM_LOOP_OPENAI_API_KEY: secret, SEOHOKIM_LOOP_OPENAI_BASE_URL: `${base}/v1`, SEOHOKIM_LOOP_OPENAI_MODEL: 'test-openai',
  SEOHOKIM_LOOP_ANTHROPIC_API_KEY: secret, SEOHOKIM_LOOP_ANTHROPIC_MODEL: 'test-claude' });
const nav = (name) => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
const attach = async (names, options = {}) => {
  await desktop.evaluate((_electron, choice) => { globalThis.attachmentChoices.push(choice); },
    { filePaths: names.map((name) => path.join(directory, name)), ...options });
  await page.getByRole('button', { name: '파일 첨부', exact: true }).click();
  await page.getByRole('button', { name: '파일 선택 중…', exact: true }).waitFor({ state: 'detached' });
};
const rows = () => page.locator('.attachment-row');
const preview = () => page.getByTestId('attachment-preview');
const readDraft = async () => {
  const ids = await rows().evaluateAll((nodes) => nodes.map((node) => node.dataset.attachmentId));
  return desktop.evaluate((_electron, ids) => ids.map((id) => globalThis.previewFiles.find((file) => file.id === id)), ids);
};
async function showPreview(index, text) {
  const row = rows().nth(index); const id = await row.getAttribute('data-attachment-id');
  await row.getByRole('button', { name: '내용 보기' }).click();
  assert.equal(await preview().getAttribute('data-attachment-id'), id);
  assert.equal(await preview().locator('pre').textContent(), text, 'Preview is the complete, unmodified attachment string');
  assert.equal(await row.getByRole('button', { name: '내용 보기' }).getAttribute('aria-expanded'), 'true');
  assert.equal(await preview().locator('script,img,a,iframe,input,textarea,[contenteditable]').count(), 0);
}
async function previewCycle() {
  const before = await readDraft(); const request = await page.locator('#request').inputValue();
  const calls = requests.length; const ipc = await desktop.evaluate(() => globalThis.previewIpcCount);
  for (let i = 0; i < before.length; i++) await showPreview(i, before[i].text);
  if (before.length) {
    await showPreview(0, before[0].text);
    await preview().locator('pre').evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await page.getByRole('button', { name: '미리보기 닫기', exact: true }).click();
    assert.equal(await preview().count(), 0);
    await showPreview(before.length - 1, before.at(-1).text);
  }
  assert.deepEqual(await readDraft(), before); assert.equal(await page.locator('#request').inputValue(), request);
  assert.equal(requests.length, calls); assert.equal(await desktop.evaluate(() => globalThis.previewIpcCount), ipc, 'Preview has zero IPC, including file reads, credentials and provider calls');
  return before;
}
async function run(execution, provider = 'openai-compatible', cancel = false, recover = false) {
  await page.locator('#execution-mode').selectOption(execution);
  if (execution !== 'auto') await page.locator('#provider').selectOption(provider);
  if (execution === 'collaboration') await page.locator('#reviewer').selectOption(provider === 'anthropic' ? 'openai-compatible' : 'anthropic');
  await page.locator('#request').fill(requestText);
  const draft = await previewCycle();
  const executionsBefore = await desktop.evaluate(() => globalThis.previewExecutions.length);
  let arrived; const arrival = new Promise((resolve) => { arrived = resolve; }); let release;
  scenario = { outputs: [], recover, arrived, ...(cancel ? { hold: new Promise((resolve) => { release = resolve; }) } : {}) };
  const count = requests.length;
  await page.getByRole('button', { name: 'Start Loop', exact: true }).click();
  assert.equal(await rows().count(), 0, 'Draft attachments cleared at Start');
  assert.equal(await preview().count(), 0, 'Preview cleared at Start');
  if (cancel) {
    await Promise.race([arrival, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('No request')), 15_000); timer.unref(); })]);
    await page.getByRole('button', { name: '작업 중지', exact: true }).click();
    await page.locator('[data-testid="loop"][data-status="cancelled"]').waitFor();
    assert.equal(await page.getByTestId('final-result').count(), 0);
    for (let i = 0; i < 20 && !scenario.aborted; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(scenario.aborted); release(); assert.equal(requests.length, count + 1);
  } else {
    await page.locator('[data-testid="loop"][data-status="completed"]').waitFor({ timeout: 20_000 });
    assert.equal(requests.length - count, execution === 'auto' ? recover ? 5 : 4 : execution === 'collaboration' ? 3 : 1);
    assert.ok((await page.getByTestId('final-result').innerText()).includes(scenario.outputs.at(-1)));
  }
  if (!cancel) await page.getByText('기록에 보관되었습니다.', { exact: true }).waitFor();
  const inputs = await desktop.evaluate((_electron, index) => globalThis.previewExecutions.slice(index), executionsBefore);
  assert.ok(inputs.length > 0);
  for (const input of inputs) {
    assert.deepEqual(input.attachments ?? [], draft, 'Every provider IPC receives the original preview data, IDs and order');
    assert.equal(input.userRequest, requestText);
  }
}
try {
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  desktop = await launchDesktop({ executablePath: electronPath, args: [root, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`], cwd: root, env: environment, timeout: 30_000 });
  desktop.process().stdout?.on('data', (data) => logs.push(data.toString())); desktop.process().stderr?.on('data', (data) => logs.push(data.toString()));
  page = await desktop.firstWindow(); page.on('pageerror', () => errors.push('Renderer error'));
  page.on('console', (entry) => { logs.push(entry.text()); if (entry.type() === 'error') errors.push('Renderer console error'); });
  await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
  await desktop.evaluate(({ dialog, BrowserWindow, ipcMain }, base) => {
    const fetch = globalThis.fetch;
    globalThis.fetch = (url, init) => fetch(String(url) === 'https://api.anthropic.com/v1/messages' ? `${base}/v1/messages` : url, init);
    globalThis.attachmentChoices = []; globalThis.attachmentDialogs = [];
    globalThis.previewIpcCount = 0; globalThis.previewFiles = []; globalThis.previewExecutions = [];
    // Observe the existing boundary without changing its handlers' inputs or results.
    for (const [channel, handler] of [...ipcMain._invokeHandlers]) {
      if (!channel.startsWith('seohokim-loop:')) continue;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args) => {
        globalThis.previewIpcCount++;
        if (channel === 'seohokim-loop:providers:execute') globalThis.previewExecutions.push(structuredClone(args[0].request));
        const reply = await handler(event, ...args);
        if (channel === 'seohokim-loop:attachments:select-text' && reply.status === 'selected') globalThis.previewFiles.push(...reply.files);
        return reply;
      });
    }
    // Native dialog selection only is scripted; main file reading, validation, IPC and adapters are real.
    // Direct clicking of the Windows dialog remains unverified to avoid taking desktop focus.
    dialog.showOpenDialog = async (owner, options) => {
      globalThis.attachmentDialogs.push({ options, owned: owner === BrowserWindow.getAllWindows()[0] });
      const choice = globalThis.attachmentChoices.shift(); if (!choice) throw new Error('No scripted selection');
      return { canceled: false, ...choice };
    };
  }, base);
  const preferences = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true);
  assert.deepEqual(await page.evaluate(() => [typeof window.require, typeof window.process, Object.keys(window.seohoKimLoop).length]), ['undefined', 'undefined', 14]);
  const unexpectedUrls = [];
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (development && url.origin === 'http://127.0.0.1:5173') return route.continue();
    unexpectedUrls.push(url.origin); await route.abort();
  });
  assert.equal(await preview().count(), 0);
  if (pdfMode) {
    await attach(['korea.txt']); await previewCycle();
    // Hold only delivery of worker completion, leaving actual parser/file IO untouched.
    await desktop.evaluate(() => {
      const { Worker } = process.getBuiltinModule('node:worker_threads'); const once = Worker.prototype.once;
      globalThis.pdfEvents = []; globalThis.pdfWorkerReady = false;
      Worker.prototype.once = function (event, listener) {
        if (event === 'message' || event === 'exit') return once.call(this, event, (...args) => {
          globalThis.pdfEvents.push(() => listener(...args)); if (event === 'message') globalThis.pdfWorkerReady = true;
        });
        return once.call(this, event, listener);
      };
      globalThis.releasePdf = () => { Worker.prototype.once = once; const events = globalThis.pdfEvents; globalThis.pdfEvents = []; for (const deliver of events) deliver(); };
    });
    await page.locator('#request').fill(requestText);
    const selecting = attach([primaryName]);
    await page.getByRole('status').filter({ hasText: 'PDF 텍스트 추출 중' }).waitFor();
    assert.equal(await preview().count(), 0);
    assert.equal(await rows().getByRole('button', { name: '내용 보기' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Start Loop', exact: true }).isDisabled(), true);
    await page.locator('form.request-card').evaluate((form) => form.requestSubmit());
    const duplicate = await page.evaluate(() => window.seohoKimLoop.selectTextFiles()); assert.deepEqual(duplicate, { status: 'failed', code: 'busy' });
    assert.equal(requests.length, 0);
    for (let i = 0; i < 100 && !await desktop.evaluate(() => globalThis.pdfWorkerReady); i++) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await desktop.evaluate(() => globalThis.pdfWorkerReady), true);
    await desktop.evaluate(() => globalThis.releasePdf()); await selecting;
    assert.equal(await rows().count(), 2);
    await page.getByRole('button', { name: 'korea.txt 첨부 제거', exact: true }).click();
    assert.equal(await preview().count(), 0);
    assert.equal(await rows().count(), 1, `PDF selection failed: ${await page.getByTestId('attachments').innerText()}`);
    assert.ok((await rows().innerText()).includes('텍스트 준비 완료')); assert.ok((await rows().innerText()).includes('바이트'));
    checks.push('real multi-page Korean/English PDF extraction; pending Start/duplicate selection blocked; original byte size and ready state');
    await previewCycle();
    for (const [name, message] of [['scan.pdf', '텍스트를 찾지 못했습니다'], ['sparse.pdf', '텍스트가 부족한 페이지'], ['password.pdf', '비밀번호'],
      ['31pages.pdf', '30페이지'], ['corrupt.pdf', 'PDF를 읽지 못했습니다'], ['renamed.pdf', '올바른 PDF'], ['oversize.pdf', '5MiB']]) {
      await attach([name]); await page.getByRole('alert').filter({ hasText: message }).waitFor(); assert.equal(await rows().count(), 1); assert.equal(requests.length, 0);
      assert.equal(await preview().locator('pre').textContent(), sources[0][1], 'Parser failure preserves the earlier completed preview');
    }
    checks.push('scan/sparse/password/corrupt/signature/size/page failures preserve old selection and spend zero HTTP');
  } else await attach([primaryName]);
  assert.equal(await rows().count(), 1);
  await previewCycle(); const selectedBeforeCancel = await readDraft();
  await attach([], { canceled: true }); assert.equal(await rows().count(), 1);
  assert.deepEqual(await readDraft(), selectedBeforeCancel); assert.equal(await preview().locator('pre').textContent(), selectedBeforeCancel[0].text);
  await attach(['oversize.txt']); await page.getByRole('alert').filter({ hasText: '128KiB' }).waitFor(); assert.equal(await rows().count(), 1);
  await attach(['america.csv', 'notes.md']); await page.getByRole('alert').filter({ hasText: '최대 2개' }).waitFor(); assert.equal(await rows().count(), 1);
  await attach(['america.csv']); assert.equal(await rows().count(), 2);
  await previewCycle(); await showPreview(0, sources[0][1]);
  assert.equal(await page.getByRole('button', { name: '파일 첨부', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: `${primaryName} 첨부 제거`, exact: true }).click();
  assert.equal(await preview().count(), 0);
  await attach(['notes.md']); await previewCycle(); await page.getByRole('button', { name: 'notes.md 첨부 제거', exact: true }).click();
  assert.equal(await preview().count(), 0);
  await attach(['data.json']); await previewCycle(); await page.getByRole('button', { name: 'data.json 첨부 제거', exact: true }).click();
  assert.equal(await preview().count(), 0);
  await attach([primaryName]); assert.equal(await rows().count(), 2); assert.equal(requests.length, 0);
  checks.push('four literal UTF-8 formats; cancel preserves state; oversize/merged count rejects; remove/re-attach; selection zero HTTP');
  await page.locator('#request').fill(requestText);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
  await page.setViewportSize({ width: 860, height: 640 }); await page.getByTestId('attachments').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const boxes = await rows().evaluateAll((nodes) => nodes.map((n) => { const a = n.querySelector('span').getBoundingClientRect(); const b = n.querySelector('button').getBoundingClientRect(); return a.right <= b.left || a.bottom <= b.top; }));
  assert.ok(boxes.every(Boolean)); await page.screenshot({ path: path.join(artifacts, `${kind}-${mode}-minimum.png`) });
  await previewCycle(); await preview().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(artifacts, `${kind}-${mode}-preview.png`) });
  if (pdfMode) {
    await page.getByRole('button', { name: 'america.csv 첨부 제거', exact: true }).click(); expected = [sources[0]]; await run('auto');
    const previous = await page.getByTestId('loop').innerText(); const before = requests.length;
    await attach(['scan.pdf']); await page.getByRole('alert').filter({ hasText: '텍스트를 찾지 못했습니다' }).waitFor();
    assert.equal(await page.getByTestId('loop').innerText(), previous); assert.equal(requests.length, before);
    await attach(['america.csv', primaryName]);
    checks.push('PDF-only Auto completes; later parser failure leaves completed Loop unchanged; PDF+CSV next');
  }
  expected = [sources[1], sources[0]]; await run('auto', 'openai-compatible', false, true);
  checks.push('Auto planner recovery + OpenAI/Claude work/review/final receive attachments; previous outputs passed');
  const exportPath = path.join(directory, 'report.md');
  await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
  await page.getByRole('button', { name: 'Markdown 저장', exact: true }).click(); await page.getByText('파일이 저장되었습니다.', { exact: true }).waitFor();
  assert.equal(await readFile(exportPath, 'utf8'), scenario.outputs.at(-1));
  const listing = await page.evaluate(() => window.seohoKimLoop.listHistory()); assert.ok(listing.ok); assert.equal(listing.value.items.length, pdfMode ? 2 : 1);
  const detail = await page.evaluate((id) => window.seohoKimLoop.getHistory(id), listing.value.items[0].id); assert.ok(detail.ok);
  const saved = JSON.stringify(detail.value); for (const [name, text] of sources) { assert.ok(!saved.includes(name)); assert.ok(!saved.includes(text)); }
  assert.ok(!saved.includes('attachments'));
  await nav('기록'); await page.getByRole('button', { name: '기록 열기', exact: true }).first().click(); await page.getByTestId('history-detail').waitFor();
  await nav('Connections'); assert.equal(await page.getByTestId('connection-card').count(), 5);
  assert.equal(await page.locator('[data-provider-id="codex-cli-local"]').count(), 1); await nav('Loop');
  checks.push('History retains original request/results only; Markdown exact result; Connections intact');
  for (const [execution, provider] of [['single', 'openai-compatible'], ['single', 'anthropic'], ['collaboration', 'openai-compatible']]) {
    await attach([primaryName, 'america.csv']); expected = sources.slice(0, 2); await run(execution, provider);
  }
  for (const execution of ['auto', 'single', 'collaboration']) {
    await attach([primaryName]); expected = sources.slice(0, 1); await run(execution, 'openai-compatible', true);
  }
  checks.push('Single both adapters; Manual draft/review/improve; all three modes abort current HTTP/no next call/no final');
  await attach(['escaped.txt']); await page.getByRole('alert').filter({ hasText: '20,000자' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Start Loop', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'escaped.txt 첨부 제거', exact: true }).click();
  expected = []; await run('auto'); checks.push('combined encoded context limit before Start; removed attachments absent in subsequent plain Auto');
  await attach(['same.txt', 'duplicate/same.txt']);
  // Changing the disk file after selection must not change the cached preview.
  await writeFile(path.join(directory, 'same.txt'), '디스크에서 변경된 내용: 미리보기에 다시 읽히면 안 됨');
  const duplicates = await previewCycle(); assert.equal(duplicates[0].name, duplicates[1].name); assert.notEqual(duplicates[0].id, duplicates[1].id);
  const beforeRemove = requests.length; const ipcBeforeRemove = await desktop.evaluate(() => globalThis.previewIpcCount);
  await rows().first().getByRole('button', { name: '첨부 제거' }).click();
  assert.equal(await preview().getAttribute('data-attachment-id'), duplicates[1].id, 'Removing another file keeps the selected preview');
  await rows().first().getByRole('button', { name: '첨부 제거' }).click(); assert.equal(await preview().count(), 0);
  assert.equal(requests.length, beforeRemove); assert.equal(await desktop.evaluate(() => globalThis.previewIpcCount), ipcBeforeRemove);
  await attach(['long.txt']); assert.equal(await preview().count(), 0); await previewCycle();
  const scroll = await preview().locator('pre').evaluate((node) => { node.scrollTop = node.scrollHeight; return { height: node.clientHeight, total: node.scrollHeight, top: node.scrollTop }; });
  assert.ok(scroll.total > scroll.height && scroll.top > 0 && scroll.height <= 320);
  await preview().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(artifacts, `${kind}-${mode}-preview-scroll.png`) });
  await page.getByRole('button', { name: 'long.txt 첨부 제거', exact: true }).click(); assert.equal(await preview().count(), 0);
  checks.push('preview all formats; exact CRLF/Korean/special characters/page markers; close/reopen/switch; same-name IDs; remove selected/unselected; full long-text inner scroll');
  checks.push('preview zero IPC/AI/credential/file reads; Auto/Single/Manual original request and every attachment ID/text/order preserved through provider IPC; Start clears preview');
  const publicConfig = await page.evaluate(async () => [await window.seohoKimLoop.listProviders(), await window.seohoKimLoop.getConfiguration('openai-compatible'), await window.seohoKimLoop.getConfiguration('anthropic')]);
  assert.ok(!(JSON.stringify(publicConfig) + await page.locator('body').innerText() + logs.join('')).includes(secret));
  for (const [, text] of sources) assert.ok(!logs.join('').includes(text));
  assert.equal(await page.evaluate(() => window.attachmentExecuted), undefined);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(unexpectedUrls, []);
  const dialogs = await desktop.evaluate(() => globalThis.attachmentDialogs);
  assert.ok(dialogs.every((d) => d.owned && d.options.properties.includes('openFile') && d.options.filters[0].extensions.includes('pdf')));
  await attach(['notes.md']); await previewCycle(); await page.reload(); await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
  assert.equal(await rows().count(), 0); assert.equal(await preview().count(), 0); checks.push('no credentials/source in logs or browser storage; source not executed; no external preview URLs; no attachment/preview restore on reload');
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, `${kind}-${mode}-smoke.json`), JSON.stringify({ status: 'passed', mode, checks, calls: requests.length,
    externalCalls: 0, nativeDialogClick: 'not verified; scripted selection in background', fileReads: 'real main filesystem' }, null, 2));
  console.log(`PASS: ${kind} ${mode}, ${requests.length} local HTTP calls, native dialog clicking NOT verified.`);
} finally {
  if (pdfMode) await desktop?.evaluate(() => globalThis.releasePdf?.()).catch(() => {});
  await desktop?.close().catch(() => {}); await vite?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  if (path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith('seohokim-attachments-smoke-')) await rm(directory, { recursive: true, force: true });
}
