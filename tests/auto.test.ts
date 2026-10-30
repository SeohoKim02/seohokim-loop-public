// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { TaskPlanner, parseTaskPlan } from '../src/application/task-planner.ts';
import { autoProviderPool, assignAutoProviders } from '../src/application/auto-router.ts';
import { AutoLoopService, autoContext, AUTO_OUTPUT_LIMIT, AUTO_CONTEXT_LIMIT } from '../src/application/auto-loop-service.ts';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import { MockProvider } from '../src/providers/mock-provider.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';
import type { AIProvider, ProviderRequest } from '../src/providers/ai-provider.ts';
import type { ProviderExecution } from '../src/providers/provider-ipc.ts';
import type { Loop } from '../src/domain/loop.ts';
import { OpenAICompatibleProvider } from '../electron/providers/openai-compatible.ts';
import { AnthropicProvider } from '../electron/providers/anthropic.ts';
import { createProviderGateway, validateExecution } from '../electron/provider-gateway.ts';

const userRequest = '두 가지 접근을 비교해 설명해주세요.';
const secrets = ['fake-auto-openai-key', 'fake-auto-claude-key'];
function plan(count = 3) {
  return { title: '접근 비교', steps: Array.from({ length: count }, (_, index) => ({
    title: `동적 작업 ${index + 1}`, role: index === count - 1 ? 'deliver' : index === 1 ? 'review' : 'write',
    objective: `구체적 목표 ${index + 1}`, usesPreviousOutputs: index > 0, isFinal: index === count - 1,
  })) };
}
function safe(value: unknown) {
  const text = JSON.stringify(value);
  for (const key of secrets) assert.ok(!text.includes(key));
  assert.doesNotMatch(text, /apiKey|encryptedApiKey|Authorization|x-api-key|debugLogs|stack/);
}
function provider(id: string, execute: AIProvider['execute'] = async () => ({ output: '결과' })): AIProvider {
  return { id, displayName: id, execute };
}

for (const count of [2, 3, 4, 5]) test(`planner accepts ${count} dynamic steps, strips unknown IDs/commands and normalizes fence`, async () => {
  const source = { ...plan(count), command: 'never execute', steps: plan(count).steps.map((step) => ({ ...step, id: 'duplicate', providerId: 'chosen-by-model' })) };
  let calls = 0;
  const planner = new TaskPlanner(provider('neutral', async (request) => {
    calls++; assert.equal(request.userRequest, userRequest); assert.equal(request.previousOutputs.length, 0);
    assert.ok(request.objective!.length <= 2000); safe(request);
    return { output: '\n```json\n' + JSON.stringify(source) + '\n```\n' };
  }));
  const parsed = await planner.plan(userRequest);
  assert.deepEqual(parsed, plan(count)); assert.equal(calls, 1); assert.ok(Object.isFrozen(parsed.steps));
});

const invalidPlans: [string, unknown][] = [
  ['missing steps', { title: 'a' }], ['array', []], ['null', null], ['too few', plan(1)], ['too many', plan(6)],
  ['no final', { ...plan(), steps: plan().steps.map((s) => ({ ...s, isFinal: false })) }],
  ['two finals', { ...plan(), steps: plan().steps.map((s, i) => ({ ...s, isFinal: i > 0 })) }],
  ['final not last', { ...plan(), steps: plan().steps.map((s, i) => ({ ...s, isFinal: i === 0 })) }],
  ['long plan title', { ...plan(), title: 'x'.repeat(81) }],
  ...(['title', 'objective', 'role', 'usesPreviousOutputs', 'isFinal'] as const).map((field): [string, unknown] => {
    const source = plan(); delete (source.steps[0] as Record<string, unknown>)[field]; return [`missing ${field}`, source];
  }),
  ['unknown role', { ...plan(), steps: plan().steps.map((s) => ({ ...s, role: 'shell' })) }],
  ['long objective', { ...plan(), steps: plan().steps.map((s) => ({ ...s, objective: 'x'.repeat(1201) })) }],
  ['long step title', { ...plan(), steps: plan().steps.map((s) => ({ ...s, title: 'x'.repeat(81) })) }],
  ['blank objective', { ...plan(), steps: plan().steps.map((s) => ({ ...s, objective: ' ' })) }],
  ['review without context', { ...plan(), steps: plan().steps.map((s) => ({ ...s, usesPreviousOutputs: false })) }],
];
for (const [name, value] of invalidPlans) test(`plan validation rejects ${name}`, () => {
  assert.throws(() => parseTaskPlan(JSON.stringify(value)), /작업 계획/);
});
test('plan parser rejects malformed JSON, code, excess size and trailing text safely', () => {
  for (const output of ['not json', 'globalThis.compromised = true', secrets[0]!, 'x'.repeat(20001), `${JSON.stringify(plan())} extra`]) {
    assert.throws(() => parseTaskPlan(output), (error) => { safe(error); return true; });
  }
});

