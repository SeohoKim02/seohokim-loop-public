// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { launchDesktop, captureDesktop } from './smoke-window.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const development = process.argv.includes('--dev');
const mode = `codex-${development ? 'development' : 'production'}`;
const profile = await mkdtemp(path.join(tmpdir(), 'seohokim-codex-desktop-'));
const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
const scenarioFile = path.join(profile, 'scenario'); const marker = path.join(profile, 'owned-pids.json');
const output = path.join(profile, 'result.md'); const entry = path.join(profile, 'codex-test.cjs');
await writeFile(scenarioFile, 'startup-warning');
// Test-only dependency injection before loading main. Production accepts no fake CLI path/env hook.
await writeFile(entry, `const Module=require('node:module');
const original=Module._load;
const cliFile=${JSON.stringify(path.join(root, 'dist-electron/electron/providers/codex-cli.js'))};
const {CodexCliProvider}=require(cliFile);
const {readFile}=require('node:fs/promises');
const electronRuntime=require('electron');
const {dialog}=electronRuntime;
// Hidden Windows handles do not reliably resize after creation. Start at the
// product minimum and assert the real renderer viewport before capturing it.
const minimumElectron=Object.create(electronRuntime);
Object.defineProperty(minimumElectron,'BrowserWindow',{value:new Proxy(electronRuntime.BrowserWindow,{
 construct(target,[options]){return new target({...options,width:860,height:640});}
})});
dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(output)}});
Module._load=function(name,parent,...rest){
 if(name==='electron')return minimumElectron;
 if(name==='./providers/codex-cli.js')return {CodexCliProvider:class extends CodexCliProvider{
  constructor(){super(true,{timeoutMs:2000,discover:async()=>({file:${JSON.stringify(process.execPath)},prefix:[${JSON.stringify(path.join(root, 'tests/fixtures/codex-cli.mjs'))},(await readFile(${JSON.stringify(scenarioFile)},'utf8')).trim(),${JSON.stringify(marker)}]})});}
 }};
 return original.call(this,name,parent,...rest);
};
require(${JSON.stringify(path.join(root, 'dist-electron/electron/main.cjs'))});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('SEOHOKIM_LOOP_')) delete env[key];
let desktop; let vite;
const errors = [];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  desktop = await launchDesktop({ executablePath: electron, args: [entry, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`], cwd: root, env, timeout: 30_000 });
  const page = await desktop.firstWindow();
  page.on('pageerror', () => errors.push('pageerror'));
  page.on('console', (message) => { if (message.type() === 'error') errors.push('console'); });
  const nav = page.getByRole('navigation', { name: '주 메뉴' });
  const show = (name) => nav.getByRole('button', { name, exact: true }).click();
  await page.locator('#execution-mode').waitFor();
  await show('Connections');
  const card = page.locator('[data-testid="connection-card"][data-provider-id="codex-cli-local"]');
  await card.getByText('CLI 버전: 0.160.1', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('connection-card').count(), 5);
  assert.equal(await card.locator('input').count(), 0);
  assert.ok((await card.innerText()).includes('미검증 (모델 호출 없음)'));
  // Windows rounds native bounds by up to two pixels at this display scale.
  await page.waitForFunction(() => innerWidth >= 850 && innerWidth <= 862 && innerHeight <= 642);
  console.log('Minimum viewport', await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  await card.scrollIntoViewIfNeeded();
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-connections.png`) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth
    || [...document.querySelectorAll('.connection-card')].some((e) => e.scrollWidth > e.clientWidth + 1)), false);
  await show('Loop');
  await page.locator('#request').fill('공개 가능한 테스트: LOOP_OK');
  assert.equal(await page.getByRole('button', { name: 'Start Loop' }).isDisabled(), true, 'CLI alone must not enable Auto.');
  await page.locator('#execution-mode').selectOption('collaboration');
  assert.equal(await page.locator('#provider option[value="codex-cli-local"]').isDisabled(), true);
  assert.equal(await page.locator('#reviewer option[value="codex-cli-local"]').isDisabled(), true);
  await page.locator('#execution-mode').selectOption('single');
  await page.locator('#provider').selectOption('codex-cli-local');
  await page.getByRole('button', { name: 'Start Loop' }).click();
  await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
  assert.equal((await page.locator('.final-output').innerText()).trim(), 'LOOP_OK');
  await page.locator('[data-testid="history-save"][data-phase="saved"]').waitFor();
  await page.getByRole('button', { name: 'Markdown 저장', exact: true }).click();
  await page.getByText('파일이 저장되었습니다.', { exact: true }).waitFor();
  assert.equal(await readFile(output, 'utf8'), 'LOOP_OK');
  await show('기록'); await page.getByTestId('history').getByText('공개 가능한 테스트: LOOP_OK', { exact: true }).first().waitFor();
  await show('Loop');
  await writeFile(scenarioFile, 'early-chunks');
  await page.locator('#request').fill('분할 JSONL 테스트: LOOP_OK');
  await page.getByRole('button', { name: 'Start Loop' }).click();
  await page.locator('[data-testid="loop"][data-status="running"]').waitFor();
  await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
  assert.equal((await page.locator('.final-output').innerText()).trim(), 'LOOP_OK');
  await page.locator('[data-testid="history-save"][data-phase="saved"]').waitFor();
  await show('기록'); await page.getByTestId('history').getByText('분할 JSONL 테스트: LOOP_OK', { exact: true }).first().waitFor();
  await show('Loop');
  for (const scenario of ['bad-config', 'bad-option', 'probe-exit', 'usage', 'model', 'auth', 'truncated', 'turn-failed-zero', 'error-zero', 'success-exit-one', 'hang']) {
    await writeFile(scenarioFile, scenario);
    await page.getByRole('button', { name: 'Start Loop' }).click();
    await page.locator('[data-testid="loop"][data-status="running"]').waitFor();
    await page.locator('[data-testid="loop"][data-status="failed"]').waitFor();
    if (scenario === 'hang') assert.match(await page.getByTestId('loop').innerText(), /TIMEOUT/);
    assert.equal(await page.getByTestId('final-result').count(), 0);
    assert.ok(!(await page.locator('body').innerText()).includes('private-credential'));
  }
  await rm(marker, { force: true });
  await writeFile(scenarioFile, 'tree');
  await page.getByRole('button', { name: 'Start Loop' }).click();
  let owned;
  for (let n = 0; n < 200; n++) {
    try { owned = JSON.parse(await readFile(marker, 'utf8')); break; } catch { await new Promise((r) => setTimeout(r, 25)); }
  }
  assert.ok(owned?.child);
  await show('Connections'); await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.locator('[data-provider-id="codex-cli-local"][data-state="running"]').waitFor();
  await show('Loop'); await page.getByRole('button', { name: '작업 중지', exact: true }).click();
  await page.locator('[data-testid="loop"][data-status="cancelled"]').waitFor();
  for (let n = 0; n < 100 && (alive(owned.pid) || alive(owned.child)); n++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(owned.pid), false); assert.equal(alive(owned.child), false);
  await writeFile(scenarioFile, 'success');
  await show('Connections'); await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.locator('[data-provider-id="codex-cli-local"][data-state="ready"]').waitFor();
  for (const [scenario, state, message] of [
    ['bad-config', 'failed', 'Codex 설정을 확인할 수 없습니다.'],
    ['bad-option', 'failed', '현재 Codex CLI에서 실행 옵션을 사용할 수 없습니다.'],
    ['logged-out', 'login_required', 'ChatGPT 로그인이 필요합니다.'],
  ]) {
    await writeFile(scenarioFile, scenario);
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.locator(`[data-provider-id="codex-cli-local"][data-state="${state}"]`).waitFor();
    // Two different errors share data-state=failed; wait for the new message,
    // not the previous failed state while refresh is still in flight.
    await card.getByText(message, { exact: false }).waitFor();
    assert.ok(!(await card.innerText()).includes('private-credential'));
  }
  await writeFile(scenarioFile, 'success');
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.locator('[data-provider-id="codex-cli-local"][data-state="ready"]').waitFor();
  await show('Loop'); await page.getByRole('button', { name: 'Start Loop' }).click();
  await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
  await page.locator('[data-testid="history-save"][data-phase="saved"]').waitFor();
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-result.png`) });
  const summary = await page.evaluate(() => window.seohoKimLoop.listProviders());
  assert.doesNotMatch(JSON.stringify(summary), /private-credential|auth.json|\.exe/);
  assert.deepEqual(errors, []);
  console.log(`PASS: ${mode}: signed-in fixture, recorded startup warning and early split UTF-8 JSONL, exact Single result, History, export, eleven failures including timeout, owned tree cancellation, configuration/login recovery, rerun, minimum layout. No real model calls.`);
} finally { await desktop?.close(); await vite?.close(); await rm(profile, { recursive: true, force: true }); }
