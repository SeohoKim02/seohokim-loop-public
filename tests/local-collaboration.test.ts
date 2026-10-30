// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexCliProvider } from '../electron/providers/codex-cli.ts';
import { OllamaProvider, OLLAMA_ORIGIN } from '../electron/providers/ollama.ts';
import { ProviderRuntime, localManualExperimentEnabled } from '../electron/provider-runtime.ts';
import { createProviderGateway } from '../electron/provider-gateway.ts';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import type { ProviderConnection } from '../src/providers/provider-registry.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { DraftReviewImprove } from '../src/application/draft-review-improve.ts';
import { manualCollaborationPolicy, localManualCandidate } from '../src/application/manual-collaboration-policy.ts';
import { roleEligibility } from '../src/application/role-eligibility.ts';
import { modelQualityState } from '../src/application/model-quality.ts';
import { autoProviderPool, selectAlternativeProvider } from '../src/application/auto-router.ts';
import { modelRoles } from '../src/providers/model-capability.ts';
import { historySnapshot } from '../src/domain/loop-history.ts';
import { saveCompletedHistory } from '../src/application/save-history.ts';
import type { HistoryBridge } from '../src/application/history-ipc.ts';
import type { Loop } from '../src/domain/loop.ts';
import type { ProviderExecution } from '../src/providers/provider-ipc.ts';
import { fakeLocalCollaboration, fixtureModel, draftText, reviewText, improvedText } from './fixtures/local-collaboration.ts';

const primary: ProviderConnection = { id: 'ollama-local', displayName: 'Ollama', type: 'local-ollama', configured: true, supportsConnectionCheck: false, singleOnly: true, experimentalManual: true };
const reviewer: ProviderConnection = { ...primary, id: 'codex-cli-local', displayName: 'Codex CLI', type: 'local-cli' };
for (const packaged of [true, false]) for (const flag of [undefined, '', '0', 'true', '1']) test(`experiment gate: packaged=${packaged}, flag=${flag}`, () => {
  assert.equal(localManualExperimentEnabled(packaged, { SEOHOKIM_LOOP_LOCAL_COLLABORATION: flag }), !packaged && flag === '1');
});
test('only explicitly flagged primary Ollama and reviewer Codex permit the experiment', () => {
  assert.deepEqual(manualCollaborationPolicy(primary, reviewer), { allowed: true, experimental: true });
  assert.equal(localManualCandidate(primary, 'reviewer'), false); assert.equal(localManualCandidate(reviewer, 'primary'), false);
});
for (const [label, p, r] of [
  ['reverse', reviewer, primary], ['same', primary, primary], ['missing', primary, undefined],
  ['disabled primary', { ...primary, configured: false }, reviewer], ['disabled reviewer', primary, { ...reviewer, configured: false }],
  ['no primary grant', { ...primary, experimentalManual: undefined }, reviewer], ['no reviewer grant', primary, { ...reviewer, experimentalManual: undefined }],
  ['wrong type', { ...primary, type: 'openai-compatible' }, reviewer], ['wrong id', primary, { ...reviewer, id: 'anthropic' }],
  ['mix API', primary, { ...reviewer, id: 'anthropic', type: 'anthropic', singleOnly: false }],
] as const) test(`manual experiment rejects ${label}`, () => assert.equal(manualCollaborationPolicy(p, r).allowed, false));
test('legacy manual API policy is unchanged', () => {
  assert.deepEqual(manualCollaborationPolicy({ ...primary, singleOnly: false }, { ...reviewer, singleOnly: false }), { allowed: true, experimental: false });
});