test('pool excludes unconfigured/unresolvable adapters and prefers real over explicit test Mock', () => {
  const registry = new ProviderRegistry();
  registry.register(provider('mock'), { type: 'mock', configured: true });
  registry.register(provider('unconfigured'), { type: 'future', configured: false });
  registry.register(provider('missing-runtime'), { type: 'future', configured: true });
  registry.register(provider('vendor-neutral'), { type: 'future', configured: true });
  const view = { list: () => registry.list(), get: (id: string) => {
    if (id === 'missing-runtime') throw new Error('not available'); return registry.get(id);
  } };
  assert.deepEqual(autoProviderPool(view, true).map((p) => p.id), ['vendor-neutral']);
});
test('router deterministic diversity and review avoid latest producer regardless of company', () => {
  const parsed = parseTaskPlan(JSON.stringify(plan(5)));
  const pool = ['arbitrary-z', 'arbitrary-a', 'arbitrary-b'].map((id) => provider(id));
  const assigned = assignAutoProviders(parsed, pool);
  assert.deepEqual(assigned, assignAutoProviders(parsed, pool));
  assert.deepEqual(assigned.map((s) => s.providerId), ['arbitrary-z', 'arbitrary-a', 'arbitrary-b', 'arbitrary-z', 'arbitrary-a']);
  assert.notEqual(assigned[0]!.providerId, assigned[1]!.providerId);
  assert.ok(assignAutoProviders(parsed, [pool[0]!]).every((s) => s.providerId === pool[0]!.id));
  assert.throws(() => assignAutoProviders(parsed, []));
});
test('review rule overrides least-used tie break to avoid self review', () => {
  const source = plan(4); source.steps[2]!.role = 'review';
  const assigned = assignAutoProviders(parseTaskPlan(JSON.stringify(source)), [provider('a'), provider('b')]);
  assert.deepEqual(assigned.map((s) => s.providerId), ['a', 'b', 'a', 'b']);
});

function integration(ids: string[], options: { failAt?: number; malformedAt?: number; planOutput?: string; count?: number; echo?: boolean } = {}) {
  const calls: ProviderExecution[] = [];
  const wire: { id: string; content: string }[] = [];
  const replies: unknown[] = [];
  const main = new ProviderRegistry();
  const fetcher = (id: string): typeof fetch => async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    wire.push({ id, content: body.messages[0].content });
    const index = calls.length - 1;
    if (index === options.failAt) return new Response(secrets.join(' '), { status: 401 });
    const output = index === 0 ? options.planOutput ?? JSON.stringify(plan(options.count))
      : index === options.malformedAt ? '' : `${id} result ${index}${options.echo ? ` ${id === 'anthropic' ? secrets[1] : secrets[0]}` : ''}`;
    return Response.json(id === 'anthropic' ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: output }] }
      : { choices: [{ message: { content: output } }] });
  };
  main.register(new MockProvider(async () => {}), { type: 'mock', configured: true });
  for (const id of ids) main.register(id === 'anthropic' ? new AnthropicProvider({ model: 'test-model', apiKey: secrets[1] }, fetcher(id))
    : new OpenAICompatibleProvider({ id, displayName: id, baseUrl: 'https://example.test/v1', model: 'test-model', apiKey: secrets[0] }, fetcher(id)),
  { type: id, configured: true });
  const gateway = createProviderGateway(main);
  const bridge = { ...gateway, async executeProvider(input: ProviderExecution) {
    calls.push(structuredClone(input)); const reply = await gateway.executeProvider(input); replies.push(reply); return reply;
  } };
  const renderer = new ProviderRegistry();
  for (const summary of main.list()) renderer.register(new IpcProvider(summary, bridge), summary);
  return { service: new AutoLoopService(renderer), calls, wire, replies, renderer };
}

