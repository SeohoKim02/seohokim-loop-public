// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { DraftReviewImprove } from '../src/application/draft-review-improve.ts';
import { LoopService } from '../src/application/loop-service.ts';
import type { Loop } from '../src/domain/loop.ts';
import type { AIProvider, ProviderRequest } from '../src/providers/ai-provider.ts';
import type { ProviderExecution } from '../src/providers/provider-ipc.ts';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';
import { MockProvider } from '../src/providers/mock-provider.ts';
import { ProviderError } from '../src/providers/provider-error.ts';
import { OpenAICompatibleProvider } from '../electron/providers/openai-compatible.ts';
import { AnthropicProvider } from '../electron/providers/anthropic.ts';
import { createProviderGateway } from '../electron/provider-gateway.ts';

const userRequest = '전기차 시장에 대한 짧은 보고서를 작성해주세요.';
const secrets = ['fake-collaboration-openai-credential', 'fake-collaboration-anthropic-credential'];
function safe(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.ok(!text.includes(secret));
  assert.doesNotMatch(text, /apiKey|encryptedApiKey|Authorization|x-api-key|stack|debugLogs/);
}

function setup(primary: string, reviewer: string, failAt = -1) {
  const calls: ProviderExecution[] = [];
  const wire: { id: string; content: string }[] = [];
  const fetcher = (id: string): typeof fetch => async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    wire.push({ id, content: body.messages[0].content });
    if (calls.length - 1 === failAt) return new Response(secrets.join(' '), { status: 401 });
    const output = `${id} 결과 ${calls.length}`;
    return Response.json(id === 'anthropic'
      ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: output }] }
      : { choices: [{ message: { content: output } }] });
  };
  const main = new ProviderRegistry();
  main.register(new OpenAICompatibleProvider({ id: 'openai-compatible', displayName: 'OpenAI-compatible',
    baseUrl: 'https://example.test/v1', model: 'test-model', apiKey: secrets[0] }, fetcher('openai-compatible')), { type: 'openai-compatible', configured: true });
  main.register(new AnthropicProvider({ model: 'test-claude', apiKey: secrets[1] }, fetcher('anthropic')), { type: 'anthropic', configured: true });
  main.register(new MockProvider(async () => {}), { type: 'mock', configured: true });
  const gateway = createProviderGateway(main);
  const replies: unknown[] = [];
  const bridge = { ...gateway, async executeProvider(input: ProviderExecution) {
    calls.push(structuredClone(input));
    const reply = await gateway.executeProvider(input); replies.push(reply); return reply;
  } };
  const renderer = new ProviderRegistry();
  for (const summary of main.list()) renderer.register(new IpcProvider(summary, bridge), summary);
  const service = new LoopService(new DraftReviewImprove(primary, reviewer), renderer);
  return { service, calls, wire, replies, main, renderer };
}

for (const [primary, reviewer] of [['openai-compatible', 'anthropic'], ['anthropic', 'openai-compatible'],
  ['mock', 'anthropic'], ['mock', 'openai-compatible']] as const) {
  test(`collaboration ${primary} → ${reviewer} → ${primary} passes exact outputs and delivers improvement`, async () => {
    const { service, calls, wire, replies } = setup(primary, reviewer);
    const initial = service.create(userRequest);
    assert.equal(initial.mode, 'manual'); assert.equal(calls.length, 0);
    assert.deepEqual(initial.collaboration, { strategy: 'draft-review-improve', primaryProviderId: primary, reviewerProviderId: reviewer });
    const result = await service.run(initial);
    assert.deepEqual(calls.map((call) => call.providerId), [primary, reviewer, primary]);
    assert.deepEqual(calls.map((call) => call.request.isFinalStep), [false, false, true]);
    assert.deepEqual(calls.map((call) => call.request.previousOutputs), [[], [result.steps[0]!.output], [result.steps[0]!.output, result.steps[1]!.output]]);
    for (const call of calls) {
      assert.equal(call.request.userRequest, userRequest);
      assert.deepEqual(Object.keys(call.request).sort(), ['isFinalStep', 'previousOutputs', 'stepTitle', 'userRequest']);
    }
    assert.match(calls[1]!.request.stepTitle, /개선점만/);
    assert.match(calls[2]!.request.stepTitle, /검토 의견을 반영/);
    assert.equal(result.status, 'completed'); assert.equal(result.steps.length, 3);
    assert.equal(result.finalResult, result.steps[2]!.output); assert.notEqual(result.finalResult, result.steps[1]!.output);
    assert.deepEqual(result.steps.map((s) => s.role), ['primary', 'reviewer', 'primary']);
    assert.deepEqual(result.steps.map((s) => s.title), ['초안 작성', '검토', '개선']);
    for (const record of wire) assert.ok(record.content.includes(userRequest));
    assert.ok(wire.find((entry) => entry.id === reviewer)!.content.includes(result.steps[0]!.output!));
    if (primary !== 'mock') assert.ok(wire.at(-1)!.content.includes(result.steps[1]!.output!));
    safe(calls); safe(replies); safe(result); safe(wire);
  });
}

