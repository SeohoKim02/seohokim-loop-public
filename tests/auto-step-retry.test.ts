// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import { readFile } from 'node:fs/promises';
import { AutoLoopService } from '../src/application/auto-loop-service.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';
import { DraftReviewImprove } from '../src/application/draft-review-improve.ts';
import { canRetryAutoTextStep, waitForAutoStepRetry, AUTO_STEP_RETRY_DELAY_MS } from '../src/application/auto-step-retry.ts';
import type { RetryWait } from '../src/application/auto-step-retry.ts';
import { ProviderError, toProviderFailure } from '../src/providers/provider-error.ts';
import type { ProviderErrorCode } from '../src/providers/provider-error.ts';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';
import type { AIProvider, ProviderResponse } from '../src/providers/ai-provider.ts';
import type { ProviderExecution } from '../src/providers/provider-ipc.ts';
import { cancelLoop } from '../src/domain/loop.ts';
import type { Loop } from '../src/domain/loop.ts';
import { createProviderGateway } from '../electron/provider-gateway.ts';
import { OpenAICompatibleProvider } from '../electron/providers/openai-compatible.ts';
import { AnthropicProvider } from '../electron/providers/anthropic.ts';

const userRequest = '두 방법을 비교해주세요.';
const secret = 'fake-step-retry-private-key';
const plan = (count = 3) => JSON.stringify({ title: '비교 안내', steps: Array.from({ length: count }, (_, i) => ({
  title: `단계 ${i + 1}`, role: i === count - 1 ? 'deliver' : 'write', objective: `목표 ${i + 1}`,
  usesPreviousOutputs: i > 0, isFinal: i === count - 1,
})) });
const temporary = (status = 503) => new ProviderError('HTTP_ERROR', status);
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const turn = () => new Promise((resolve) => setImmediate(resolve));
function setup(execute: AIProvider['execute'], wait: RetryWait = async () => {}) {
  const calls: ProviderExecution[] = []; const replies: unknown[] = []; let waits = 0;
  const main = new ProviderRegistry();
  for (const id of ['a', 'b']) main.register({ id, displayName: id, execute }, { type: 'test-text', configured: true });
  const gateway = createProviderGateway(main);
  const bridge = { ...gateway, executeProvider: async (input: ProviderExecution) => {
    calls.push(structuredClone(input)); const result = await gateway.executeProvider(input); replies.push(result); return result;
  } };
  const renderer = new ProviderRegistry();
  for (const summary of main.list()) renderer.register(new IpcProvider(summary, bridge), summary);
  const service = new AutoLoopService(renderer, { retryWait: async (signal) => { waits++; await wait(signal); } });
  return { service, calls, replies, renderer, gateway, waits: () => waits };
}
function scripted(outputs: (string | Error)[], wait?: RetryWait) {
  let index = 0; return setup(async () => {
    const output = outputs[index++]; assert.notEqual(output, undefined, 'Unexpected extra call');
    if (output instanceof Error) throw output; return { output: output! };
  }, wait);
}
function safe(value: unknown) { assert.doesNotMatch(JSON.stringify(value), /fake-step-retry-private-key|Authorization|encryptedApiKey|stack/); }

