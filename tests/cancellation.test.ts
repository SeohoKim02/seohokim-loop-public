// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import { cancelLoop, isTerminalLoop } from '../src/domain/loop.ts';
import type { Loop } from '../src/domain/loop.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { AutoLoopService } from '../src/application/auto-loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';
import { DraftReviewImprove } from '../src/application/draft-review-improve.ts';
import { TaskPlanner } from '../src/application/task-planner.ts';
import { MockProvider } from '../src/providers/mock-provider.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import { ProviderError } from '../src/providers/provider-error.ts';
import { abortable, abortCode } from '../src/providers/cancellation.ts';
import type { AIProvider, ProviderRequest, ProviderResponse } from '../src/providers/ai-provider.ts';
import { createProviderGateway, validateExecution } from '../electron/provider-gateway.ts';
import { OpenAICompatibleProvider } from '../electron/providers/openai-compatible.ts';
import { AnthropicProvider } from '../electron/providers/anthropic.ts';

const request: ProviderRequest = { userRequest: '작업', stepTitle: '작성', previousOutputs: [], isFinalStep: true };
const plan = JSON.stringify({ title: '계획', steps: ['작성', '검토', '정리'].map((title, index) => ({ title,
  role: index === 1 ? 'review' : index === 2 ? 'deliver' : 'write', objective: title, usesPreviousOutputs: index > 0, isFinal: index === 2 })) });
const secret = 'fake-cancellation-private-key';
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
function safe(value: unknown) { assert.doesNotMatch(JSON.stringify(value), /fake-cancellation-private-key|AbortController|Authorization|stack/); }
function setup(execute: AIProvider['execute']) {
  const registry = new ProviderRegistry();
  for (const id of ['a', 'b']) registry.register({ id, displayName: id, execute }, { type: 'test', configured: true });
  const gateway = createProviderGateway(registry);
  const renderer = new ProviderRegistry();
  for (const summary of registry.list()) renderer.register(new IpcProvider(summary, gateway), summary);
  return { registry, renderer, gateway };
}
const adapters = {
  openai: (fetcher: typeof fetch) => new OpenAICompatibleProvider({ id: 'a', displayName: 'a', apiKey: secret, model: 'test', baseUrl: 'https://example.test/v1' }, fetcher),
  anthropic: (fetcher: typeof fetch) => new AnthropicProvider({ apiKey: secret, model: 'test' }, fetcher),
};
const success = (kind: string) => Response.json(kind === 'openai' ? { choices: [{ message: { content: '결과' } }] }
  : { type: 'message', role: 'assistant', content: [{ type: 'text', text: '결과' }] });

for (const status of ['completed', 'failed', 'cancelled'] as const) test(`domain ${status} is terminal; cancel is an identity-preserving no-op`, () => {
  const service = new LoopService(new MockPlanner(), new MockProvider());
  const loop = { ...service.create('작업'), status, finalResult: status === 'completed' ? '최종' : undefined };
  assert.equal(isTerminalLoop(loop), true); assert.equal(cancelLoop(loop), loop);
});
test('domain cancellation preserves completed outputs and pending steps, marks only active step', () => {
  const service = new LoopService(new MockPlanner(), new MockProvider());
  const initial = service.create('작업');
  const running: Loop = { ...initial, status: 'running', steps: initial.steps.map((s, i) => ({ ...s,
    status: i === 0 ? 'completed' : i === 1 ? 'running' : 'pending', ...(i === 0 ? { output: '보존' } : {}) })) };
  const result = cancelLoop(running);
  assert.equal(result.status, 'cancelled'); assert.equal(result.steps[0], running.steps[0]);
  assert.equal(result.steps[1]!.status, 'cancelled'); assert.ok(result.steps[1]!.completedAt);
  assert.ok(result.steps.slice(2).every((s) => s.status === 'pending')); assert.equal(result.finalResult, undefined);
  assert.equal(running.status, 'running'); assert.equal(isTerminalLoop(result), true);
});