for (const ids of [['openai-compatible', 'anthropic'], ['openai-compatible'], ['anthropic']]) {
  test(`Auto complete contract/IPC/fake HTTP integration: ${ids.join('+')}`, async () => {
    const { service, calls, wire, replies } = integration(ids, { echo: true, count: 5 });
    const snapshots: Loop[] = [];
    const result = await service.run(userRequest, (loop) => snapshots.push(loop));
    assert.equal(result.status, 'completed'); assert.equal(result.mode, 'auto'); assert.equal(result.collaboration, undefined);
    assert.equal(calls.length, 6); assert.equal(calls[0]!.providerId, ids[0]); assert.equal(calls[0]!.request.stepTitle, '작업 계획 준비');
    assert.equal(result.auto?.planner?.id, ids[0]); assert.equal(result.steps.length, 5);
    assert.equal(new Set(result.steps.map((s) => s.id)).size, 5);
    assert.deepEqual(calls.slice(1).map((c) => c.providerId), result.steps.map((s) => s.assignedProvider.id));
    if (ids.length > 1) assert.notEqual(result.steps[0]!.assignedProvider.id, result.steps[1]!.assignedProvider.id);
    assert.equal(result.finalResult, result.steps.find((s) => s.isFinal)!.output);
    assert.equal(snapshots[0]!.auto?.phase, 'planning'); assert.equal(snapshots[0]!.steps.length, 0);
    assert.ok(snapshots.every((s) => s.id === result.id));
    for (const [index, step] of result.steps.entries()) {
      assert.deepEqual(calls[index + 1]!.request.previousOutputs, result.steps.slice(0, index).map((s) => s.output));
      assert.equal(calls[index + 1]!.request.objective, step.objective);
      assert.equal(calls[index + 1]!.request.isFinalStep, step.isFinal);
      assert.ok(wire[index + 1]!.content.includes(step.objective!));
      assert.ok(step.startedAt && step.completedAt); assert.equal(step.retryCount, 0);
      const states = snapshots.map((s) => s.steps[index]?.status).filter(Boolean);
      assert.deepEqual(states.filter((s, i) => i === 0 || s !== states[i - 1]), ['pending', 'running', 'completed']);
    }
    for (const snapshot of snapshots) {
      assert.ok(snapshot.steps.filter((s) => s.status === 'running').length <= 1);
      if (snapshot.status !== 'completed') assert.equal(snapshot.finalResult, undefined);
    }
    for (const call of calls) assert.equal(call.request.userRequest, userRequest);
    safe(calls); safe(wire); safe(replies); safe(result);
  });
}

test('ordinary Auto with no real AI fails without calling Mock; explicit offline test Auto works', async () => {
  let count = 0;
  const mock = new MockProvider(async () => {});
  const registry = new ProviderRegistry();
  registry.register({ ...provider('mock'), execute: async (request) => {
    count++; return request.stepTitle === '작업 계획 준비' ? { output: JSON.stringify(plan(2)) } : mock.execute(request);
  } }, { type: 'mock', configured: true });
  const ordinary = await new AutoLoopService(registry).run(userRequest);
  assert.equal(ordinary.status, 'failed'); assert.match(ordinary.error!, /먼저 사용할 AI/); assert.equal(count, 0);
  const result = await new AutoLoopService(registry, { allowTestMock: true }).run(userRequest);
  assert.equal(result.status, 'completed'); assert.match(result.finalResult!, /Mock AI/); assert.equal(count, 3);
});