test('collaboration steps transition sequentially with immutable snapshots and timing/role records', async () => {
  const { service } = setup('openai-compatible', 'anthropic');
  const initial = service.create(userRequest);
  const snapshots: Loop[] = [initial];
  const result = await service.run(initial, (loop) => snapshots.push(loop));
  for (const [index, step] of result.steps.entries()) {
    const states = snapshots.map((loop) => loop.steps[index]!.status);
    assert.deepEqual(states.filter((state, i) => i === 0 || state !== states[i - 1]), ['pending', 'running', 'completed']);
    assert.ok(Date.parse(step.startedAt!) <= Date.parse(step.completedAt!)); assert.equal(step.retryCount, 0);
  }
  for (const snapshot of snapshots) {
    assert.ok(snapshot.steps.filter((s) => s.status === 'running').length <= 1);
    const running = snapshot.steps.findIndex((s) => s.status === 'running');
    if (running >= 0) assert.ok(snapshot.steps.slice(0, running).every((s) => s.status === 'completed'));
    if (snapshot.status !== 'completed') assert.equal(snapshot.finalResult, undefined);
  }
  assert.ok(initial.steps.every((s) => s.status === 'pending' && !s.output));
  assert.equal(snapshots.at(-1), result);
});

test('a successful credential echo is redacted before IPC and before the reviewer receives context', async () => {
  const { service, main, calls, replies, wire } = setup('openai-compatible', 'anthropic');
  let executions = 0;
  main.replace(new OpenAICompatibleProvider({ id: 'openai-compatible', displayName: 'OpenAI-compatible',
    baseUrl: 'https://example.test/v1', model: 'test-model', apiKey: secrets[0] }, async () => {
    executions++;
    return Response.json({ choices: [{ message: { content: executions === 1 ? `초안 ${secrets[0]}` : '안전한 개선본' } }] });
  }), { type: 'openai-compatible', configured: true });
  const result = await service.run(service.create(userRequest));
  assert.equal(result.status, 'completed'); assert.equal(result.finalResult, '안전한 개선본');
  assert.deepEqual(calls[1]!.request.previousOutputs, ['초안 [REDACTED]']);
  safe(result); safe(calls); safe(replies); safe(wire);
});

for (const failedIndex of [0, 1, 2]) {
  test(`collaboration failure at step ${failedIndex + 1} stops subsequent calls and records safe provider/role`, async () => {
    const { service, calls, replies } = setup('openai-compatible', 'anthropic', failedIndex);
    const result = await service.run(service.create(userRequest));
    assert.equal(result.status, 'failed'); assert.equal(result.finalResult, undefined);
    assert.equal(calls.length, failedIndex + 1);
    const failed = result.steps[failedIndex]!;
    assert.equal(failed.status, 'failed'); assert.equal(failed.role, failedIndex === 1 ? 'reviewer' : 'primary');
    assert.ok(result.error!.includes(failed.assignedProvider.displayName)); assert.ok(result.error!.includes(failed.title));
    assert.equal(failed.error, result.error); assert.ok(failed.completedAt);
    assert.ok(result.steps.slice(failedIndex + 1).every((s) => s.status === 'pending' && !s.startedAt && !s.output));
    safe(result); safe(replies); safe(calls);
    assert.equal((await service.run(service.create('다음 작업'))).status, 'completed', 'Failure releases the run guard.');
  });
}

test('collaboration sanitizes raw/modified errors and empty outputs even without IPC', async () => {
  for (const cause of [new Error(secrets[0]), secrets[0], Object.assign(new ProviderError('HTTP_ERROR', 401), { message: secrets[0] })]) {
    const registry = new ProviderRegistry();
    registry.register({ id: 'writer', displayName: 'Writer', execute: async () => { throw cause; } }, { type: 'test', configured: true });
    registry.register({ id: 'reviewer', displayName: 'Reviewer', execute: async () => { assert.fail('No review after failure.'); } }, { type: 'test', configured: true });
    const service = new LoopService(new DraftReviewImprove('writer', 'reviewer'), registry);
    const result = await service.run(service.create('요청')); assert.equal(result.status, 'failed'); safe(result);
  }
  const { service, main } = setup('openai-compatible', 'anthropic');
  main.replace({ id: 'anthropic', displayName: 'Claude', execute: async () => ({ output: ' ' }) }, { type: 'anthropic', configured: true });
  const result = await service.run(service.create('빈 검토'));
  assert.equal(result.steps[1]?.status, 'failed'); assert.equal(result.steps[2]?.status, 'pending');
});

