// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { launchDesktop, captureDesktop } from './smoke-window.mjs';
import { fakeLocalCollaboration, fixtureModel, draftText, reviewText, improvedText } from '../tests/fixtures/local-collaboration.ts';

// No live option: injected fake executable and ephemeral local HTTP only.
if (process.argv.includes('--live')) throw new Error('Live execution is not supported');
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const development = process.argv.includes('--dev'); const mode = development ? 'development' : 'production';
const artifacts = path.join(root, 'artifacts/task36'); await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'seohokim-local-pair-desktop-'));
const fake = await fakeLocalCollaboration(profile); const entry = path.join(profile, 'pair-test.cjs');
const exported = path.join(profile, 'result.md');
await writeFile(entry, `const Module=require('node:module'); const load=Module._load;
const {CodexCliProvider}=require(${JSON.stringify(path.join(root, 'dist-electron/electron/providers/codex-cli.js'))});
const {OllamaProvider,fetchLocalOllama}=require(${JSON.stringify(path.join(root, 'dist-electron/electron/providers/ollama.js'))});
const {LoopHistoryStore}=require(${JSON.stringify(path.join(root, 'dist-electron/electron/history-store.js'))});
const {readFile}=require('node:fs/promises');
const http=require('node:http'); const direct=http.request;
http.request=function(options,callback){
 if(options.hostname!=='127.0.0.1'||options.port!==11434)throw Error('Unexpected HTTP destination');
 return direct({...options,port:${fake.port}},callback);
};
const electronRuntime=require('electron'); const testing=Object.create(electronRuntime);
Object.defineProperty(testing,'BrowserWindow',{value:new Proxy(electronRuntime.BrowserWindow,{construct(target,[options]){return new target({...options,width:860,height:640});}})});
electronRuntime.dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(exported)}});
Module._load=function(name,...rest){
 if(name==='electron')return testing;
 if(name==='./providers/codex-cli.js')return {CodexCliProvider:class extends CodexCliProvider{
 constructor(){super(true,{timeoutMs:1800,discover:async()=>({file:${JSON.stringify(process.execPath)},prefix:[${JSON.stringify(path.join(root, 'tests/fixtures/collaboration-cli.mjs'))},${JSON.stringify(fake.scenarioFile)},${JSON.stringify(fake.trace)}]})});}}};
 if(name==='./providers/ollama.js')return {OllamaProvider:class extends OllamaProvider{
 constructor(store){super(store,{timeoutMs:1800,metadataTimeoutMs:1000,installed:async()=>true,fetch:fetchLocalOllama});}}};
 if(name==='./history-store.js')return {LoopHistoryStore:class extends LoopHistoryStore{
 async save(input){if((await readFile(${JSON.stringify(fake.scenarioFile)},'utf8')).trim()==='history-failure')throw Error('Fake storage failure');return super.save(input);}}};
 return load.call(this,name,...rest);
};
require(${JSON.stringify(path.join(root, 'dist-electron/electron/main.cjs'))});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('SEOHOKIM_LOOP_') || /API_KEY|TOKEN/.test(key)) delete env[key];
let desktop; let page; let vite; const checks = []; const errors = [];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitUntil = async check => { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('Fixture readiness timed out'); };
async function launch(enabled) {
  env.SEOHOKIM_LOOP_LOCAL_COLLABORATION = enabled ? '1' : '0';
  desktop = await launchDesktop({ executablePath: electron, args: [entry, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`], cwd: root, env, timeout: 30000 });
  page = await desktop.firstWindow(); page.setDefaultTimeout(15000);
  await desktop.evaluate(() => { globalThis.fetch = async () => { throw Error('External transport forbidden in Fake test'); }; });
  page.on('pageerror', () => errors.push('renderer error'));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:5173/')) errors.push('external renderer request'); });
  await page.locator('#execution-mode').waitFor();
}
const nav = name => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
const start = () => page.getByRole('button', { name: 'Start Loop', exact: true });
const consent = () => page.getByTestId('local-collaboration-notice').getByRole('checkbox');
const loop = () => page.locator('main > div').first().getByTestId('loop');
const final = () => page.locator('main > div').first().getByTestId('final-result');
const completed = async () => { await loop().filter({ has: page.locator('[data-testid="loop-status"]', { hasText: '완료' }) }).waitFor(); await page.locator('[data-testid="history-save"][data-phase="saved"]').waitFor(); };
async function choosePair() {
  await nav('Loop'); await page.locator('#execution-mode').selectOption('collaboration');
  await page.locator('#provider').selectOption('ollama-local'); await page.locator('#reviewer').selectOption('codex-cli-local');
}
async function run(request, scenario = 'success') {
  await fake.scenario(scenario); await choosePair(); await page.locator('#request').fill(request);
  assert.equal(await consent().isChecked(), false); assert.equal(await start().isDisabled(), true);
  await consent().check(); await start().click();
}
async function cleaned() {
  for (const entry of await fake.entries()) if (entry.pid) {
    await waitUntil(async () => !alive(entry.pid) && !await access(entry.cwd).then(() => true, () => false));
  }
}
try {
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  await launch(false); await nav('Connections');
  const ollamaCard = () => page.locator('[data-provider-id="ollama-local"][data-testid="connection-card"]');
  await page.locator('#ollama-model').selectOption(fixtureModel); await ollamaCard().getByRole('button', { name: '모델 선택 저장' }).click();
  await page.locator('[data-provider-id="ollama-local"][data-state="ready"]').waitFor();
  await nav('Loop'); await page.locator('#execution-mode').selectOption('collaboration');
  for (const id of ['ollama-local', 'codex-cli-local']) assert.equal(await page.locator(`#provider option[value="${id}"]`).isDisabled(), true);
  assert.equal((await fake.entries()).length, 0);
  await desktop.close(); await launch(true);
  const prefs = await desktop.evaluate(({ BrowserWindow }) => { const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(); return [p.contextIsolation, p.nodeIntegration, p.sandbox]; });
  assert.deepEqual(prefs, [true, false, true]); assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  checks.push('Default off; explicit unpackaged gate; existing Electron security');
  await page.locator('#request').fill('Fake readiness'); assert.equal(await start().isDisabled(), true);
  const summaries = await page.evaluate(async () => (await window.seohoKimLoop.listProviders()).value);
  for (const id of ['ollama-local', 'codex-cli-local']) { const item = summaries.find(e => e.id === id); assert.equal(item.singleOnly, true); assert.equal(item.experimentalManual, true); }
  const policy = summaries.find(e => e.id === 'ollama-local').modelPolicy; assert.equal(policy.permitted, false); assert.deepEqual(policy.evaluations, []);
  await choosePair(); assert.equal(await page.locator('#provider option[value="codex-cli-local"]').isDisabled(), true);
  assert.equal(await page.locator('#reviewer option[value="ollama-local"]').isDisabled(), true);
  assert.equal(await start().isDisabled(), true); await consent().check();
  await page.locator('#execution-mode').selectOption('single'); await page.locator('#execution-mode').selectOption('collaboration');
  assert.equal(await consent().isChecked(), false);
  await page.getByTestId('local-collaboration-notice').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth || [...document.querySelectorAll('.local-collaboration-notice,.provider-choice')].some(e => e.scrollWidth > e.clientWidth + 1)), false);
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-pair-consent.png`) });
  checks.push('Explicit pair, per-run consent, three-call usage warning, unverified roles, 860x640');
  const request = 'FAKE 두 Provider 협업 공개 자료';
  await run(request); await completed();
  assert.equal(await final().textContent(), improvedText(request));
  assert.deepEqual(await loop().getByTestId('step').evaluateAll(nodes => nodes.map(n => n.dataset.providerId)), ['ollama-local', 'codex-cli-local', 'ollama-local']);
  let entries = await fake.entries(); assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(e => e.data.context), [[], [draftText(request)], [draftText(request), reviewText(request)]]);
  assert.deepEqual(entries.map(e => e.data.final), [false, false, true]);
  assert.equal(await consent().isChecked(), false);
  assert.equal(await page.getByRole('button', { name: '분량 확인', exact: true }).count(), 0);
  const list = await page.evaluate(async () => (await window.seohoKimLoop.listHistory()).value.items);
  const savedId = list.find(e => e.userRequest === request || e.title === request)?.id ?? list[0].id;
  const saved = await page.evaluate(async id => (await window.seohoKimLoop.getHistory(id)).value, savedId);
  assert.equal(saved.finalResult, improvedText(request)); assert.deepEqual(saved.steps.map(s => s.output), [draftText(request), reviewText(request), improvedText(request)]);
  for (const file of await readdir(path.join(profile, 'loop-history'))) assert.equal((await readFile(path.join(profile, 'loop-history', file))).includes(Buffer.from(request)), false);
  await page.getByRole('button', { name: 'Markdown 저장', exact: true }).click(); await page.getByText('파일이 저장되었습니다.', { exact: true }).waitFor();
  assert.equal(await readFile(exported, 'utf8'), improvedText(request));
  await final().scrollIntoViewIfNeeded(); await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-pair-result.png`) });
  await cleaned(); await desktop.close(); await launch(true); await nav('기록');
  await page.locator(`[data-history-id="${savedId}"]`).getByRole('button', { name: '기록 열기' }).click();
  assert.equal(await page.getByTestId('history-detail').getByTestId('final-result').textContent(), improvedText(request));
  assert.deepEqual(await page.evaluate(async id => (await window.seohoKimLoop.getHistory(id)).value, savedId), saved);
  checks.push('Fake HTTP draft → fake CLI JSONL review → fake HTTP improvement; final, encrypted History restart/detail and export');
  for (const [scenario, count] of [['draft-failure', 1], ['review-failure', 2], ['improve-failure', 3], ['draft-hang', 1], ['review-hang', 2], ['improve-hang', 3]]) {
    await run(`FAKE ${scenario}`, scenario); await page.locator('[data-testid="loop"][data-status="failed"]').waitFor();
    assert.equal(await final().count(), 0); assert.equal((await fake.entries()).length, count);
    assert.equal(await loop().getByTestId('step').evaluateAll(nodes => nodes.some(n => n.dataset.retryCount !== '0' || n.dataset.fallbackCount !== '0')), false);
    assert.equal((await page.locator('body').innerText()).includes('private-fixture-secret'), false); await cleaned();
  }
  checks.push('Draft/review/improve failures and both adapter timeouts; no retry/fallback/final output');
  for (const [scenario, count] of [['draft-hang', 1], ['review-hang', 2], ['improve-hang', 3]]) {
    await run(`FAKE cancellation ${scenario}`, scenario);
    await waitUntil(async () => (await fake.entries()).length === count);
    assert.equal(await page.getByRole('button', { name: 'Loop 진행 중' }).isDisabled(), true);
    // Try duplicate submit while busy; the hook/form guards must not send a second run.
    await page.locator('form.request-card').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await page.getByRole('button', { name: '작업 중지', exact: true }).click();
    await page.locator('[data-testid="loop"][data-status="cancelled"]').waitFor();
    await cleaned(); assert.equal((await fake.entries()).length, count); assert.equal(await final().count(), 0);
  }
  assert.ok(fake.aborted >= 2); checks.push('Cancellation at all three stages; duplicate Start blocked; owned CLI/HTTP cleaned');
  await run('FAKE History 실패에도 개선 보존', 'history-failure');
  await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
  await page.locator('[data-testid="history-save"][data-phase="failed"]').waitFor();
  assert.equal(await final().textContent(), improvedText('FAKE History 실패에도 개선 보존'));
  assert.equal((await fake.entries()).length, 3);
  await fake.scenario('success'); await page.getByRole('button', { name: '다시 저장', exact: true }).click(); await completed();
  assert.equal((await fake.entries()).length, 0); checks.push('History failure keeps completed/final; resave generates nothing');
  for (const id of ['mock', 'ollama-local', 'codex-cli-local']) {
    await fake.scenario('success'); await nav('Loop'); await page.locator('#execution-mode').selectOption('single');
    await page.locator('#provider').selectOption(id); await page.locator('#request').fill('최소 1자로 작성해줘.');
    await start().click(); await completed();
    assert.equal((await fake.entries()).length, id === 'mock' ? 0 : 1);
    await page.getByRole('button', { name: '분량 확인', exact: true }).click(); await page.getByText('분량 조건 충족', { exact: true }).waitFor();
  }
  await nav('Connections'); assert.equal(await page.getByTestId('connection-card').count(), 5);
  assert.ok((await ollamaCard().innerText()).includes('실험적 초안·개선'));
  assert.ok((await page.locator('[data-provider-id="codex-cli-local"][data-testid="connection-card"]').innerText()).includes('실험적 검토'));
  assert.ok((await ollamaCard().innerText()).includes('Auto 참여: 추가 검증 필요'));
  checks.push('Existing Mock/Codex/Ollama Single, length diagnosis, Connections and Auto ineligibility preserved');
  assert.deepEqual(errors, []); await cleaned();
  await writeFile(path.join(artifacts, `${mode}-pair.json`), JSON.stringify({ passed: true, mode, checks, realModelRequests: 0, fakeOnly: true }, null, 2));
  console.log(`${mode}: ${checks.length} fake collaboration check groups passed; real models 0`);
} finally {
  await desktop?.close(); await vite?.close(); await fake.close();
  assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith('seohokim-local-pair-desktop-'));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