for (const [kind, create] of Object.entries(adapters)) {
  test(`${kind} passes a real abort signal and distinguishes explicit cancellation`, async () => {
    const controller = new AbortController(); let calls = 0; let received!: AbortSignal;
    const adapter = create(async (_url, init) => {
      calls++; received = init!.signal!;
      return new Promise((_resolve, reject) => received.addEventListener('abort', () => reject(received.reason), { once: true }));
    });
    const executing = adapter.execute(request, { signal: controller.signal });
    controller.abort(secret);
    await assert.rejects(executing, { code: 'CANCELLED' }); assert.equal(received.aborted, true); assert.equal(calls, 1);
    await assert.rejects(adapter.execute(request, { signal: controller.signal }), { code: 'CANCELLED' }); assert.equal(calls, 1);
  });
  test(`${kind} abort during body read is cancelled, never parse/network failure`, async () => {
    const controller = new AbortController(); const arrived = deferred<void>();
    const adapter = create(async (_url, init) => ({ ok: true, json: () => {
      arrived.resolve(); return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error(secret)), { once: true }));
    } }) as Response);
    const execution = adapter.execute(request, { signal: controller.signal }); await arrived.promise; controller.abort();
    await assert.rejects(execution, (cause) => { assert.ok(cause instanceof ProviderError); assert.equal(cause.code, 'CANCELLED'); safe(cause.message); return true; });
  });
  test(`${kind} timeout remains TIMEOUT with a non-aborted user signal and retains 60s/15s limits`, async (t) => {
    const deadlines: number[] = []; let timeout!: AbortController;
    t.mock.method(AbortSignal, 'timeout', (ms: number) => { deadlines.push(ms); timeout = new AbortController(); return timeout.signal; });
    const adapter = create(async (_url, init) => {
      timeout.abort(new DOMException('timeout', 'TimeoutError'));
      throw init!.signal!.reason;
    });
    await assert.rejects(adapter.execute(request, { signal: new AbortController().signal }), { code: 'TIMEOUT' });
    await assert.rejects(adapter.testConnection(), { code: 'TIMEOUT' }); assert.deepEqual(deadlines, [60000, 15000]);
  });
  test(`${kind} late successful body cannot win over already requested cancellation`, async () => {
    const controller = new AbortController(); const late = deferred<Response>();
    const adapter = create(async () => late.promise);
    const running = adapter.execute(request, { signal: controller.signal }); controller.abort(); late.resolve(success(kind));
    await assert.rejects(running, { code: 'CANCELLED' });
  });
}
test('composed abort classifies the first cause without leaking reason', () => {
  for (const first of ['user', 'timeout']) {
    const user = new AbortController(); const timeout = new AbortController(); const signal = AbortSignal.any([user.signal, timeout.signal]);
    // Model an active fetch consumer, including propagation of the first abort.
    signal.addEventListener('abort', () => {}, { once: true });
    if (first === 'user') { user.abort(secret); timeout.abort(); } else { timeout.abort(); user.abort(secret); }
    assert.equal(abortCode(signal, user.signal), first === 'user' ? 'CANCELLED' : 'TIMEOUT');
  }
});
test('Mock aborts its default timer and injected unresolved delay without waiting for completion', async () => {
  for (const mock of [new MockProvider(), new MockProvider(() => new Promise(() => {}))]) {
    const controller = new AbortController(); const running = mock.execute(request, { signal: controller.signal }); controller.abort();
    await assert.rejects(running, { code: 'CANCELLED' }); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});
test('abort helper removes listeners after success, failure and synchronous abort/error; late failure is handled', async () => {
  for (const operation of ['success', 'throw', 'abort', 'late']) {
    const controller = new AbortController(); const late = deferred<string>();
    const result = abortable(() => {
      if (operation === 'success') return Promise.resolve('done');
      if (operation === 'throw') throw new Error('test');
      if (operation === 'abort') { controller.abort(); throw new Error('test'); }
      return late.promise;
    }, controller.signal);
    if (operation === 'late') controller.abort();
    if (operation === 'success') assert.equal(await result, 'done'); else await assert.rejects(result);
    late.reject(new Error('late')); if (operation !== 'late') await late.promise.catch(() => {});
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

for (const mode of ['single', 'manual', 'auto'] as const) {
  for (const cancelAt of mode === 'single' ? [0] : mode === 'auto' ? [0, 1, 2, 3] : [0, 1, 2]) {
    test(`${mode} cancel at request ${cancelAt} aborts only active request, preserves prior outputs, stops all later calls`, async () => {
      let calls = 0; let activeSignal!: AbortSignal; const arrived = deferred<void>();
      const { renderer, gateway } = setup(async (_request, options) => {
        const index = calls++;
        if (index === cancelAt) {
          activeSignal = options!.signal!; arrived.resolve();
          return abortable(() => new Promise(() => {}), activeSignal);
        }
        return { output: mode === 'auto' && index === 0 ? plan : `output ${index}` };
      });
      const snapshots: Loop[] = []; const controller = new AbortController();
      const service = mode === 'auto' ? new AutoLoopService(renderer)
        : new LoopService(mode === 'single' ? { plan: () => [{ title: '작성', providerId: 'a' }] } : new DraftReviewImprove('a', 'b'), renderer);
      const observe = (loop: Loop) => snapshots.push(loop);
      const executing = service instanceof AutoLoopService ? service.run('작업', observe, { signal: controller.signal })
        : service.run(service.create('작업'), observe, { signal: controller.signal });
      await arrived.promise; controller.abort(); controller.abort();
      const result = await executing;
      assert.equal(activeSignal.aborted, true); assert.equal(result.status, 'cancelled'); assert.equal(result.finalResult, undefined);
      assert.equal(result.error, undefined); assert.equal(calls, cancelAt + 1); safe(result);
      if (mode === 'auto' && cancelAt === 0) assert.equal(result.steps.length, 0);
      else {
        const index = cancelAt - (mode === 'auto' ? 1 : 0);
        assert.equal(result.steps[index]!.status, 'cancelled'); assert.ok(result.steps[index]!.completedAt);
        assert.ok(result.steps.slice(0, index).every((s) => s.status === 'completed' && s.output));
        assert.ok(result.steps.slice(index + 1).every((s) => s.status === 'pending' && !s.startedAt));
      }
      const reply = await gateway.cancelExecution(result.id); assert.deepEqual(reply, { ok: true, value: { cancelled: false } });
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.equal(snapshots.filter(isTerminalLoop).length, 1);
      assert.ok(snapshots.every((s) => s.id === result.id));
      // Cleanup permits a new normal execution immediately, without reusing the old ID.
      const next = await gateway.executeProvider({ providerId: 'a', request, executionId: crypto.randomUUID() }); assert.equal(next.ok, true);
    });
  }
}
test('cancel between completed steps or immediately before final publication prevents next call/result', async () => {
  for (const completedCount of [1, 3]) {
    let calls = 0; const { renderer } = setup(async () => ({ output: `output ${++calls}` }));
    const service = new LoopService(new DraftReviewImprove('a', 'b'), renderer); const controller = new AbortController();
    const result = await service.run(service.create('작업'), (loop) => {
      if (loop.status === 'running' && loop.steps.filter((s) => s.status === 'completed').length === completedCount) controller.abort();
    }, { signal: controller.signal });
    assert.equal(result.status, 'cancelled'); assert.equal(calls, completedCount); assert.equal(result.finalResult, undefined);
    assert.ok(result.steps.slice(completedCount).every((s) => s.status === 'pending'));
  }
});
test('pre-cancelled services and cancellation from running observer spend no requests', async () => {
  let calls = 0; const { renderer } = setup(async () => { calls++; return { output: plan }; });
  for (const automatic of [true, false]) {
    const controller = new AbortController(); controller.abort();
    const service = new LoopService(new DraftReviewImprove('a', 'b'), renderer);
    const result = automatic ? await new AutoLoopService(renderer).run('작업', () => {}, { signal: controller.signal })
      : await service.run(service.create('작업'), () => {}, { signal: controller.signal });
    assert.equal(result.status, 'cancelled');
  }
  const controller = new AbortController(); const service = new LoopService(new DraftReviewImprove('a', 'b'), renderer);
  assert.equal((await service.run(service.create('작업'), (loop) => { if (loop.steps[0]?.status === 'running') controller.abort(); },
    { signal: controller.signal })).status, 'cancelled'); assert.equal(calls, 0);
});
test('TaskPlanner timeout is failure while explicit user cancellation is CANCELLED', async () => {
  const provider: AIProvider = { id: 'p', displayName: 'p', execute: async () => { throw new ProviderError('TIMEOUT'); } };
  await assert.rejects(new TaskPlanner(provider).plan('작업'), /작업 계획을 만들지 못했습니다/);
  const { renderer } = setup(provider.execute);
  assert.equal((await new AutoLoopService(renderer).run('작업')).status, 'failed');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new TaskPlanner(provider).plan('작업', { signal: controller.signal }), { code: 'CANCELLED' });
});
test('unknown, stale and duplicate cancellation is safe; invalid IDs and payloads are rejected without effects', async () => {
  let signal!: AbortSignal;
  const { gateway } = setup(async (_request, options) => { signal = options!.signal!; return abortable(() => new Promise(() => {}), signal); });
  const executionId = crypto.randomUUID(); const running = gateway.executeProvider({ providerId: 'a', request, executionId });
  assert.deepEqual(await gateway.cancelExecution(crypto.randomUUID()), { ok: true, value: { cancelled: false } });
  assert.equal(signal.aborted, false);
  for (const id of ['', 'a', null, {}, [], 1, 'https://example.test', `${executionId} `]) {
    const reply = await gateway.cancelExecution(id as string); assert.equal(reply.ok, false);
    if (!reply.ok) assert.equal(reply.error.code, 'INVALID_REQUEST'); safe(reply);
    assert.throws(() => validateExecution({ providerId: 'a', request, executionId: id }));
  }
  const first = gateway.cancelExecution(executionId); const second = gateway.cancelExecution(executionId);
  assert.deepEqual(await first, { ok: true, value: { cancelled: true } }); assert.equal((await second).ok, true);
  const reply = await running; assert.equal(reply.ok, false); if (!reply.ok) assert.equal(reply.error.code, 'CANCELLED'); safe(reply);
  assert.deepEqual(await gateway.cancelExecution(executionId), { ok: true, value: { cancelled: false } });
});
test('late response from cancelled request cannot affect next execution or reacquire controller', async () => {
  const old = deferred<ProviderResponse>(); const next = deferred<ProviderResponse>(); let calls = 0;
  const { gateway } = setup(async () => ++calls === 1 ? old.promise : next.promise);
  const firstId = crypto.randomUUID(); const secondId = crypto.randomUUID();
  const first = gateway.executeProvider({ providerId: 'a', request, executionId: firstId });
  await gateway.cancelExecution(firstId); const cancelled = await first; assert.equal(cancelled.ok, false);
  const second = gateway.executeProvider({ providerId: 'a', request, executionId: secondId });
  old.resolve({ output: secret });
  assert.deepEqual(await gateway.cancelExecution(firstId), { ok: true, value: { cancelled: false } });
  next.resolve({ output: 'new output' }); assert.deepEqual(await second, { ok: true, value: { output: 'new output' } }); safe(cancelled);
  assert.deepEqual(await gateway.cancelExecution(secondId), { ok: true, value: { cancelled: false } });
});
test('completion wins once published; response/cancel races have exactly one terminal state', async () => {
  for (const cancelFirst of [false, true]) {
    const pending = deferred<ProviderResponse>(); const controller = new AbortController(); const snapshots: Loop[] = [];
    const { renderer } = setup(() => pending.promise);
    const service = new LoopService({ plan: () => [{ title: '작성', providerId: 'a' }] }, renderer);
    const running = service.run(service.create('작업'), (loop) => snapshots.push(loop), { signal: controller.signal });
    pending.resolve({ output: 'result' });
    if (cancelFirst) controller.abort();
    const result = await running; controller.abort();
    assert.equal(result.status, cancelFirst ? 'cancelled' : 'completed');
    assert.equal(snapshots.filter(isTerminalLoop).length, 1); assert.equal(cancelLoop(result), result);
  }
});
test('Loop cancellation never aborts a simultaneous connection check and does not expose controllers', async () => {
  const checked = deferred<void>(); let checkDone = false;
  const { registry, gateway } = setup(async (_req, options) => abortable(() => new Promise(() => {}), options!.signal));
  registry.replace({ id: 'a', displayName: 'a', execute: registry.get('a').execute,
    testConnection: async () => { await checked.promise; checkDone = true; } }, { type: 'test', configured: true });
  const check = gateway.testConnection('a'); const id = crypto.randomUUID();
  const work = gateway.executeProvider({ providerId: 'a', request, executionId: id });
  await gateway.cancelExecution(id); await work; assert.equal(checkDone, false);
  checked.resolve(); assert.equal((await check).ok, true); safe(await gateway.listProviders());
});
test('gateway cleanup covers success, error and window disposal; disposed gateway rejects new work', async () => {
  for (const outcome of ['success', 'error', 'dispose']) {
    let signal!: AbortSignal;
    const { gateway } = setup(async (_req, options) => {
      signal = options!.signal!;
      if (outcome === 'error') throw new Error(secret);
      if (outcome === 'dispose') return abortable(() => new Promise(() => {}), signal);
      return { output: 'success' };
    });
    const executionId = crypto.randomUUID(); const work = gateway.executeProvider({ providerId: 'a', request, executionId });
    if (outcome === 'dispose') { gateway.dispose(); gateway.dispose(); assert.equal(signal.aborted, true); }
    safe(await work); assert.deepEqual(await gateway.cancelExecution(executionId), { ok: true, value: { cancelled: false } });
    assert.equal(getEventListeners(signal, 'abort').length, 0);
    if (outcome === 'dispose') {
      const result = await gateway.executeProvider({ providerId: 'a', request });
      assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'IPC_UNAVAILABLE');
    }
  }
});