async function setup(timeoutMs = 1200, enabled = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'seohokim-local-pair-test-'));
  const fake = await fakeLocalCollaboration(directory);
  const cli = new CodexCliProvider(true, { timeoutMs, environment: { ...process.env, OPENAI_API_KEY: 'private-fixture-secret' },
    discover: async () => ({ file: process.execPath, prefix: [path.resolve('tests/fixtures/collaboration-cli.mjs'), fake.scenarioFile, fake.trace] }) });
  const ollama = new OllamaProvider({ read: async () => fixtureModel, save: async () => {} }, { timeoutMs, installed: async () => true,
    fetch: async (url, init) => {
      assert.equal(new URL(String(url)).origin, OLLAMA_ORIGIN); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
      return fetch(String(url).replace(OLLAMA_ORIGIN, `http://127.0.0.1:${fake.port}`), init);
    } });
  const runtime = new ProviderRuntime({}, { read: async () => undefined, save: async () => {}, remove: async () => {} }, undefined, cli, ollama, enabled);
  await runtime.initialize();
  const gateway = createProviderGateway(runtime.registry, runtime); const calls: ProviderExecution[] = [];
  const bridge = { ...gateway, executeProvider: async (execution: ProviderExecution) => { calls.push(execution); return gateway.executeProvider(execution); } };
  const registry = new ProviderRegistry();
  for (const summary of runtime.registry.list()) registry.register(new IpcProvider(summary, bridge), summary);
  const service = new LoopService(new DraftReviewImprove(primary.id, reviewer.id), registry);
  return { fake, cli, ollama, runtime, registry, gateway, service, calls,
    async close() { gateway.dispose(); await cli.close(); ollama.close(); await fake.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); } };
}
async function waitUntil(check: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Fixture readiness timed out');
}
test('real adapters + fake process/HTTP pass ordered context through gateway, exact three calls and one Loop ID', async () => {
  const f = await setup();
  try {
    for (const request of ['첫 Loop 공개 자료', '두 번째 Loop 독립 자료']) {
      await f.fake.scenario('success'); f.calls.length = 0;
      const snapshots: Loop[] = []; const initial = f.service.create(request);
      const result = await f.service.run(initial, loop => snapshots.push(loop));
      assert.equal(result.status, 'completed'); assert.equal(result.finalResult, improvedText(request));
      const entries = await f.fake.entries(); assert.equal(entries.length, 3);
      assert.deepEqual(entries.map(e => e.provider), [primary.id, reviewer.id, primary.id]);
      assert.deepEqual(entries.map(e => e.data.context), [[], [draftText(request)], [draftText(request), reviewText(request)]]);
      assert.deepEqual(entries.map(e => e.data.final), [false, false, true]);
      assert.ok(entries.every(e => e.data.request === request)); assert.match(entries[1]!.data.step, /検討|검토/);
      assert.equal(f.calls.length, 3); assert.ok(f.calls.every(call => call.executionId === initial.id));
      assert.ok(snapshots.every(loop => loop.id === initial.id && loop.steps.filter(s => s.status === 'running').length <= 1));
      assert.ok(snapshots.filter(l => l.status !== 'completed').every(l => l.finalResult === undefined));
      assert.deepEqual(result.steps.map(s => s.output), [draftText(request), reviewText(request), improvedText(request)]);
      const history = historySnapshot(result); assert.equal(history.finalResult, result.finalResult);
      assert.doesNotMatch(JSON.stringify([result, history, f.calls]), /private-fixture-secret|apiKey|Authorization/);
      const cliTrace = entries[1]!; assert.equal(await access(cliTrace.cwd!).then(() => true, () => false), false);
      assert.throws(() => process.kill(cliTrace.pid!, 0));
    }
    assert.equal(f.cli.running, false);
  } finally { await f.close(); }
});
test('registry grants do not alter Single flags, role quality, Auto pool or fallback', async () => {
  const f = await setup();
  try {
    const entries = f.runtime.registry.list();
    for (const id of [primary.id, reviewer.id]) {
      const entry = entries.find(e => e.id === id)!;
      assert.equal(entry.singleOnly, true); assert.equal(entry.experimentalManual, true);
      for (const role of modelRoles) assert.equal(roleEligibility(entry, role).eligible, false);
    }
    const policy = f.ollama.modelPolicy;
    assert.equal(policy.permitted, false); assert.deepEqual(policy.evaluations, []);
    for (const role of modelRoles) assert.equal(modelQualityState(policy.model, role, policy.evaluations), 'not_evaluated');
    assert.throws(() => autoProviderPool(f.registry)); assert.equal(selectAlternativeProvider(f.registry, primary.id), undefined);
  } finally { await f.close(); }
});
test('runtime defaults leave both local adapters Single only', async () => {
  const f = await setup(1200, false);
  try { assert.ok(f.runtime.registry.list().filter(e => e.singleOnly).every(e => !e.experimentalManual)); }
  finally { await f.close(); }
});
for (const [scenario, count, index] of [['draft-failure', 1, 0], ['review-failure', 2, 1], ['improve-failure', 3, 2]] as const) test(`${scenario}: stop with no retry, fallback or Final Result`, async () => {
  const f = await setup();
  try {
    await f.fake.scenario(scenario); const result = await f.service.run(f.service.create('공개 실패 검증'));
    assert.equal(result.status, 'failed'); assert.equal(result.steps[index]!.status, 'failed'); assert.equal(result.finalResult, undefined);
    assert.equal((await f.fake.entries()).length, count); assert.equal(f.calls.length, count);
    assert.ok(result.steps.slice(index + 1).every(s => s.status === 'pending')); assert.doesNotMatch(result.error!, /private-fixture-secret/);
    assert.ok(result.steps.every(s => !s.retryCount && !s.fallbackCount));
  } finally { await f.close(); }
});
for (const [scenario, count] of [['draft-hang', 1], ['review-hang', 2], ['improve-hang', 3]] as const) test(`${scenario}: cancellation owns only active request and prevents subsequent calls`, async () => {
  const f = await setup(5000);
  try {
    await f.fake.scenario(scenario); const controller = new AbortController();
    const initial = f.service.create('공개 취소 검증'); const snapshots: Loop[] = [];
    const pending = f.service.run(initial, loop => snapshots.push(loop), { signal: controller.signal });
    await waitUntil(async () => (await f.fake.entries()).length === count);
    await assert.rejects(f.service.run(f.service.create('중복 요청')));
    controller.abort(); const result = await pending;
    assert.equal(result.status, 'cancelled'); assert.equal(result.finalResult, undefined); assert.equal(f.calls.length, count);
    const saved = JSON.stringify(result); const size = snapshots.length;
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(JSON.stringify(result), saved); assert.equal(snapshots.length, size);
    if (scenario !== 'review-hang') await waitUntil(async () => f.fake.aborted > 0);
    // Cancellation settles the Loop first; process close and owned-directory cleanup
    // are asynchronous. Verify actual bounded cleanup before starting another run.
    await waitUntil(async () => !f.cli.pending);
    for (const entry of await f.fake.entries()) if (entry.pid) { assert.throws(() => process.kill(entry.pid!, 0)); assert.equal(await access(entry.cwd!).then(() => true, () => false), false); }
    await f.fake.scenario('success'); assert.equal((await f.service.run(f.service.create('취소 후 새 Loop'))).status, 'completed');
  } finally { await f.close(); }
});
for (const scenario of ['draft-hang', 'review-hang', 'improve-hang']) test(`${scenario}: adapter timeout fails without retry`, async () => {
  const f = await setup(250);
  try {
    await f.fake.scenario(scenario); const result = await f.service.run(f.service.create('시간 초과 검증'));
    assert.equal(result.status, 'failed'); assert.equal(result.finalResult, undefined);
    assert.match(result.error!, /시간/); assert.equal(f.calls.length, scenario === 'draft-hang' ? 1 : scenario === 'review-hang' ? 2 : 3);
  } finally { await f.close(); }
});
test('History failure preserves completed improved output without generating again', async () => {
  const f = await setup();
  try {
    const result = await f.service.run(f.service.create('보관 실패 검증')); const before = JSON.stringify(result);
    const reply = await saveCompletedHistory(result, { saveHistory: async () => ({ ok: false, code: 'unavailable' }) } as unknown as HistoryBridge);
    assert.equal(reply.ok, false); assert.equal(JSON.stringify(result), before); assert.equal(result.status, 'completed'); assert.equal(f.calls.length, 3);
  } finally { await f.close(); }
});
test('existing limits reject oversized prior output at the gateway before another provider call', async () => {
  const f = await setup();
  try {
    const reply = await f.gateway.executeProvider({ providerId: reviewer.id, request: { userRequest: '공개', stepTitle: '검토', previousOutputs: ['x'.repeat(100001)], isFinalStep: false } });
    assert.equal(reply.ok, false); assert.equal((await f.fake.entries()).length, 0);
  } finally { await f.close(); }
});
test('consent is per run; packaged gate and no extra IPC/adapter authority', async () => {
  const hook = await readFile(new URL('../src/ui/use-loop.ts', import.meta.url), 'utf8');
  assert.match(hook, /policy\.experimental && \(!experimentalConsent \|\| attachments\.length\)/);
  assert.match(hook, /if \(policy\.experimental\) setExperimentalConsent\(false\)/);
  const main = await readFile(new URL('../electron/main.cts', import.meta.url), 'utf8');
  assert.match(main, /localManualExperimentEnabled\(app\.isPackaged, process\.env\)/);
});

