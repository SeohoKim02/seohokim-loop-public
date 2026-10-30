// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import { AutoLoopService } from '../src/application/auto-loop-service.ts';
import { parseTaskPlan, PlanValidationError } from '../src/application/task-planner.ts';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';
import { ProviderError } from '../src/providers/provider-error.ts';
import { createProviderGateway } from '../electron/provider-gateway.ts';
import type { ProviderExecution } from '../src/providers/provider-ipc.ts';
import type { ProviderExecutionOptions, ProviderRequest, ProviderResponse } from '../src/providers/ai-provider.ts';
import type { Loop } from '../src/domain/loop.ts';
import { cancelLoop } from '../src/domain/loop.ts';
import { ProviderSlots } from '../src/application/provider-slots.ts';

const plan = (refs: number[][] | undefined = [[], [], [1, 2], [3]]) => ({ title: '비교 안내', steps: Array.from({ length: refs?.length ?? 4 }, (_, i) => ({
  title: `단계 ${i + 1}`, objective: `목표 ${i + 1}`, role: i === (refs?.length ?? 4) - 1 ? 'deliver' : 'write',
  usesPreviousOutputs: refs ? refs[i]!.length > 0 : i > 0, isFinal: i === (refs?.length ?? 4) - 1,
  ...(refs ? { dependsOn: refs[i] } : {}),
})) });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const turn = () => new Promise((resolve) => setImmediate(resolve));
const temporary = () => new ProviderError('HTTP_ERROR', 503);
function fixture(declaration = plan(), ids = ['a', 'b'], work?: (id: string, request: ProviderRequest, options?: ProviderExecutionOptions) => Promise<ProviderResponse>) {
  const gates = Array.from({ length: declaration.steps.length }, () => deferred<ProviderResponse>());
  const calls: { id: string; index: number; request: ProviderRequest; signal: AbortSignal }[] = [];
  const ipc: ProviderExecution[] = []; const updates: Loop[] = []; let plannerCalls = 0;
  const main = new ProviderRegistry();
  for (const id of ids) main.register({ id, displayName: id, execute: async (request, options) => {
    if (request.stepTitle.startsWith('작업 계획')) { plannerCalls++; return { output: JSON.stringify(declaration) }; }
    const index = declaration.steps.findIndex((s) => s.title === request.stepTitle);
    calls.push({ id, index, request, signal: options!.signal! });
    return work ? work(id, request, options) : gates[index]!.promise;
  } }, { type: 'custom-text', configured: true });
  const gateway = createProviderGateway(main); const renderer = new ProviderRegistry();
  const bridge = { ...gateway, executeProvider: (input: ProviderExecution) => { ipc.push(structuredClone(input)); return gateway.executeProvider(input); } };
  for (const s of main.list()) renderer.register(new IpcProvider(s, bridge), s);
  const service = new AutoLoopService(renderer, { retryWait: async () => {} });
  return { service, main, gateway, renderer, calls, ipc, gates, updates, plannerCalls: () => plannerCalls,
    run: (signal?: AbortSignal) => service.run('비교해주세요.', (l) => updates.push(l), { signal }),
    release: (index: number, output = `result-${index + 1}`) => gates[index]!.resolve({ output }) };
}

