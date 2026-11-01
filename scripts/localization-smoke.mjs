// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import electronPath from 'electron';
import { pdfFixture, PDF_ENGLISH } from '../tests/pdf-fixtures.ts';
import { launchDesktop, captureDesktop } from './smoke-window.mjs';

// No live flag. Only Mock and an ephemeral loopback fake API are available.
if (!process.argv.includes('--background')) throw new Error('Run with --background to avoid interrupting the desktop.');
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const dev = process.argv.includes('--dev'); const mode = dev ? 'development' : 'production';
const artifacts = path.join(root, 'artifacts/i18n-v02'); await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(path.join(tmpdir(), 'seohokim-language-'));
const profile = path.join(directory, 'profile'); await mkdir(profile);
const wrapper = path.join(directory, 'isolated-main.cjs');
const errors = []; const checks = []; let calls = 0; let responseMode = 'success';
const output = '  Original result 한국어 😀\r\nDo not translate this.  ';
const api = createServer(async (request, response) => {
  calls++;
  let text = ''; for await (const part of request) text += part;
  assert.equal(request.url, '/v1/chat/completions');
  if (responseMode === 'error') { response.writeHead(401); response.end('{"secret":"never display fake-secret"}'); return; }
  const data = JSON.parse(text); assert.equal(data.model, 'fake-language-model');
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: 'stop' }] }));
});
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${api.address().port}`;
await writeFile(wrapper, `const http = require('node:http');
const https = require('node:https');
// Prevent even metadata access to the user's actual local model server.
http.request = https.request = () => { throw new Error('External transport blocked by localization smoke'); };
const transport = globalThis.fetch;
globalThis.fetch = (url, options) => { if (!String(url).startsWith(${JSON.stringify(base + '/')})) throw new Error('Non-fixture fetch blocked'); return transport(url, options); };
require(${JSON.stringify(path.join(root, 'dist-electron/electron/main.cjs'))});
`);
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('SEOHOKIM_LOOP_') || /API_KEY/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
Object.assign(env, { SEOHOKIM_LOOP_CODEX_LOCAL: '1', SEOHOKIM_LOOP_OPENAI_API_KEY: 'fake-language-key', SEOHOKIM_LOOP_OPENAI_BASE_URL: `${base}/v1`, SEOHOKIM_LOOP_OPENAI_MODEL: 'fake-language-model' });
let desktop; let page; let vite; let systemLanguage = 'ko-KR';
const launch = async () => {
  desktop = await launchDesktop({ executablePath: electronPath, args: [wrapper, ...(dev ? ['--dev'] : []), `--lang=${systemLanguage}`, `--user-data-dir=${profile}`], cwd: root, env, timeout: 30000 });
  page = await desktop.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  await page.locator('#app-language').waitFor();
  const cli=await page.evaluate(async()=>{const reply=await window.seohoKimLoop.listProviders();return reply.value.find(p=>p.id==='codex-cli-local');});assert.equal(cli.configured,false);assert.equal(cli.localCli.state,'disabled');
};
const language = async locale => {
  await page.locator('#app-language').selectOption(locale);
  assert.equal(await page.locator('html').getAttribute('lang'), locale);
};
const noKoreanChrome = async (label, exclude = '') => {
  const leaks = await page.evaluate(exclude => {
    const root = document.querySelector('main'); const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const leaks = []; let node;
    while (node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('[hidden]') || (exclude && parent.closest(exclude))) continue;
      if (!/[가-힣]/.test(node.textContent)) continue;
      const box = parent.getBoundingClientRect(); if (box.width && box.height) leaks.push(node.textContent.trim());
    }
    for (const element of root.querySelectorAll('[aria-label], [placeholder], [title]')) {
      if (element.closest('[hidden]') || (exclude && element.closest(exclude))) continue;
      for (const name of ['aria-label', 'placeholder', 'title']) if (/[가-힣]/.test(element.getAttribute(name) ?? '')) leaks.push(element.getAttribute(name));
    }
    return leaks;
  }, exclude);
  assert.deepEqual(leaks, [], label); checks.push(label);
};
const nav = name => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
const start = async (request, provider = 'mock') => {
  await page.locator('#execution-mode').selectOption('single');
  await page.locator('#provider').selectOption(provider);
  await page.locator('#request').fill(request);
  await page.getByRole('button', { name: 'Start Loop', exact: true }).click();
};
const completed = async locale => {
  await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
  await page.getByText(locale === 'en' ? 'Saved to History.' : '기록에 보관되었습니다.', { exact: true }).waitFor();
};
const historyFiles = async () => {
  const directory = path.join(profile, 'loop-history');
  return Promise.all((await readdir(directory)).sort().map(async file => ({ file, hash: createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex') })));
};
try {
  if (dev) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  await launch();
  assert.equal(await page.locator('#app-language').inputValue(), 'ko');
  await captureDesktop(desktop, page, {path:path.join(artifacts, mode+'-first-launch-ko.png')});
  checks.push('Fresh Korean system locale defaults to Korean');
  await page.evaluate(()=>localStorage.removeItem('seohokim-loop.language'));
  await desktop.close();desktop=undefined;systemLanguage='en-US';await launch();
  assert.equal(await page.locator('#app-language').inputValue(), 'en'); checks.push('Fresh English system locale defaults to English');
  const preferences = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true);
  await language('en');
  await page.locator('#request').fill('Keep this draft 한국어'); await language('ko'); await language('en');
  assert.equal(await page.locator('#request').inputValue(), 'Keep this draft 한국어');
  await page.locator('#request').fill('');
  assert.equal(await page.getByRole('button', { name: 'Start Loop', exact: true }).isDisabled(), true);
  await noKoreanChrome('English home and accessible labels');
  await page.locator('#execution-mode').selectOption('collaboration');
  await noKoreanChrome('English Manual instructions');
  await nav('Connections');
  await page.locator('[data-testid="connection-card"]').first().waitFor();
  await noKoreanChrome('English Connections, Ollama and disabled CLI');
  const card = page.locator('[data-provider-id="openai-compatible"]');
  await card.getByRole('button', { name: 'Edit connection', exact: true }).click();
  await noKoreanChrome('English connection editor');
  await page.locator('#connection-model').fill('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  assert.doesNotMatch(await page.locator('#connection-model').evaluate(el => el.validationMessage), /[가-힣]/);
  await page.locator('#connection-model').fill('fake-language-model');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('.connection-editor').waitFor({ state: 'hidden' });
  await page.evaluate(() => scrollTo(0, 0));
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-connections-en.png`) });
  await nav('History'); await noKoreanChrome('English empty History');
  await nav('Loop');
  const attachment = path.join(directory, 'demo.txt'); const attachedText = 'Synthetic attachment text.\r\nKeep the original spacing.  ';
  await writeFile(attachment, attachedText);
  await desktop.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.languageOpenDialog = options;
      return { canceled: false, filePaths: [file] };
    };
  }, attachment);
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  await page.getByRole('button', { name: 'View contents of demo.txt', exact: true }).click();
  assert.equal(await page.locator('.attachment-preview-text').textContent(), attachedText);
  const openOptions = await desktop.evaluate(() => globalThis.languageOpenDialog);
  assert.equal(openOptions.title, 'Attach files');
  await noKoreanChrome('English attachment and native dialog labels');
  await language('ko'); await language('en');
  assert.equal(await page.locator('.attachment-preview-text').textContent(), attachedText);
  await page.getByRole('button', { name: 'Remove attachment demo.txt', exact: true }).click();
  const pdf = path.join(directory, 'synthetic.pdf'); await writeFile(pdf, pdfFixture([PDF_ENGLISH]));
  await desktop.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, pdf);
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  await page.getByRole('button', { name: 'View contents of synthetic.pdf', exact: true }).click();
  const pdfText = await page.locator('.attachment-preview-text').textContent(); assert.match(pdfText, /150/);
  await language('ko'); await language('en'); assert.equal(await page.locator('.attachment-preview-text').textContent(), pdfText);
  await noKoreanChrome('English actual PDF extraction and preview controls');
  await page.getByRole('button', { name: 'Remove attachment synthetic.pdf', exact: true }).click();
  await writeFile(pdf, 'not a PDF'); await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  await page.getByRole('alert').filter({hasText:/PDF/}).waitFor(); await noKoreanChrome('English PDF error');
  await desktop.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});});
  await page.getByRole('button',{name:'Attach files',exact:true}).click();
  await page.evaluate(() => scrollTo(0, 0));
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-home-en.png`) });
  await start('Write an invitation in at least 1 character.');
  await page.locator('[data-status="running"][data-testid="loop"]').waitFor();
  await noKoreanChrome('English running Mock');
  await language('ko'); await language('en'); // Execution locale remains captured at Start.
  await completed('en');
  for (const details of await page.locator('.step-list details').all()) await details.locator('summary').click();
  const mockResult = await page.getByTestId('final-result').textContent();
  assert.match(mockResult, /No actual research, analysis or AI calls/); assert.doesNotMatch(mockResult, /[가-힣]/);
  await page.getByRole('button', { name: 'Check length', exact: true }).click();
  assert.equal(await page.getByTestId('length-result').getAttribute('data-verdict'), 'satisfied');
  await page.getByTestId('length-source').locator('summary').click();
  await noKoreanChrome('English completed Mock, expanded steps and diagnostics');
  const hashes = await historyFiles();
  await language('ko'); assert.equal(await page.getByTestId('final-result').textContent(), mockResult);
  await language('en'); assert.deepEqual(await historyFiles(), hashes);
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-mock-en.png`) });
  await nav('History'); await page.getByRole('button', { name: 'Open record', exact: true }).first().click();
  assert.equal(await page.getByTestId('history-detail').getByTestId('final-result').textContent(), mockResult);
  await noKoreanChrome('English saved History detail');
  await desktop.close(); desktop = undefined; await launch();
  assert.equal(await page.locator('#app-language').inputValue(), 'en');
  await nav('History'); await page.getByRole('button', { name: 'Open record', exact: true }).first().click();
  assert.equal(await page.getByTestId('history-detail').getByTestId('final-result').textContent(), mockResult);
  assert.deepEqual(await historyFiles(), hashes); checks.push('Language and encrypted History restored after restart; original bytes unchanged');
  await nav('Loop'); await start('Write a note.', 'openai-compatible'); await completed('en');
  assert.equal(await page.getByTestId('final-result').textContent(), output);
  await language('ko'); assert.equal(await page.getByTestId('final-result').textContent(), output); await language('en');
  await noKoreanChrome('Real adapter output stays verbatim while English chrome changes', '.final-output, .step-output');
  const exported = path.join(directory, 'result.md');
  await desktop.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async (_window, options) => { globalThis.languageSaveDialog = options; return { canceled: false, filePath: file }; };
  }, exported);
  await page.getByRole('button', { name: 'Save Markdown', exact: true }).click();
  await page.getByText('File saved.', { exact: true }).waitFor();
  assert.equal(await readFile(exported, 'utf8'), output);
  const saveOptions = await desktop.evaluate(() => globalThis.languageSaveDialog);
  assert.equal(saveOptions.title, 'Save final result as Markdown'); assert.equal(saveOptions.buttonLabel, 'Save');
  checks.push('English native export labels and exact original Markdown bytes');
  await desktop.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true});});
  await page.getByRole('button',{name:'Save Markdown',exact:true}).click();await page.getByText('File saving was cancelled.',{exact:true}).waitFor();
  await language('ko');await page.getByText('파일 저장을 취소했습니다.',{exact:true}).waitFor();await language('en');
  await desktop.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>{throw Error('synthetic-secret-error');};});
  await page.getByRole('button',{name:'Save Markdown',exact:true}).click();await page.getByText('Could not save the file.',{exact:true}).waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('synthetic-secret-error')); checks.push('Export cancelled and failed states translate without altering output');
  for (const [request, verdict] of [['Write at least 10000 characters.', 'under'], ['Write at most 0 characters.', 'over'], ['Write in between 1 and 1000 characters.', 'satisfied'], ['Write at least 100 characters and at most 10 characters.', 'unavailable'], ['Write exactly 50 characters per paragraph.', 'unavailable']]) {
    await start(request, 'openai-compatible'); await completed('en');
    await page.getByRole('button', {name:'Check length',exact:true}).click();
    assert.equal(await page.getByTestId('length-result').getAttribute('data-verdict'),verdict);
    await language('ko'); await language('en');assert.equal(await page.getByTestId('final-result').textContent(),output);
    await noKoreanChrome('English length diagnostic: '+request,'.final-output, .step-output');
  }
  responseMode = 'error'; await start('Show a safe error.', 'openai-compatible');
  await page.locator('[data-testid="loop"][data-status="failed"]').waitFor();
  await noKoreanChrome('English HTTP error and failed Loop'); assert.ok(!(await page.locator('body').innerText()).includes('fake-secret'));
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-failure-en.png`) });
  await start('Cancel this Mock task.'); await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await page.locator('[data-testid="loop"][data-status="cancelled"]').waitFor();
  await noKoreanChrome('English cancellation');
  await language('ko'); await start('한국어 Mock 결과를 확인해주세요.'); await completed('ko');
  assert.match(await page.getByTestId('final-result').textContent(), /이 내용은 Mock AI가 만든 데모/);
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-mock-ko.png`) });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
  await language('en'); await nav('Connections');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-minimum-window-en.png`) });
  checks.push('Korean Mock preserved; English layout fits minimum 860×640 window');
  await language('ko'); await desktop.close(); desktop = undefined; await launch();
  assert.equal(await page.locator('#app-language').inputValue(), 'ko'); checks.push('Korean preference restored after restart');
  assert.equal(calls, 7); assert.deepEqual(errors, []);
  await page.evaluate(() => localStorage.setItem('seohokim-loop.language','invalid'));
  await page.reload(); await page.locator('#app-language').waitFor(); assert.equal(await page.locator('#app-language').inputValue(),'en');
  await page.evaluate(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function(key,value){if(key==='seohokim-loop.language')throw Error('blocked');return set.call(this,key,value);}; });
  await language('ko');await page.getByText('언어 설정을 저장할 수 없습니다. 이번 실행 동안에는 선택한 언어를 사용합니다.',{exact:true}).waitFor();
  await language('en');await page.getByText('The language preference could not be saved. Your selection will apply for this session.',{exact:true}).waitFor();
  await page.addInitScript(() => { const get = Storage.prototype.getItem; Storage.prototype.getItem = function(key){if(key==='seohokim-loop.language')throw Error('blocked');return get.call(this,key);}; });
  await page.reload(); await page.locator('#app-language').waitFor(); // A fresh mount also survives failed preference reads.
  assert.equal(await page.locator('#app-language').inputValue(),'en'); checks.push('Invalid stored locale and failed writes have a safe, translated fallback');
  await writeFile(path.join(artifacts, `${mode}-smoke.json`), JSON.stringify({ mode, checks, fakeHttpCalls: calls, realAiCalls: 0, errors }, null, 2));
  console.log(JSON.stringify({ mode, checks: checks.length, fakeHttpCalls: calls, realAiCalls: 0, passed: true }));
} finally {
  await desktop?.close(); await vite?.close(); await new Promise(resolve => api.close(resolve));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith('seohokim-language-'));
  await rm(directory, { recursive: true, force: true });
}