test('late review cannot mutate cancelled Loop or leak into the next collaboration', async () => {
  let release!: (value: { output: string }) => void;
  const late = new Promise<{ output: string }>(resolve => { release = resolve; });
  let arrived!: () => void; const ready = new Promise<void>(resolve => { arrived = resolve; });
  let hold = true; let calls = 0;
  const main = new ProviderRegistry();
  main.register({ id: primary.id, displayName: 'Fake Ollama', async execute(request) {
    calls++; return { output: request.isFinalStep ? improvedText(request.userRequest) : draftText(request.userRequest) };
  } }, primary);
  main.register({ id: reviewer.id, displayName: 'Fake Codex', async execute(request) {
    calls++; if (hold) { arrived(); return late; } return { output: reviewText(request.userRequest) };
  } }, reviewer);
  const gateway = createProviderGateway(main); const registry = new ProviderRegistry();
  for (const summary of main.list()) registry.register(new IpcProvider(summary, gateway), summary);
  const service = new LoopService(new DraftReviewImprove(primary.id, reviewer.id), registry);
  try {
    const controller = new AbortController(); const snapshots: Loop[] = [];
    const pending = service.run(service.create('old'), loop => snapshots.push(loop), { signal: controller.signal });
    await ready; controller.abort(); const cancelled = await pending;
    assert.equal(cancelled.status, 'cancelled'); assert.equal(calls, 2);
    const before = JSON.stringify(snapshots); hold = false;
    const next = await service.run(service.create('new')); release({ output: 'LATE old review' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(next.status, 'completed'); assert.equal(next.finalResult, improvedText('new')); assert.equal(calls, 5);
    assert.equal(JSON.stringify(snapshots), before); assert.doesNotMatch(JSON.stringify(next), /LATE|old/);
  } finally { release({ output: 'cleanup' }); gateway.dispose(); }
});
