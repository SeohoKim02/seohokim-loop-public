// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

// Local fake HTTP server only. Never installs Ollama, downloads models or calls an external AI.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { launchDesktop, captureDesktop } from './smoke-window.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const development = process.argv.includes('--dev');
const mode = development ? 'development' : 'production';
const profile = await mkdtemp(path.join(tmpdir(), 'seohokim-ollama-desktop-'));
const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
const scenarioFile = path.join(profile, 'scenario'); await writeFile(scenarioFile, 'not_installed');
const model = 'local-text:latest'; const model2 = 'second-text:q4';
let scenario = 'not_installed'; let chatCalls = 0; let aborted = 0; let externalRequests = 0; let serverRequests = 0;
let digest = 'a'.repeat(64);
const modelEntry = (name) => ({ name, model: name, size: 1024, digest, details: { format: 'gguf' } });
const server = createServer(async (req, res) => {
  serverRequests++;
  try {
    assert.equal(req.headers.authorization, undefined);
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    res.setHeader('content-type', 'application/json');
    const reply = (value) => res.end(JSON.stringify(value));
    if (req.url === '/api/version') return reply(scenario === 'invalid' ? { invalid: true } : { version: '0.34.0' });
    if (req.url === '/api/tags') return reply({ models: scenario === 'no_models' ? [] : [modelEntry(model), modelEntry(model2), modelEntry('remote:cloud'), modelEntry('remote-alias')] });
    if (req.url === '/api/show') return reply({ details: { format: 'gguf', parameter_size: '4.0B', quantization_level: 'Q4_K_M' }, model_info: { architecture: 'test', 'test.context_length': 4096 }, capabilities: ['completion'],
      ...(body.model === 'remote-alias' ? { remote_model: 'large', remote_host: 'https://remote.invalid' } : {}) });
    assert.equal(req.url, '/api/chat'); chatCalls++;
    assert.ok([model, model2].includes(body.model)); assert.equal(body.stream, false); assert.equal(body.tools, undefined);
    if (scenario === 'hang') { res.on('close', () => { if (!res.writableEnded) aborted++; }); return; }
    if (scenario === 'http') { res.statusCode = 500; return reply({ error: 'private-secret' }); }
    return reply({ model: body.model, done: true, done_reason: scenario === 'truncated' ? 'length' : 'stop', message: { role: 'assistant', content: 'LOOP_OK' } });
  } catch { res.statusCode = 500; res.end('{}'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const entry = path.join(profile, 'ollama-test.cjs');
await writeFile(entry, `const Module=require('node:module'); const load=Module._load;
const {OllamaProvider,fetchLocalOllama}=require(${JSON.stringify(path.join(root, 'dist-electron/electron/providers/ollama.js'))});
const http=require('node:http'); const directRequest=http.request;
http.request=function(options,callback){
 if(options.hostname!=='127.0.0.1'||options.port!==11434)throw Error('Unexpected test destination');
 return directRequest({...options,port:${server.address().port}},callback);
};
const {readFile}=require('node:fs/promises');
const electron=require('electron'); const testing=Object.create(electron);
Object.defineProperty(testing,'BrowserWindow',{value:new Proxy(electron.BrowserWindow,{construct(target,[options]){return new target({...options,width:860,height:640});}})});
Module._load=function(name,...rest){
 if(name==='electron')return testing;
 if(name==='./providers/ollama.js')return {OllamaProvider:class extends OllamaProvider{
 constructor(store){super(store,{timeoutMs:2000,metadataTimeoutMs:1000,
 installed:async()=> (await readFile(${JSON.stringify(scenarioFile)},'utf8'))!=='not_installed',
 fetch:async(url,init)=>{
  if(!String(url).startsWith('http://127.0.0.1:11434/api/'))throw Error('External request forbidden');
  const state=await readFile(${JSON.stringify(scenarioFile)},'utf8');
  if(['not_installed','stopped'].includes(state))throw Error('Offline test');
  return fetchLocalOllama(url,init);
 }});}}};
 return load.call(this,name,...rest);
};
require(${JSON.stringify(path.join(root, 'dist-electron/electron/main.cjs'))});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('SEOHOKIM_LOOP_') || /API_KEY/.test(key)) delete env[key];
let desktop; let vite; let page;
const errors = [];
async function launch() {
  desktop = await launchDesktop({ executablePath: electron, args: [entry, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`], cwd: root, env, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', () => errors.push('pageerror'));
  page.on('request', (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:5173/') && request.url() !== base + '/csp-probe') externalRequests++; });
  await page.locator('#execution-mode').waitFor();
}
const nav = async (name) => page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name, exact: true }).click();
const card = () => page.locator('[data-provider-id="ollama-local"]');
async function state(value, expected) {
  scenario = value; await writeFile(scenarioFile, value);
  await nav('Connections'); await card().getByRole('button', { name: '연결 확인', exact: true }).click();
  await page.getByRole('button', { name: '새로고침', exact: true }).waitFor();
  await page.locator(`[data-provider-id="ollama-local"][data-state="${expected}"]`).waitFor();
}
async function start(text) {
  await nav('Loop'); await page.locator('#execution-mode').selectOption('single');
  await page.locator('#provider').selectOption('ollama-local'); await page.locator('#request').fill(text);
  await page.getByRole('button', { name: 'Start Loop', exact: true }).click();
}
try {
  new Script(await readFile(entry, 'utf8'), { filename: entry });
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  await launch(); await nav('Connections');
  await page.locator('[data-provider-id="ollama-local"][data-state="not_installed"]').waitFor();
  assert.equal(await page.getByTestId('connection-card').count(), 5); assert.equal(await card().locator('input').count(), 0);
  await state('stopped', 'stopped'); await state('invalid', 'failed'); await state('no_models', 'no_models'); await state('ready', 'select_model');
  assert.deepEqual(await page.locator('#ollama-model option').evaluateAll((nodes) => nodes.map((node) => node.value)), ['', model, model2]);
  assert.equal(chatCalls, 0);
  assert.ok((await card().getByTestId('local-model-qualification').innerText()).includes('Auto 참여: 추가 검증 필요'));
  const beforeProbe = serverRequests;
  assert.equal(await page.evaluate(async (url) => { try { await fetch(url); return false; } catch { return true; } }, base + '/csp-probe'), true);
  assert.equal(serverRequests, beforeProbe, 'Renderer must not reach a different local port.');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const security = await desktop.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, sandbox: prefs.sandbox };
  });
  assert.deepEqual(security, { contextIsolation: true, nodeIntegration: false, sandbox: true });
  const hostile = await page.evaluate(() => window.seohoKimLoop.selectOllamaModel({ model: 'local-text:latest', url: 'https://remote.invalid' })); assert.equal(hostile.ok, false);
  await page.locator('#ollama-model').selectOption(model);
  await card().getByRole('button', { name: '모델 선택 저장', exact: true }).click();
  await page.locator('[data-provider-id="ollama-local"][data-state="ready"]').waitFor();
  assert.equal(chatCalls, 0);
  assert.ok((await card().getByTestId('local-model-qualification').innerText()).includes('4.0B · Q4_K_M · gguf'));
  const firstPolicy = await page.evaluate(async () => (await window.seohoKimLoop.listProviders()).value.find((entry) => entry.id === 'ollama-local').modelPolicy);
  assert.equal(firstPolicy.model.identity.digest, digest); assert.deepEqual(firstPolicy.evaluations, []); assert.equal(firstPolicy.permitted, false);
  digest = 'b'.repeat(64); await state('ready', 'ready');
  const changedPolicy = await page.evaluate(async () => (await window.seohoKimLoop.listProviders()).value.find((entry) => entry.id === 'ollama-local').modelPolicy);
  assert.equal(changedPolicy.model.identity.digest, digest); assert.deepEqual(changedPolicy.evaluations, []);
  assert.equal(chatCalls, 0);
  await card().scrollIntoViewIfNeeded();
  await card().getByTestId('local-model-qualification').scrollIntoViewIfNeeded();
  await captureDesktop(desktop, page, { path: path.join(artifacts, `task25-${mode}-connections.png`) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('.connection-card')].some((node) => node.scrollWidth > node.clientWidth + 1)), false);
  await nav('Loop'); await page.locator('#request').fill('LOOP_OK local test');
  assert.equal(await page.getByRole('button', { name: 'Start Loop', exact: true }).isDisabled(), true, 'Local-only provider must not enable Auto.');
  await page.locator('#execution-mode').selectOption('collaboration');
  assert.equal(await page.locator('#provider option[value="ollama-local"]').isDisabled(), true);
  await start('LOOP_OK local test');
  await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
  assert.equal((await page.locator('.final-output').innerText()).trim(), 'LOOP_OK');
  await page.locator('[data-testid="history-save"][data-phase="saved"]').waitFor();
  await nav('기록'); await page.getByRole('button', { name: '기록 열기', exact: true }).click();
  assert.equal(await page.getByTestId('history-detail').getByTestId('final-result').textContent(), 'LOOP_OK');
  await page.getByTestId('history-detail').getByTestId('final-result').scrollIntoViewIfNeeded();
  await captureDesktop(desktop, page, { path: path.join(artifacts, `task23-${mode}-history.png`) });
  await desktop.close(); desktop = undefined;
  await launch(); await nav('Connections');
  await page.locator('[data-provider-id="ollama-local"][data-state="ready"]').waitFor();
  assert.equal(await page.locator('#ollama-model').inputValue(), model);
  await nav('기록'); await page.getByRole('button', { name: '기록 열기', exact: true }).click();
  assert.equal(await page.getByTestId('history-detail').getByTestId('final-result').textContent(), 'LOOP_OK');
  for (const failure of ['http', 'truncated', 'hang']) {
    scenario = failure; await writeFile(scenarioFile, failure); await start(`failure ${failure}`);
    await page.locator('[data-testid="loop"][data-status="failed"]').waitFor();
    assert.equal(await page.locator('.final-output').count(), 0);
  }
  const callsBefore = chatCalls; await start('cancel local task');
  for (let n = 0; n < 100 && chatCalls === callsBefore; n++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(chatCalls, callsBefore + 1);
  await page.getByRole('button', { name: '작업 중지', exact: true }).click();
  await page.locator('[data-testid="loop"][data-status="cancelled"]').waitFor();
  assert.equal(await page.locator('.final-output').count(), 0);
  for (let n = 0; n < 100 && aborted < 2; n++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(aborted >= 2); assert.equal(externalRequests, 0); assert.deepEqual(errors, []);
  assert.ok(!(await page.locator('body').innerText()).includes('private-secret'));
  const configuration = JSON.parse(await readFile(path.join(profile, 'ollama-local.json'), 'utf8'));
  assert.deepEqual(configuration, { version: 1, model });
  console.log(JSON.stringify({ mode, result: 'PASS', localFakeChatCalls: chatCalls, externalAiRequests: 0, modelsRestored: true,
    singleCompleted: true, finalResult: 'LOOP_OK', historyRestored: true, cancellation: true, timeout: true, minimumLayout: true }));
} finally {
  await desktop?.close(); await vite?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(profile), path.resolve(tmpdir()));
  assert.ok(path.basename(profile).startsWith('seohokim-ollama-desktop-'));
  await rm(profile, { recursive: true, force: true });
}
