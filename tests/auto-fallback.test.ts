// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import { readFile } from 'node:fs/promises';
import { AutoLoopService } from '../src/application/auto-loop-service.ts';
import { selectAlternativeProvider } from '../src/application/auto-router.ts';
import type { AutoRegistry } from '../src/application/auto-router.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';
import { DraftReviewImprove } from '../src/application/draft-review-improve.ts';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import { ProviderError } from '../src/providers/provider-error.ts';
import type { ProviderErrorCode } from '../src/providers/provider-error.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';
import type { AIProvider, ProviderResponse } from '../src/providers/ai-provider.ts';
import type { ProviderExecution } from '../src/providers/provider-ipc.ts';
import type { Loop } from '../src/domain/loop.ts';
import { createProviderGateway } from '../electron/provider-gateway.ts';
import { OpenAICompatibleProvider } from '../electron/providers/openai-compatible.ts';
import { AnthropicProvider } from '../electron/providers/anthropic.ts';

const request = '두 방법을 비교해주세요.';
const transient = (status = 503) => new ProviderError('HTTP_ERROR', status);
const plan = (count = 3, review = false) => JSON.stringify({ title: '비교', steps: Array.from({ length: count }, (_, i) => ({
  title: `단계 ${i + 1}`, objective: `목표 ${i + 1}`, role: i === count - 1 ? 'deliver' : review && i === 1 ? 'review' : 'write',
  usesPreviousOutputs: i > 0, isFinal: i === count - 1,
})) });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const turn = () => new Promise((resolve) => setImmediate(resolve));
function setup(outputs: (string | Error | (() => Promise<ProviderResponse>))[], ids = ['a', 'b', 'c']) {
  const main = new ProviderRegistry(); const calls: ProviderExecution[] = []; let index = 0; let checks = 0; let refreshes = 0;
  const adapters = ids.map((id): AIProvider => ({ id, displayName: id,
    testConnection: async () => { checks++; }, execute: async () => {
      const output = outputs[index++]; assert.notEqual(output, undefined, 'Unexpected call');
      if (typeof output === 'function') return output(); if (output instanceof Error) throw output;
      return { output: output! };
    } }));
  for (const adapter of adapters) main.register(adapter, { type: 'custom-text', configured: true });
  const gateway = createProviderGateway(main);
  const bridge = { ...gateway, executeProvider: async (input: ProviderExecution) => {
    calls.push(structuredClone(input)); return gateway.executeProvider(input);
  } };
  const snapshot = (): ProviderRegistry => { const current = new ProviderRegistry();
    for (const summary of main.list()) current.register(new IpcProvider(summary, bridge), summary); return current; };
  const renderer = snapshot();
  let refresh: () => Promise<AutoRegistry> = async () => snapshot();
  const service = new AutoLoopService(renderer, { retryWait: async () => {}, refreshRegistry: async () => { refreshes++; return refresh(); } });
  return { service, main, adapters, calls, gateway, renderer, snapshot,
    refresh: (callback: typeof refresh) => { refresh = callback; }, counts: () => ({ checks, refreshes }),
    disable: (id: string) => main.replace(adapters.find((a) => a.id === id)!, { type: 'custom-text', configured: false }) };
}

