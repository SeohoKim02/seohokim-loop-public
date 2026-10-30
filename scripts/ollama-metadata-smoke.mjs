// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

// Actual installed metadata only. Every generation endpoint is blocked before
// transport. No approval to generate, no live smoke flag, no model downloads.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { launchDesktop, captureDesktop } from './smoke-window.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const development = process.argv.includes('--dev');
const mode = development ? 'development' : 'production';
const profile = await mkdtemp(path.join(tmpdir(), 'seohokim-metadata-only-'));
const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
const entry = path.join(profile, 'metadata-only.cjs');
const model = 'qwen3:4b-instruct-2507-q4_K_M';
await writeFile(entry, `const http=require('node:http'); const original=http.request;
globalThis.metadataObservation={paths:[],blocked:0};
http.request=function(options,callback){
 const observation=globalThis.metadataObservation;
 if(options.hostname!=='127.0.0.1'||options.port!==11434||!['/api/version','/api/tags','/api/show'].includes(options.path)){
  observation.blocked++;throw Error('Metadata-only verification: request forbidden');
 }
 observation.paths.push(options.path);return original.call(this,options,callback);
};
globalThis.fetch=async()=>{globalThis.metadataObservation.blocked++;throw Error('External fetch forbidden');};
const electron=require('electron');const Module=require('node:module');const load=Module._load;
const testing=Object.create(electron);
Object.defineProperty(testing,'BrowserWindow',{value:new Proxy(electron.BrowserWindow,{construct(target,[options]){return new target({...options,width:860,height:640});}})});
Module._load=function(name,...args){return name==='electron'?testing:load.call(this,name,...args);};
require(${JSON.stringify(path.join(root, 'dist-electron/electron/main.cjs'))});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('SEOHOKIM_LOOP_') || /API_KEY/.test(key)) delete env[key];
let desktop; let vite;
try {
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  desktop = await launchDesktop({ executablePath: electron, args: [entry, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`], cwd: root, env, timeout: 30000 });
  const page = await desktop.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', () => errors.push('pageerror'));
  const nav = (name) => page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name, exact: true }).click();
  await nav('Connections');
  const card = page.locator('[data-provider-id="ollama-local"]');
  await page.locator('[data-provider-id="ollama-local"][data-state="select_model"]').waitFor();
  await page.locator('#ollama-model').selectOption(model);
  await card.getByRole('button', { name: '모델 선택 저장', exact: true }).click();
  await page.locator('[data-provider-id="ollama-local"][data-state="ready"]').waitFor();
  const reply = await page.evaluate(() => window.seohoKimLoop.listProviders()); assert.equal(reply.ok, true);
  const provider = reply.value.find((item) => item.id === 'ollama-local');
  const metadata = provider.modelPolicy.model;
  assert.equal(provider.singleOnly, true); assert.equal(provider.configured, true);
  assert.equal(metadata.identity.modelId, model); assert.match(metadata.identity.digest, /^[a-f0-9]{64}$/);
  assert.equal(metadata.identity.runtimeVersion, '0.40.8'); assert.equal(metadata.local, true);
  assert.ok(metadata.capabilities.includes('completion')); assert.deepEqual(provider.modelPolicy.evaluations, []);
  assert.equal(provider.modelPolicy.permitted, false);
  assert.ok((await card.getByTestId('local-model-qualification').innerText()).includes('Auto 참여: 추가 검증 필요'));
  assert.ok((await card.getByTestId('local-model-qualification').innerText()).includes('검증된 Auto 역할: 아직 없음'));
  await card.getByTestId('local-model-qualification').scrollIntoViewIfNeeded();
  await captureDesktop(desktop, page, { path: path.join(artifacts, `task25-actual-metadata-${mode}.png`) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('.connection-card')].some((node) => node.scrollWidth > node.clientWidth + 1)), false);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await nav('Loop'); await page.locator('#request').fill('실행하지 않는 UI 확인');
  assert.equal(await page.getByRole('button', { name: 'Start Loop', exact: true }).isDisabled(), true);
  await page.locator('#execution-mode').selectOption('single'); await page.locator('#provider').selectOption(provider.id);
  assert.equal(await page.getByRole('button', { name: 'Start Loop', exact: true }).isEnabled(), true);
  // Deliberately never click Start Loop.
  const observation = await desktop.evaluate(() => globalThis.metadataObservation);
  assert.equal(observation.blocked, 0); assert.ok(observation.paths.includes('/api/show'));
  assert.ok(observation.paths.every((route) => ['/api/version', '/api/tags', '/api/show'].includes(route)));
  assert.deepEqual(errors, []);
  const result = { mode, result: 'PASS', metadata, realModelRequests: 0, externalAiRequests: 0,
    autoExcluded: true, singleSelectable: true, qualityVerified: false, metadataRequests: observation.paths.length, minimumLayout: true };
  await writeFile(path.join(artifacts, `task25-actual-metadata-${mode}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await desktop?.close(); await vite?.close();
  assert.equal(path.dirname(profile), path.resolve(tmpdir()));
  assert.ok(path.basename(profile).startsWith('seohokim-metadata-only-'));
  await rm(profile, { recursive: true, force: true });
}