test('normal Auto has no retry or wait and keeps planner/final semantics', async () => {
  const f = scripted([plan(), 'one', 'two', 'final']); const result = await f.service.run(userRequest);
  assert.equal(result.status, 'completed'); assert.equal(result.finalResult, 'final'); assert.equal(f.calls.length, 4);
  assert.equal(f.waits(), 0); assert.ok(result.steps.every((s) => s.retryCount === 0 && !s.retryPending));
});
for (const status of [502, 503, 504]) test(`HTTP ${status} retries only the failed step with identical context/provider/execution ID`, async () => {
  const f = scripted([plan(), 'one', temporary(status), 'two', 'final']); const updates: Loop[] = [];
  const result = await f.service.run(userRequest, (loop) => updates.push(loop));
  assert.equal(result.status, 'completed'); assert.equal(result.finalResult, 'final'); assert.equal(f.calls.length, 5);
  assert.deepEqual(f.calls[2], f.calls[3]); assert.equal(f.calls[2]!.providerId, 'b');
  assert.equal(new Set(f.calls.map((c) => c.executionId)).size, 1);
  assert.deepEqual(f.calls.map((c) => c.request.stepTitle), ['작업 계획 준비', '단계 1', '단계 2', '단계 2', '단계 3']);
  assert.deepEqual(f.calls[3]!.request.previousOutputs, ['one']); assert.deepEqual(f.calls[4]!.request.previousOutputs, ['one', 'two']);
  assert.deepEqual(result.steps.map((s) => s.retryCount), [0, 1, 0]); assert.equal(f.waits(), 1);
  const previous = updates.find((l) => l.steps[0]?.status === 'completed')!.steps[0]!;
  for (const update of updates.filter((l) => l.steps[0]?.status === 'completed')) assert.equal(update.steps[0], previous);
  const waiting = updates.find((l) => l.steps[1]?.retryPending)!;
  assert.equal(waiting.status, 'running'); assert.equal(waiting.steps[1]!.status, 'running'); assert.equal(waiting.steps[1]!.retryCount, 0);
  assert.equal(result.steps[1]!.startedAt, waiting.steps[1]!.startedAt); assert.ok(result.steps[1]!.completedAt);
  safe(f.calls); safe(f.replies); safe(result);
});
test('retry and fallback failure is terminal, without third same-provider attempt or later work', async () => {
  const f = scripted([plan(), 'one', temporary(), temporary(), temporary()]); const result = await f.service.run(userRequest);
  assert.equal(result.status, 'failed'); assert.equal(result.finalResult, undefined); assert.equal(f.calls.length, 5);
  assert.deepEqual(f.calls.slice(2).map((c) => c.providerId), ['b', 'b', 'a']);
  assert.equal(result.steps[1]!.fallbackCount, 1);
  assert.deepEqual(result.steps.map((s) => s.status), ['completed', 'failed', 'pending']);
  assert.deepEqual(result.steps.map((s) => s.retryCount), [0, 1, 0]); assert.equal(f.waits(), 1);
});
test('successful retry consumes the whole Loop budget; a later transient failure cannot retry', async () => {
  const f = scripted([plan(), 'one', temporary(), 'two', temporary(), temporary()]); const result = await f.service.run(userRequest);
  assert.equal(result.status, 'failed'); assert.equal(result.finalResult, undefined); assert.equal(f.calls.length, 6);
  assert.deepEqual(f.calls.slice(4).map((c) => c.providerId), ['a', 'b']);
  assert.equal(result.steps[2]!.fallbackCount, 1);
  assert.deepEqual(result.steps.map((s) => s.retryCount), [0, 1, 0]); assert.equal(f.waits(), 1);
});
test('new Auto run has its own budget after either success or failure', async () => {
  const f = scripted([plan(), temporary(), 'one', 'two', 'final', plan(), temporary(), temporary(), temporary(),
    plan(), temporary(), 'one', 'two', 'final']);
  const first = await f.service.run(userRequest); const second = await f.service.run(userRequest); const third = await f.service.run(userRequest);
  assert.equal(first.status, 'completed'); assert.equal(second.status, 'failed'); assert.equal(third.status, 'completed');
  assert.equal(f.waits(), 3); assert.equal(new Set(f.calls.map((c) => c.executionId)).size, 3);
});
for (const status of [400, 401, 403, 404, 408, 409, 422, 429, 500, 501, 529, undefined]) test(`HTTP ${status} fails closed without retry`, async () => {
  const f = scripted([plan(), new ProviderError('HTTP_ERROR', status)]); const result = await f.service.run(userRequest);
  assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 2); assert.equal(f.waits(), 0);
  assert.equal(result.steps[0]!.retryCount, 0); assert.equal(result.finalResult, undefined);
});
for (const code of ['API_KEY_MISSING', 'CONFIG_MISSING', 'CONFIG_INVALID', 'INVALID_REQUEST', 'INVALID_BASE_URL',
  'PROVIDER_NOT_FOUND', 'NETWORK_ERROR', 'TIMEOUT', 'RESPONSE_PARSE_ERROR', 'EXECUTION_FAILED', 'CANCELLED'] as ProviderErrorCode[]) {
  test(`${code} never retries even if accompanied by a transient-looking HTTP status`, async () => {
    const f = scripted([plan(), new ProviderError(code, 503)]); const result = await f.service.run(userRequest);
    assert.equal(result.status, code === 'CANCELLED' ? 'cancelled' : 'failed'); assert.equal(f.calls.length, 2); assert.equal(f.waits(), 0);
  });
}
test('unknown errors and forged plain error objects cannot qualify for retry', async () => {
  for (const cause of [new Error(`${secret} 503`), { code: 'HTTP_ERROR', httpStatus: 503 }, null]) {
    assert.equal(canRetryAutoTextStep(cause), false);
    let calls = 0; const f = setup(async () => { if (calls++ === 0) return { output: plan() }; throw cause; });
    const result = await f.service.run(userRequest); assert.equal(result.status, 'failed'); assert.equal(f.waits(), 0); safe(result); safe(f.replies);
  }
});
test('output validation and malformed responses do not retry', async () => {
  for (const output of ['', ' ', 'x'.repeat(20_001)]) {
    const f = scripted([plan(), output]); const result = await f.service.run(userRequest);
    assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 2); assert.equal(f.waits(), 0);
  }
});
test('Planner recovery and step retry keep independent budgets, maximum eight calls', async () => {
  const f = scripted(['invalid plan', plan(5), 'one', temporary(), 'two', 'three', 'four', 'final']);
  const result = await f.service.run(userRequest); assert.equal(result.status, 'completed'); assert.equal(result.finalResult, 'final');
  assert.equal(f.calls.length, 8); assert.equal(f.waits(), 1);
  assert.deepEqual(f.calls.slice(0, 2).map((c) => c.request.stepTitle), ['작업 계획 준비', '작업 계획 수정']);
  assert.equal(result.steps.reduce((sum, s) => sum + s.retryCount, 0), 1);
});
test('transient Planner execution error does not consume step retry or start recovery', async () => {
  const f = scripted([temporary()]); const result = await f.service.run(userRequest);
  assert.equal(result.status, 'failed'); assert.equal(result.steps.length, 0); assert.equal(f.calls.length, 1); assert.equal(f.waits(), 0);
});
for (const mode of ['single', 'manual']) test(`${mode} does not inherit Auto retry even if explicitly misconfigured`, async () => {
  const f = setup(async () => { throw temporary(); });
  const planner = mode === 'single' ? new MockPlanner('single-work') : new DraftReviewImprove('a', 'b');
  const service = new LoopService(planner, mode === 'single' ? f.renderer.get('a') : f.renderer, { autoTextRetry: {} });
  const initial = service.create(userRequest, 'manual'); const result = await service.run(initial);
  assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 1); assert.equal(result.steps[0]!.retryCount, 0);
});
test('abort before run or immediately after first failure prevents retry and waiting', async () => {
  for (const before of [true, false]) {
    const controller = new AbortController(); const f = scripted([plan(), temporary()]); if (before) controller.abort();
    const result = await f.service.run(userRequest, (loop) => { if (loop.steps.some((s) => s.retryPending)) controller.abort(); }, { signal: controller.signal });
    assert.equal(result.status, 'cancelled'); assert.equal(f.calls.length, before ? 0 : 2); assert.equal(f.waits(), 0);
    assert.ok(result.steps.every((s) => s.retryCount === 0 && !s.retryPending));
  }
});
for (const duringWait of [true, false]) test(`cancel ${duringWait ? 'during wait' : 'at wait completion'} prevents the retry request`, async () => {
  const controller = new AbortController(); const arrived = deferred<void>(); const release = deferred<void>();
  const f = scripted([plan(), temporary()], async () => { arrived.resolve(); await release.promise; if (!duringWait) controller.abort(); });
  const running = f.service.run(userRequest, undefined, { signal: controller.signal }); await arrived.promise;
  if (duringWait) controller.abort(); else release.resolve();
  const result = await running; assert.equal(result.status, 'cancelled'); assert.equal(result.steps[0]!.retryCount, 0);
  assert.equal(result.finalResult, undefined); assert.equal(f.calls.length, 2); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  release.resolve(); await turn(); assert.equal(f.calls.length, 2);
});
for (const retry of [false, true]) test(`cancel ${retry ? 'retry' : 'initial step'} HTTP through gateway, ignore late response`, async () => {
  let index = 0; const arrived = deferred<void>(); const late = deferred<ProviderResponse>(); const controller = new AbortController(); let signal!: AbortSignal;
  const f = setup(async (_request, options) => {
    if (index++ === 0) return { output: plan() };
    if (retry && index === 2) throw temporary();
    signal = options!.signal!; arrived.resolve(); return late.promise;
  });
  const updates: Loop[] = []; const running = f.service.run(userRequest, (loop) => updates.push(loop), { signal: controller.signal });
  await arrived.promise; controller.abort(); const result = await running;
  assert.equal(result.status, 'cancelled'); assert.equal(signal.aborted, true); assert.equal(result.finalResult, undefined);
  assert.equal(f.calls.length, retry ? 3 : 2); assert.equal(result.steps[0]!.retryCount, retry ? 1 : 0);
  const updateCount = updates.length; late.resolve({ output: 'late result' }); await turn();
  assert.equal(updates.length, updateCount); assert.equal(cancelLoop(result), result);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(await f.gateway.cancelExecution(result.id), { ok: true, value: { cancelled: false } });
});
test('retry success then cancellation before next step preserves output and prevents subsequent calls', async () => {
  const controller = new AbortController(); const f = scripted([plan(), temporary(), 'one']);
  const result = await f.service.run(userRequest, (loop) => {
    if (loop.steps[0]?.status === 'completed') controller.abort();
  }, { signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.steps[0]!.output, 'one'); assert.equal(result.steps[0]!.status, 'completed');
  assert.equal(f.calls.length, 3); assert.equal(result.finalResult, undefined);
});
for (const reject of [false, true]) test(`retry ${reject ? 'failure' : 'success'} racing cancellation stays cancelled`, async () => {
  const controller = new AbortController(); let index = 0;
  const f = setup(async () => {
    if (index++ === 0) return { output: plan() }; if (index === 2) throw temporary();
    controller.abort(); if (reject) throw temporary(); return { output: 'late' };
  });
  const result = await f.service.run(userRequest, undefined, { signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.finalResult, undefined); assert.equal(f.calls.length, 3);
});
test('Start lock spans retry waiting/request; terminal executions cannot be retried', async () => {
  const arrived = deferred<void>(); const release = deferred<void>();
  const f = scripted([plan(), temporary(), 'one', 'two', 'final'], async () => { arrived.resolve(); await release.promise; });
  const running = f.service.run(userRequest); await arrived.promise; await assert.rejects(f.service.run(userRequest), /현재 작업/);
  release.resolve(); const result = await running; assert.equal(result.status, 'completed'); assert.equal(cancelLoop(result), result);
  const engine = new LoopService({ plan: () => [] }, f.renderer, { autoTextRetry: {} });
  for (const status of ['completed', 'failed', 'cancelled'] as const) await assert.rejects(engine.run({ ...result, status }));
  assert.equal(f.calls.length, 5);
});
test('one-second timer clears listeners on success, abort and pre-abort without real waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(); let done = false;
  const waiting = waitForAutoStepRetry(controller.signal).then(() => { done = true; });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  t.mock.timers.tick(AUTO_STEP_RETRY_DELAY_MS - 1); await Promise.resolve(); assert.equal(done, false);
  t.mock.timers.tick(1); await waiting; assert.equal(done, true); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const pending = waitForAutoStepRetry(controller.signal); controller.abort(secret);
  await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(waitForAutoStepRetry(controller.signal), { code: 'CANCELLED' }); t.mock.timers.tick(10000);
});
for (const kind of ['openai', 'anthropic']) test(`${kind} HTTP normalization survives IPC; quota 429 fails closed and no error body enters retry context`, async () => {
  for (const status of [429, 502, 503, 504]) {
    const wire: string[] = []; let index = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      wire.push(String(init!.body)); index++;
      if (index === 2) return new Response(JSON.stringify({ error: { code: status === 429 ? 'insufficient_quota' : 'gateway_unavailable', message: secret } }), { status, headers: { 'Retry-After': '999999' } });
      const output = index === 1 ? plan(2) : 'result';
      return Response.json(kind === 'openai' ? { choices: [{ message: { content: output } }] }
        : { type: 'message', role: 'assistant', content: [{ type: 'text', text: output }] });
    };
    const adapter = kind === 'openai' ? new OpenAICompatibleProvider({ id: kind, displayName: kind, baseUrl: 'https://example.test/v1', model: 'test', apiKey: secret }, fetcher)
      : new AnthropicProvider({ model: 'test', apiKey: secret }, fetcher);
    const f = setup((request, options) => adapter.execute(request, options)); const result = await f.service.run(userRequest);
    assert.equal(result.status, status === 429 ? 'failed' : 'completed'); assert.equal(wire.length, status === 429 ? 2 : 4);
    if (status !== 429) assert.equal(wire[1], wire[2]); safe(f.calls); safe(f.replies); safe(result);
    assert.ok(wire.every((body) => !body.includes(secret) && !body.includes('insufficient_quota')));
    assert.deepEqual(toProviderFailure(temporary(status)), { code: 'HTTP_ERROR', message: new ProviderError('HTTP_ERROR', status).message, httpStatus: status });
  }
});
test('retry policy is provider-neutral and execution-output validation cannot masquerade as a retryable HTTP error', async () => {
  const source = await readFile(new URL('../src/application/auto-step-retry.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /openai|anthropic|claude|fetch\s*\(|electron|react|window\./i);
  let calls = 0; const provider = { id: 'text', displayName: 'text', execute: async () => { calls++; return { output: 'text' }; } };
  const engine = new LoopService({ plan: () => [{ title: 'a' }], validateOutput: () => { throw temporary(); } }, provider, { autoTextRetry: {} });
  const initial = { ...engine.create(userRequest), auto: { phase: 'executing' as const } };
  const result = await engine.run(initial); assert.equal(result.status, 'failed'); assert.equal(calls, 1);
});