test('explicit dependencies parse, sort, freeze and retain application-owned IDs', () => {
  const declaration = plan([[], [], [2, 1], [3]]);
  const parsed = parseTaskPlan(JSON.stringify(declaration)); assert.deepEqual(parsed.steps[2]!.dependsOn, [1, 2]);
  assert.ok(Object.isFrozen(parsed.steps[2]!.dependsOn));
});
for (const [label, refs] of Object.entries({ zero: [0], negative: [-1], fraction: [1.2], string: ['1'], self: [3], future: [4], missing: [99], duplicate: [1, 1], null: null, object: {}, scalar: 1 })) {
  test(`dependency validation rejects ${label}`, () => {
    const input = plan(); (input.steps[2] as unknown as Record<string, unknown>).dependsOn = refs;
    assert.throws(() => parseTaskPlan(JSON.stringify(input)), PlanValidationError);
  });
}
test('cycles, incomplete final ancestry, mixed schema and inconsistent context flags fail closed', () => {
  const cycle = plan([[2], [1], [1, 2], [3]]); const orphan = plan([[], [], [1], [3]]);
  const mixed = plan(); delete mixed.steps[1]!.dependsOn;
  const inconsistent = plan(); inconsistent.steps[1]!.usesPreviousOutputs = true;
  for (const p of [cycle, orphan, mixed, inconsistent]) assert.throws(() => parseTaskPlan(JSON.stringify(p)), PlanValidationError);
});
test('invalid dependencies use existing one Planner recovery, then the same validator', async () => {
  for (const repair of [true, false]) {
    const registry = new ProviderRegistry(); let planning = 0; let work = 0;
    registry.register({ id: 'a', displayName: 'a', execute: async (request) => {
      if (request.stepTitle.startsWith('작업 계획')) { planning++; return { output: JSON.stringify(planning === 2 && repair ? plan() : plan([[], [], [1], [3]])) }; }
      work++; return { output: 'done' };
    } }, { type: 'custom', configured: true });
    const result = await new AutoLoopService(registry).run('요청'); assert.equal(result.status, repair ? 'completed' : 'failed');
    assert.equal(planning, 2); assert.equal(work, repair ? 4 : 0);
  }
});
test('two independent requests overlap; dependency waits for both; context follows plan, not completion order', async () => {
  const f = fixture(); const running = f.run(); await turn();
  assert.deepEqual(f.calls.map((c) => c.index), [0, 1]); assert.equal(f.updates.at(-1)!.steps.filter((s) => s.status === 'running').length, 2);
  assert.deepEqual(f.calls.map((c) => c.request.previousOutputs), [[], []]);
  f.release(1); await turn(); assert.equal(f.calls.length, 2);
  f.release(0); await turn(); assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[2]!.request.previousOutputs, ['result-1', 'result-2']);
  f.release(2); await turn(); assert.deepEqual(f.calls[3]!.request.previousOutputs, ['result-3']);
  f.release(3); const result = await running; assert.equal(result.status, 'completed'); assert.equal(result.finalResult, 'result-4');
  assert.equal(f.plannerCalls(), 1); assert.equal(new Set(f.ipc.map((c) => c.executionId)).size, 1);
});
test('legacy plan remains sequential even when usesPreviousOutputs is false', async () => {
  const legacy = plan(); for (const step of legacy.steps) delete step.dependsOn;
  legacy.steps[1]!.usesPreviousOutputs = false;
  const f = fixture(legacy); const running = f.run(); await turn(); assert.deepEqual(f.calls.map((c) => c.index), [0]);
  for (let i = 0; i < 4; i++) { assert.equal(f.calls.length, i + 1); f.release(i); await turn(); }
  assert.equal((await running).status, 'completed');
});
test('maximum two running steps even with three independent providers', async () => {
  const f = fixture(plan([[], [], [], [1, 2, 3], [4]]), ['a', 'b', 'c']); const running = f.run(); await turn();
  assert.deepEqual(f.calls.map((c) => c.index), [0, 1]); f.release(1); await turn(); assert.deepEqual(f.calls.map((c) => c.index), [0, 1, 2]);
  f.release(2); await turn(); assert.equal(f.calls.length, 3); f.release(0); await turn(); f.release(3); await turn(); f.release(4);
  assert.equal((await running).status, 'completed'); assert.ok(f.updates.every((l) => l.steps.filter((s) => s.status === 'running').length <= 2));
});
test('one provider serializes every independent step without BUSY errors', async () => {
  const f = fixture(plan(), ['a']); const running = f.run(); await turn();
  for (let i = 0; i < 4; i++) { assert.deepEqual(f.calls.map((c) => c.index), Array.from({ length: i + 1 }, (_, j) => j)); f.release(i); await turn(); }
  assert.equal((await running).status, 'completed');
});
test('unrelated completed results are excluded and dependency context retains 40000-character limit', async () => {
  const f = fixture(plan([[], [], [], [1, 2, 3], [4]]), ['a', 'b'], async (_id, r) => ({ output: r.stepTitle === '단계 5' ? 'final' : r.stepTitle.repeat(5000).slice(0, 20000) }));
  const result = await f.run(); assert.equal(result.status, 'completed');
  const independent = f.calls.find((c) => c.index === 2)!; assert.deepEqual(independent.request.previousOutputs, []);
  const merge = f.calls.find((c) => c.index === 3)!; assert.equal(merge.request.previousOutputs.join('').length, 40000);
  assert.deepEqual(merge.request.previousOutputs, [result.steps[1]!.output, result.steps[2]!.output]);
  assert.deepEqual(f.calls.find((c) => c.index === 4)!.request.previousOutputs, [result.steps[3]!.output]);
});
test('irrecoverable failure aborts sibling, waits for cleanup, and remains failed instead of cancelled', async () => {
  const f = fixture(); const running = f.run(); await turn(); f.gates[1]!.reject(new ProviderError('HTTP_ERROR', 401));
  const result = await running; assert.equal(result.status, 'failed'); assert.equal(result.steps[1]!.status, 'failed');
  assert.equal(result.steps[0]!.status, 'cancelled'); assert.ok(f.calls.every((c) => c.signal.aborted || c.index === 1));
  assert.equal(result.finalResult, undefined); assert.equal(f.calls.length, 2);
  const count = f.updates.length; f.release(0); await turn(); assert.equal(f.updates.length, count); assert.equal(cancelLoop(result), result);
  assert.deepEqual(await f.gateway.cancelExecution(result.id), { ok: true, value: { cancelled: false } });
});
test('failure preserves already completed sibling output', async () => {
  const f = fixture(); const running = f.run(); await turn(); f.release(0); await turn();
  const completed = f.updates.at(-1)!.steps[0]; f.gates[1]!.reject(new ProviderError('TIMEOUT'));
  const result = await running; assert.equal(result.status, 'failed'); assert.equal(result.steps[0], completed); assert.equal(f.calls.length, 2);
});
for (const lateFailure of [false, true]) test(`user cancel aborts both, ignores late ${lateFailure ? 'failure' : 'success'}, and clears controllers/listeners`, async () => {
  const f = fixture(); const controller = new AbortController(); const running = f.run(controller.signal); await turn();
  await assert.rejects(f.service.run('duplicate'), /현재 작업/);
  assert.deepEqual(await f.gateway.cancelExecution(crypto.randomUUID()), { ok: true, value: { cancelled: false } });
  controller.abort(); const result = await running; assert.equal(result.status, 'cancelled'); assert.ok(f.calls.every((c) => c.signal.aborted));
  const count = f.updates.length; for (let i = 0; i < 2; i++) { if (lateFailure) f.gates[i]!.reject(temporary()); else f.release(i); }
  await turn(); assert.equal(f.updates.length, count); assert.equal(f.calls.length, 2); assert.equal(result.finalResult, undefined);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(await f.gateway.cancelExecution(result.id), { ok: true, value: { cancelled: false } });
  for (let i = 2; i < 4; i++) f.release(i);
  if (!lateFailure) assert.equal((await f.run()).status, 'completed');
});
test('simultaneous failures reserve exactly one retry and one fallback, with no provider overlap', async () => {
  const attempts = new Map<string, number>(); const calls: string[] = [];
  const f = fixture(plan(), ['a', 'b'], async (id, r) => {
    const key = `${id}:${r.stepTitle}`; const n = (attempts.get(key) ?? 0) + 1; attempts.set(key, n); calls.push(key);
    if (n === 1 && ((id === 'a' && r.stepTitle === '단계 1') || (id === 'b' && r.stepTitle === '단계 2'))) throw temporary();
    return { output: r.stepTitle };
  });
  const result = await f.run(); assert.equal(result.status, 'completed'); assert.equal(calls.length, 6);
  assert.equal(result.steps.reduce((n, s) => n + s.retryCount, 0), 1);
  assert.equal(result.steps.reduce((n, s) => n + (s.fallbackCount ?? 0), 0), 1);
  assert.ok(!result.error); assert.equal(result.finalResult, '단계 4');
});
for (const cancel of [false, true]) test(`fallback waits for busy provider slot (${cancel ? 'cancel' : 'success'})`, async () => {
  let aAttempts = 0; const held = deferred<ProviderResponse>(); let fallbackStarted = false;
  const f = fixture(plan(), ['a', 'b'], async (id, r) => {
    if (r.stepTitle === '단계 1') { if (id === 'a') { aAttempts++; throw temporary(); } fallbackStarted = true; }
    if (r.stepTitle === '단계 2') return held.promise;
    return { output: r.stepTitle };
  });
  const controller = new AbortController(); const running = f.run(controller.signal); await turn();
  assert.equal(aAttempts, 2); assert.equal(fallbackStarted, false); assert.equal(f.calls.length, 3);
  if (cancel) controller.abort(); else held.resolve({ output: 'second' });
  const result = await running; assert.equal(result.status, cancel ? 'cancelled' : 'completed');
  assert.equal(fallbackStarted, !cancel); assert.equal(result.steps[0]!.fallbackCount, cancel ? 0 : 1); held.resolve({ output: 'late' });
});
test('simultaneous unrecoverable failures produce one terminal update and no new step', async () => {
  const f = fixture(); const running = f.run(); await turn();
  f.gates[0]!.reject(new ProviderError('NETWORK_ERROR')); f.gates[1]!.reject(new ProviderError('TIMEOUT'));
  const result = await running; assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 2);
  assert.equal(f.updates.filter((l) => ['failed', 'cancelled', 'completed'].includes(l.status)).length, 1);
});
test('cancel on final step completion prevents final Loop completion', async () => {
  const f = fixture(plan(), ['a', 'b'], async () => ({ output: 'done' })); const controller = new AbortController();
  const result = await f.service.run('요청', (l) => { if (l.steps.at(-1)?.status === 'completed') controller.abort(); }, { signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.finalResult, undefined);
});
test('gateway bounds concurrent requests, rejects unrelated IDs and cleans up each controller independently', async () => {
  const registry = new ProviderRegistry(); const gates = [deferred<ProviderResponse>(), deferred<ProviderResponse>(), deferred<ProviderResponse>()];
  const signals: AbortSignal[] = [];
  for (const [i, id] of ['a', 'b', 'c'].entries()) registry.register({ id, displayName: id, execute: async (_r, o) => { signals.push(o!.signal!); return gates[i]!.promise; } }, { type: 'text', configured: true });
  const gateway = createProviderGateway(registry); const executionId = crypto.randomUUID();
  const input = { executionId, providerId: 'a', request: { userRequest: 'request', stepTitle: 'step', previousOutputs: [], isFinalStep: false } };
  const first = gateway.executeProvider(input); const second = gateway.executeProvider({ ...input, providerId: 'b' });
  for (const extra of [{ ...input, providerId: 'c' }, { ...input }, { ...input, providerId: 'c', executionId: crypto.randomUUID() }]) {
    const result = await gateway.executeProvider(extra); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'BUSY');
  }
  gates[0]!.resolve({ output: 'done' }); assert.equal((await first).ok, true);
  assert.deepEqual(await gateway.cancelExecution(executionId), { ok: true, value: { cancelled: true } });
  assert.equal((await second).ok, false); assert.equal(signals[0]!.aborted, false); assert.equal(signals[1]!.aborted, true);
  assert.deepEqual(await gateway.cancelExecution(executionId), { ok: true, value: { cancelled: false } });
  const next = gateway.executeProvider({ ...input, providerId: 'c', executionId: crypto.randomUUID() }); gates[2]!.resolve({ output: 'new' }); assert.equal((await next).ok, true);
  gates[1]!.resolve({ output: 'late' });
});
test('provider-slot cancellation removes waiters without releasing an occupied request early', async () => {
  const slots = new ProviderSlots(); const held = deferred<void>(); const owner = new AbortController(); const waiting = new AbortController(); let called = false;
  const first = slots.run('a', owner.signal, () => held.promise);
  const second = slots.run('a', waiting.signal, async () => { called = true; }); waiting.abort();
  await assert.rejects(second, { code: 'CANCELLED' }); assert.equal(called, false); assert.equal(slots.has('a'), true);
  assert.equal(getEventListeners(waiting.signal, 'abort').length, 0); held.resolve(); await first; assert.equal(slots.has('a'), false);
});