for (const options of [{ failAt: 0 }, { planOutput: secrets[0] }, { planOutput: JSON.stringify(plan(6)) }]) {
  test(`planner failure stops before steps: ${Object.keys(options)[0]} ${options.failAt ?? options.planOutput?.length}`, async () => {
    const { service, calls, replies } = integration(['openai-compatible'], options);
    const result = await service.run(userRequest);
    assert.equal(result.status, 'failed'); assert.equal(result.steps.length, 0); assert.equal(calls.length, options.failAt === 0 ? 1 : 2);
    assert.equal(result.error, '작업 계획을 만들지 못했습니다.'); safe(result); safe(replies);
  });
}
for (const failedIndex of [1, 2, 3]) test(`Auto step failure ${failedIndex} stops subsequent work and hides raw server errors`, async () => {
  const { service, calls, replies } = integration(['openai-compatible', 'anthropic'], { failAt: failedIndex });
  const result = await service.run(userRequest);
  assert.equal(result.status, 'failed'); assert.equal(calls.length, failedIndex + 1); assert.equal(result.finalResult, undefined);
  const failed = result.steps[failedIndex - 1]!;
  assert.equal(failed.status, 'failed'); assert.ok(failed.role); assert.ok(result.error!.includes(failed.assignedProvider.displayName));
  assert.ok(result.steps.slice(failedIndex).every((s) => s.status === 'pending' && !s.startedAt)); safe(result); safe(replies);
});
test('malformed/oversized output fails at source without passing it onward', async () => {
  const { service, calls } = integration(['anthropic'], { malformedAt: 1 });
  assert.equal((await service.run(userRequest)).steps[0]!.status, 'failed'); assert.equal(calls.length, 2);
  for (const output of ['x'.repeat(AUTO_OUTPUT_LIMIT + 1), undefined, ' ', secrets[0]]) {
    let count = 0; const registry = new ProviderRegistry();
    registry.register(provider('a', async () => {
      if (count++ === 0) return { output: JSON.stringify(plan()) };
      if (output === secrets[0]) throw new Error(output);
      return { output: output as string };
    }), { type: 'test', configured: true });
    const result = await new AutoLoopService(registry).run(userRequest);
    assert.equal(result.status, 'failed'); assert.equal(count, 2); safe(result);
  }
});
test('availability changed while planning produces safe assignment failure without work calls', async () => {
  const registry = new ProviderRegistry(); let count = 0;
  const p = provider('a', async () => { count++; registry.replace(p, { type: 'test', configured: false }); return { output: JSON.stringify(plan()) }; });
  registry.register(p, { type: 'test', configured: true });
  const result = await new AutoLoopService(registry).run(userRequest);
  assert.equal(result.status, 'failed'); assert.match(result.error!, /배정/); assert.equal(count, 1);
});
test('duplicate Start guard spans planning and every step, then releases for next Loop', async () => {
  const registry = new ProviderRegistry(); let count = 0;
  const releases: (() => void)[] = []; const arrivals: (() => void)[] = [];
  const arrived = Array.from({ length: 4 }, () => new Promise<void>((resolve) => arrivals.push(resolve)));
  registry.register(provider('a', async () => {
    const index = count++; arrivals[index]?.(); await new Promise<void>((resolve) => releases.push(resolve));
    return { output: index === 0 ? JSON.stringify(plan()) : `result ${index}` };
  }), { type: 'test', configured: true });
  const service = new AutoLoopService(registry); const running = service.run(userRequest);
  for (let i = 0; i < 4; i++) {
    await arrived[i]; await assert.rejects(service.run(userRequest), /현재 작업/); assert.equal(count, i + 1); releases[i]!();
  }
  assert.equal((await running).status, 'completed');
  registry.replace(provider('a', async () => { throw new Error(secrets[0]); }), { type: 'test', configured: true });
  assert.equal((await service.run(userRequest)).status, 'failed');
});
test('Auto context bounds keep latest complete results and original user request; context opt-out works', async () => {
  const outputs = Array.from({ length: 4 }, (_, i) => `${i}`.repeat(AUTO_OUTPUT_LIMIT));
  assert.deepEqual(autoContext(outputs), outputs.slice(-2)); assert.equal(autoContext(outputs).join('').length, AUTO_CONTEXT_LIMIT);
  const source = plan(5); source.steps[2]!.usesPreviousOutputs = false;
  const requests: ProviderRequest[] = []; const registry = new ProviderRegistry();
  registry.register(provider('a', async (request) => {
    requests.push(request); return { output: requests.length === 1 ? JSON.stringify(source) : outputs[(requests.length - 2) % 4]! };
  }), { type: 'test', configured: true });
  const result = await new AutoLoopService(registry).run(userRequest);
  assert.equal(result.status, 'completed'); assert.deepEqual(requests[3]!.previousOutputs, []);
  assert.deepEqual(requests[5]!.previousOutputs, outputs.slice(-2));
  for (const request of requests) assert.equal(request.userRequest, userRequest);
});
test('new objective IPC field is bounded text; URLs/commands/additional keys remain forbidden', () => {
  const input = { providerId: 'p', request: { userRequest, stepTitle: 'a', previousOutputs: [], isFinalStep: false, objective: 'a'.repeat(2000) } };
  assert.deepEqual(validateExecution(input), input);
  for (const objective of ['', null, {}, 'a'.repeat(2001)]) assert.throws(() => validateExecution({ ...input, request: { ...input.request, objective } }));
  for (const field of ['url', 'command', 'headers', 'apiKey']) assert.throws(() => validateExecution({ ...input, request: { ...input.request, [field]: 'forbidden' } }));
});
test('blank/oversized requests spend nothing; Auto modules have no concrete adapters, company routing or UI dependencies', async () => {
  let calls = 0; const registry = new ProviderRegistry();
  registry.register(provider('a', async () => { calls++; return { output: '' }; }), { type: 'test', configured: true });
  const service = new AutoLoopService(registry);
  await assert.rejects(service.run(' ')); await assert.rejects(service.run('x'.repeat(20001))); assert.equal(calls, 0);
  for (const file of ['auto-loop-service.ts', 'auto-router.ts', 'task-planner.ts']) {
    const source = await readFile(new URL(`../src/application/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /openai|anthropic|claude|electron|fetch\s*\(|react|window\.|eval\s*\(|new Function/i);
  }
});