test('missing or identical role assignments are rejected before execution', () => {
  for (const pair of [['', 'reviewer'], ['primary', ''], ['same', 'same']]) {
    assert.throws(() => new DraftReviewImprove(pair[0]!, pair[1]!));
  }
});

for (const role of ['primary', 'reviewer'] as const) {
  test(`unconfigured or unknown ${role} blocks all collaboration spending`, async () => {
    const { renderer, calls } = setup('openai-compatible', 'anthropic');
    for (const missing of ['unknown', 'unconfigured']) {
      if (missing === 'unconfigured') renderer.register({ id: missing, displayName: 'Unavailable', execute: async () => { assert.fail(); } },
        { type: 'test', configured: false, unavailableReason: 'API_KEY_MISSING' });
      const strategy = new DraftReviewImprove(role === 'primary' ? missing : 'openai-compatible', role === 'reviewer' ? missing : 'anthropic');
      assert.throws(() => new LoopService(strategy, renderer).create(userRequest), { code: missing === 'unknown' ? 'PROVIDER_NOT_FOUND' : 'API_KEY_MISSING' });
    }
    assert.equal(calls.length, 0);
  });
}

test('a provider becoming unavailable before run is checked before the first call', async () => {
  const { service, renderer, calls } = setup('openai-compatible', 'anthropic');
  const loop = service.create(userRequest);
  renderer.replace({ id: 'anthropic', displayName: 'Claude', execute: async () => { assert.fail(); } }, { type: 'anthropic', configured: false });
  await assert.rejects(service.run(loop), { code: 'CONFIG_MISSING' }); assert.equal(calls.length, 0);
});

test('duplicate collaboration run is rejected while each sequential request is pending', async () => {
  const registry = new ProviderRegistry();
  const releases: (() => void)[] = [];
  const arrivals: (() => void)[] = [];
  const arrived = Array.from({ length: 3 }, () => new Promise<void>((resolve) => arrivals.push(resolve)));
  let count = 0;
  const execute: AIProvider['execute'] = async () => {
    const index = count++; arrivals[index]!();
    await new Promise<void>((resolve) => releases.push(resolve));
    return { output: `result-${index}` };
  };
  registry.register({ id: 'p', displayName: 'P', execute }, { type: 'test', configured: true });
  registry.register({ id: 'r', displayName: 'R', execute }, { type: 'test', configured: true });
  const service = new LoopService(new DraftReviewImprove('p', 'r'), registry);
  const loop = service.create('작업'); const running = service.run(loop);
  for (let i = 0; i < 3; i++) {
    await arrived[i]; await assert.rejects(service.run(loop), /현재 작업/); assert.equal(count, i + 1); releases[i]!();
  }
  assert.equal((await running).finalResult, 'result-2');
});

test('completed, reordered, expanded or reassigned collaboration plans cannot be rerun', async () => {
  const { service, calls } = setup('openai-compatible', 'anthropic');
  const initial = service.create('요청');
  for (const steps of [[...initial.steps].reverse(), [...initial.steps, initial.steps[0]!],
    initial.steps.map((s, i) => i === 1 ? { ...s, assignedProvider: initial.steps[0]!.assignedProvider } : s)]) {
    await assert.rejects(service.run({ ...initial, steps }), /유효한 Loop/);
  }
  assert.equal(calls.length, 0);
  const completed = await service.run(initial); await assert.rejects(service.run(completed), /유효한 Loop/);
  assert.equal(calls.length, 3);
});

test('the same execution engine accepts another role plan and keeps orchestration independent of companies/UI', async () => {
  const requests: ProviderRequest[] = [];
  const registry = new ProviderRegistry();
  for (const id of ['future-provider', 'another-provider']) registry.register({ id, displayName: id,
    execute: async (request) => { requests.push(request); return { output: `${id} output` }; } }, { type: 'test', configured: true });
  const service = new LoopService({ plan: () => [
    { title: '비교', providerId: 'future-provider' }, { title: '요약', providerId: 'another-provider' },
  ] }, registry);
  const result = await service.run(service.create('다른 계획', 'manual'));
  assert.equal(result.steps.length, 2); assert.equal(result.finalResult, 'another-provider output');
  assert.equal(requests.length, 2);
  for (const file of ['loop-service.ts', 'draft-review-improve.ts']) {
    const source = await readFile(new URL(`../src/application/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /openai|anthropic|claude|electron|fetch\s*\(|react|window\./i);
  }
});