test('parallel recovery retains the exact nine-request bound including Planner repair', async () => {
  const declaration = plan([[], [], [1, 2], [3], [4]]); let planning = 0; let count = 0; let first = 0;
  const registry = new ProviderRegistry();
  for (const id of ['a', 'b']) registry.register({ id, displayName: id, execute: async (r) => {
    count++;
    if (r.stepTitle.startsWith('작업 계획')) { planning++; return { output: planning === 1 ? 'invalid' : JSON.stringify(declaration) }; }
    if (id === 'a' && r.stepTitle === '단계 1' && ++first <= 2) throw temporary();
    return { output: r.stepTitle };
  } }, { type: 'text', configured: true });
  const result = await new AutoLoopService(registry, { retryWait: async () => {} }).run('요청');
  assert.equal(result.status, 'completed'); assert.equal(count, 9); assert.equal(planning, 2);
  assert.equal(result.steps.reduce((n, s) => n + s.retryCount, 0), 1);
  assert.equal(result.steps.reduce((n, s) => n + (s.fallbackCount ?? 0), 0), 1);
});
test('Retry reservation is shared during asynchronous wait, not only after its completion', async () => {
  const waiting = deferred<void>(); let waits = 0; const attempts = new Map<string, number>();
  const f = fixture(plan(), ['a', 'b'], async (id, r) => {
    const key = `${id}:${r.stepTitle}`; const n = (attempts.get(key) ?? 0) + 1; attempts.set(key, n);
    if (n === 1 && ((id === 'a' && r.stepTitle === '단계 1') || (id === 'b' && r.stepTitle === '단계 2'))) throw temporary();
    return { output: 'result' };
  });
  const service = new AutoLoopService(f.renderer, { retryWait: async () => { waits++; await waiting.promise; } });
  const running = service.run('요청'); await turn(); assert.equal(waits, 1);
  assert.ok(f.calls.some((c) => c.id === 'a' && c.index === 1), 'Other failed step uses the single fallback while retry waits');
  waiting.resolve(); assert.equal((await running).status, 'completed'); assert.equal(waits, 1);
});
test('fallback final failure aborts remaining work without another retry or fallback', async () => {
  const f = fixture(plan(), ['a', 'b'], async (_id, r) => {
    if (r.stepTitle === '단계 1') throw temporary(); return { output: 'done' };
  });
  const result = await f.run(); assert.equal(result.status, 'failed');
  assert.equal(f.calls.filter((c) => c.index === 0).length, 3); assert.ok(f.calls.every((c) => c.index < 2));
  assert.equal(result.steps[0]!.retryCount, 1); assert.equal(result.steps[0]!.fallbackCount, 1);
});
test('review routing uses its actual dependency producer rather than the unrelated preceding step', async () => {
  const p = plan([[], [], [1], [2, 3]]); p.steps[2]!.role = 'review';
  const f = fixture(p, ['a', 'b'], async (id, r) => {
    if (id === 'a' && r.stepTitle === '단계 1') throw temporary(); return { output: r.stepTitle };
  });
  const result = await f.run(); assert.equal(result.status, 'completed');
  assert.equal(result.steps[0]!.assignedProvider.id, 'b'); assert.equal(result.steps[2]!.assignedProvider.id, 'a');
  assert.equal(result.steps[2]!.fallbackCount, 0); assert.deepEqual(f.calls.find((c) => c.index === 2)!.request.previousOutputs, ['단계 1']);
});
test('gateway disposal aborts every active controller and permanently refuses new calls', async () => {
  const f = fixture(); const running = f.run(); await turn(); f.gateway.dispose();
  const result = await running; assert.equal(result.status, 'cancelled'); assert.ok(f.calls.every((c) => c.signal.aborted));
  const reply = await f.gateway.executeProvider(f.ipc[0]!); assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.error.code, 'IPC_UNAVAILABLE');
  assert.deepEqual(await f.gateway.cancelExecution(result.id), { ok: true, value: { cancelled: false } });
  f.release(0); f.release(1);
});