for (const status of [502, 503, 504]) test(`HTTP ${status}: retry then one alternative, exact context/ID, preserved completed steps`, async () => {
  const f = setup([plan(), 'one', transient(status), transient(status), 'two', 'final']); const updates: Loop[] = [];
  const result = await f.service.run(request, (l) => updates.push(l));
  assert.equal(result.status, 'completed'); assert.equal(result.finalResult, 'final');
  assert.deepEqual(f.calls.map((c) => c.providerId), ['a', 'a', 'b', 'b', 'a', 'c']);
  assert.deepEqual(f.calls[2], f.calls[3]); assert.deepEqual(f.calls[3]!.request, f.calls[4]!.request);
  assert.deepEqual(f.calls[4]!.request.previousOutputs, ['one']); assert.deepEqual(f.calls[5]!.request.previousOutputs, ['one', 'two']);
  assert.equal(new Set(f.calls.map((c) => c.executionId)).size, 1);
  assert.deepEqual(result.steps.map((s) => s.fallbackCount), [0, 1, 0]);
  assert.deepEqual(result.steps.map((s) => s.retryCount), [0, 1, 0]);
  assert.equal(result.steps[1]!.originalProvider!.id, 'b'); assert.equal(result.steps[1]!.assignedProvider.id, 'a');
  const completed = updates.find((l) => l.steps[0]?.status === 'completed')!.steps[0];
  for (const l of updates.filter((l) => l.steps[0]?.status === 'completed')) assert.equal(l.steps[0], completed);
  assert.ok(updates.filter((l) => l.steps[1]?.fallbackCount && l.steps[1]?.status !== 'completed').every((l) => l.status === 'running'));
  assert.deepEqual(f.counts(), { checks: 0, refreshes: 1 });
});
test('retry succeeds: no fallback lookup or extra call', async () => {
  const f = setup([plan(), transient(), 'one', 'two', 'final']);
  const result = await f.service.run(request); assert.equal(result.status, 'completed');
  assert.equal(f.calls.length, 5); assert.deepEqual(f.counts(), { checks: 0, refreshes: 0 });
});
test('spent retry budget allows fallback on a later first failure without another retry', async () => {
  const f = setup([plan(), transient(), 'one', transient(), 'two', 'final']);
  const result = await f.service.run(request); assert.equal(result.status, 'completed');
  assert.deepEqual(f.calls.map((c) => c.providerId), ['a', 'a', 'a', 'b', 'a', 'c']);
  assert.deepEqual(result.steps.map((s) => s.retryCount), [1, 0, 0]);
  assert.deepEqual(result.steps.map((s) => s.fallbackCount), [0, 1, 0]);
});
test('fallback also fails: no alternative retry, third provider or later work', async () => {
  const f = setup([plan(), transient(), transient(), transient()]); const result = await f.service.run(request);
  assert.equal(result.status, 'failed'); assert.equal(result.finalResult, undefined); assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls.map((c) => c.providerId), ['a', 'a', 'a', 'b']);
  assert.deepEqual(result.steps.map((s) => s.status), ['failed', 'pending', 'pending']);
  assert.match(result.error!, /^b /); assert.equal(f.counts().refreshes, 1);
});
test('fallback success spends the whole Loop budget; a later failure cannot chain', async () => {
  const f = setup([plan(), transient(), transient(), 'one', transient()]); const result = await f.service.run(request);
  assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 5); assert.equal(f.counts().refreshes, 1);
  assert.equal(result.steps[0]!.output, 'one'); assert.equal(result.steps[1]!.fallbackCount, 0);
});
test('fresh Loop has independent retry and fallback budgets after success and failure', async () => {
  const f = setup([plan(), transient(), transient(), 'one', 'two', 'final',
    plan(), transient(), transient(), transient(), plan(), transient(), transient(), 'one', 'two', 'final']);
  for (const expected of ['completed', 'failed', 'completed']) {
    const result = await f.service.run(request); assert.equal(result.status, expected);
    assert.equal(result.steps[0]!.fallbackCount, 1); assert.equal(result.steps[0]!.retryCount, 1);
  }
  assert.equal(new Set(f.calls.map((c) => c.executionId)).size, 3);
});
test('Planner repair + five steps + retry + fallback totals exactly nine requests', async () => {
  const f = setup(['invalid', plan(5), 'one', transient(), transient(), 'two', 'three', 'four', 'final']);
  const result = await f.service.run(request); assert.equal(result.status, 'completed'); assert.equal(f.calls.length, 9);
  assert.equal(result.finalResult, 'final'); assert.equal(result.steps.reduce((n, s) => n + (s.fallbackCount ?? 0), 0), 1);
});
test('review assignment follows actual producer after fallback without replanning', async () => {
  const f = setup([plan(3, true), transient(), transient(), 'one', 'review', 'final'], ['a', 'b']);
  const result = await f.service.run(request); assert.equal(result.status, 'completed');
  assert.deepEqual(result.steps.map((s) => s.assignedProvider.id), ['b', 'a', 'a']);
  assert.deepEqual(result.steps.map((s) => s.originalProvider?.id), ['a', 'b', undefined]);
  assert.equal(result.steps[1]!.fallbackCount, 0); assert.equal(result.steps[1]!.role, 'review');
  assert.deepEqual(f.calls[4]!.request.previousOutputs, ['one']); assert.equal(f.counts().refreshes, 2);
});
test('review with no available diverse candidate retains planned assignment', async () => {
  const f = setup([plan(3, true), transient(), transient(), 'one', 'review', 'final'], ['a', 'b']);
  const result = await f.service.run(request, (l) => { if (l.steps[0]?.status === 'completed') f.disable('a'); });
  assert.equal(result.steps[1]!.status, 'completed'); assert.equal(result.steps[1]!.assignedProvider.id, 'b');
  // The later planned a execution is checked by main and safely fails configuration.
  assert.equal(result.status, 'failed'); assert.equal(result.steps[2]!.fallbackCount, 0);
});
test('candidate ordering excludes same ID, Mock, unconfigured and unresolved runtime entries', () => {
  const f = setup([], ['a', 'mock', 'missing', 'off', 'z', 'b']);
  f.main.replace(f.adapters[1]!, { type: 'mock', configured: true }); f.disable('off');
  const registry = { list: () => f.main.list(), get: (id: string) => {
    if (id === 'missing') throw new ProviderError('PROVIDER_NOT_FOUND'); return f.main.get(id);
  } };
  assert.equal(selectAlternativeProvider(registry, 'a')!.id, 'z');
});
for (const kind of ['single', 'mock', 'removed', 'unresolved', 'lookup-failure']) test(`no usable candidate (${kind}) fails safely without paid probe`, async () => {
  const f = setup([plan(), transient(), transient()], kind === 'single' ? ['a'] : ['a', 'b']);
  f.refresh(async () => {
    if (kind === 'lookup-failure') throw new Error('private-secret');
    if (kind === 'mock') f.main.replace(f.adapters[1]!, { type: 'mock', configured: true });
    if (kind === 'removed') f.disable('b');
    if (kind === 'unresolved') return { list: () => f.main.list(), get: () => { throw new ProviderError('CONFIG_MISSING'); } };
    return f.snapshot();
  });
  const result = await f.service.run(request); assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 3);
  assert.equal(result.steps[0]!.fallbackCount, 0); assert.equal(f.counts().checks, 0); assert.doesNotMatch(result.error!, /private-secret/);
  if (kind !== 'lookup-failure') assert.match(result.error!, /다른 사용 가능한 AI가 없어/);
});
test('candidate removed after refreshed lookup is rejected again at the main execution boundary', async () => {
  const f = setup([plan(), transient(), transient()], ['a', 'b']);
  f.refresh(async () => { const snapshot = f.snapshot(); f.disable('b'); return snapshot; });
  const result = await f.service.run(request); assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 4);
  assert.equal(result.steps[0]!.fallbackCount, 1); assert.equal(f.counts().refreshes, 1);
  assert.match(result.error!, /설정/);
});
for (const cause of [400, 401, 403, 404, 429, 500, undefined].map<Error>((n) => new ProviderError('HTTP_ERROR', n)).concat(
  (['CONFIG_MISSING', 'API_KEY_MISSING', 'CONFIG_INVALID', 'INVALID_BASE_URL', 'INVALID_REQUEST', 'NETWORK_ERROR',
    'TIMEOUT', 'RESPONSE_PARSE_ERROR', 'EXECUTION_FAILED', 'CANCELLED'] as ProviderErrorCode[]).map((c) => new ProviderError(c, 503)),
  [new Error('private-secret 503')])) {
  test(`no fallback for ${cause instanceof ProviderError ? `${cause.code}/${cause.httpStatus}` : 'unknown'} after retry`, async () => {
    const f = setup([plan(), transient(), cause]); const result = await f.service.run(request);
    assert.equal(result.status, cause instanceof ProviderError && cause.code === 'CANCELLED' ? 'cancelled' : 'failed');
    assert.equal(f.calls.length, 3); assert.equal(f.counts().refreshes, 0); assert.doesNotMatch(result.error ?? '', /private-secret/);
  });
}
for (const output of ['', ' ', 'x'.repeat(20_001)]) test(`invalid output (${output.length}) never invokes fallback`, async () => {
  const f = setup([plan(), output]); const result = await f.service.run(request);
  assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 2); assert.equal(f.counts().refreshes, 0);
});
test('Planner transient failure never starts fallback or steps', async () => {
  const f = setup([transient()]); const result = await f.service.run(request);
  assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 1); assert.equal(f.counts().refreshes, 0);
});
for (const mode of ['single', 'manual'] as const) test(`${mode} ignores fallback options`, async () => {
  const f = setup([transient()]); const planner = mode === 'single' ? new MockPlanner('single-work') : new DraftReviewImprove('a', 'b');
  let selected = 0;
  const engine = new LoopService(planner, mode === 'single' ? f.renderer.get('a') : f.renderer,
    { autoTextRetry: {}, autoTextFallback: { select: async () => { selected++; return f.renderer.get('b'); } } });
  const result = await engine.run(engine.create(request, 'manual')); assert.equal(result.status, 'failed'); assert.equal(selected, 0); assert.equal(f.calls.length, 1);
});
for (const position of ['before-refresh', 'during-refresh', 'after-selection']) test(`cancel ${position} prevents fallback call`, async () => {
  const controller = new AbortController(); const entered = deferred<void>(); const release = deferred<AutoRegistry>();
  const f = setup([plan(), transient(), async () => { if (position === 'before-refresh') controller.abort(); throw transient(); }]);
  f.refresh(async () => {
    entered.resolve(); if (position === 'during-refresh') return release.promise;
    return { list: () => f.main.list(), get: (id) => { controller.abort(); return f.renderer.get(id); } };
  });
  const running = f.service.run(request, undefined, { signal: controller.signal });
  if (position === 'during-refresh') { await entered.promise; controller.abort(); }
  const result = await running; assert.equal(result.status, 'cancelled'); assert.equal(f.calls.length, 3);
  assert.equal(result.steps[0]!.fallbackCount, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  release.resolve(f.renderer); await turn(); assert.equal(f.calls.length, 3);
});
for (const rejection of [false, true]) test(`cancel in-flight fallback ignores late ${rejection ? 'failure' : 'success'}, clears ID, permits new Loop`, async () => {
  const entered = deferred<void>(); const late = deferred<ProviderResponse>(); const controller = new AbortController();
  const f = setup([plan(), transient(), transient(), async () => { entered.resolve(); return late.promise; }, plan(), 'one', 'two', 'final']);
  const updates: Loop[] = []; const running = f.service.run(request, (l) => updates.push(l), { signal: controller.signal });
  await entered.promise; await assert.rejects(f.service.run(request), /현재 작업/);
  assert.deepEqual(await f.gateway.cancelExecution(crypto.randomUUID()), { ok: true, value: { cancelled: false } });
  controller.abort(); const result = await running; assert.equal(result.status, 'cancelled'); assert.equal(result.finalResult, undefined);
  const count = updates.length; if (rejection) late.reject(transient()); else late.resolve({ output: 'late' }); await turn();
  assert.equal(updates.length, count); assert.equal(f.calls.length, 4); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(await f.gateway.cancelExecution(result.id), { ok: true, value: { cancelled: false } });
  assert.equal((await f.service.run(request)).status, 'completed');
});
test('cancel immediately after fallback success preserves completed output and stops next work', async () => {
  const f = setup([plan(), transient(), transient(), 'one']); const controller = new AbortController();
  const result = await f.service.run(request, (l) => { if (l.steps[0]?.status === 'completed') controller.abort(); }, { signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.steps[0]!.output, 'one'); assert.equal(f.calls.length, 4); assert.equal(result.finalResult, undefined);
});
for (const reverse of [false, true]) test(`real adapter HTTP/IPC fallback ${reverse ? 'Claude to OpenAI' : 'OpenAI to Claude'} keeps separate credentials and context`, async () => {
  const keys = ['fake-fallback-openai-key', 'fake-fallback-claude-key']; const wire: { id: string; content: string }[] = [];
  const fetcher = (id: string): typeof fetch => async (_url, init) => {
    const body = JSON.parse(String(init!.body)); const headers = new Headers(init!.headers); const content = body.messages[0].content;
    assert.equal(headers.get(id === 'a' ? 'authorization' : 'x-api-key'), id === 'a' ? `Bearer ${keys[0]}` : keys[1]);
    wire.push({ id, content }); assert.ok(keys.every((key) => !content.includes(key))); assert.ok(!content.includes('private-error'));
    if (wire.length === 2 || wire.length === 3) return new Response(`private-error ${keys.join(' ')}`, { status: 503 });
    const output = wire.length === 1 ? plan(2) : 'result';
    return Response.json(id === 'a' ? { choices: [{ message: { content: output } }] }
      : { type: 'message', role: 'assistant', content: [{ type: 'text', text: output }] });
  };
  const a = new OpenAICompatibleProvider({ id: 'a', displayName: 'a', baseUrl: 'https://example.test/v1', model: 'test', apiKey: keys[0]! }, fetcher('a'));
  const b = new AnthropicProvider({ model: 'test', apiKey: keys[1]! }, fetcher('b'));
  const registry = new ProviderRegistry(); for (const p of reverse ? [b, a] : [a, b]) registry.register(p, { type: 'real-text', configured: true });
  const gateway = createProviderGateway(registry); const renderer = new ProviderRegistry();
  for (const s of registry.list()) renderer.register(new IpcProvider(s, gateway), s);
  const result = await new AutoLoopService(renderer, { retryWait: async () => {} }).run(request);
  assert.equal(result.status, 'completed'); assert.equal(wire.length, 5);
  assert.equal(wire[1]!.content, wire[2]!.content); assert.equal(wire[2]!.content, wire[3]!.content); assert.notEqual(wire[2]!.id, wire[3]!.id);
  for (const key of [...keys, 'private-error']) assert.ok(!JSON.stringify(result).includes(key));
});
test('fallback routing and orchestration remain provider-neutral and use existing IPC', async () => {
  for (const file of ['auto-router', 'auto-loop-service', 'loop-service']) {
    const source = await readFile(new URL(`../src/application/${file}.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /OpenAICompatibleProvider|AnthropicProvider|fetch\s*\(|testConnection\s*\(/);
  }
  const ui = await readFile(new URL('../src/ui/use-loop.ts', import.meta.url), 'utf8');
  assert.match(ui, /refreshRegistry:[\s\S]*listProviders/); assert.doesNotMatch(ui, /apiKey|Authorization|baseUrl/);
});
