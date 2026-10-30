// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAICompatibleProvider } from '../electron/providers/openai-compatible.ts';
import { createProviderGateway } from '../electron/provider-gateway.ts';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import { ProviderError } from '../src/providers/provider-error.ts';
import { connectionCheckFailure } from '../src/providers/connection-check.ts';
import type { ConnectionCheckResult } from '../src/providers/connection-check.ts';
import type { AIProvider, ProviderResponse } from '../src/providers/ai-provider.ts';
import { MockProvider } from '../src/providers/mock-provider.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';
import type { Loop } from '../src/domain/loop.ts';

const secret = 'connection-check-fake-secret';
const config = { id: 'custom', displayName: 'Custom AI', baseUrl: 'https://example.test/v1', model: 'test-model', apiKey: secret };
const success = () => Response.json({ choices: [{ message: { content: 'OK' } }] });
const request = { userRequest: '보존할 작업', stepTitle: '초안 생성', previousOutputs: [], isFinalStep: true };

function setup(provider: AIProvider) {
  const registry = new ProviderRegistry();
  const unavailableReason = provider instanceof OpenAICompatibleProvider ? provider.configurationError : undefined;
  registry.register(provider, { type: 'test', configured: !unavailableReason, unavailableReason });
  return { registry, gateway: createProviderGateway(registry) };
}

function safeResult(result: ConnectionCheckResult) {
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.deepEqual(Object.keys(result).sort(), result.ok ? ['checkedAt', 'ok'] : ['checkedAt', 'code', 'ok', 'reason']);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.doesNotMatch(JSON.stringify(result), /Authorization|apiKey|baseUrl|model|stack|HTTP \d/);
}

test('explicit connection check sends exactly one tiny bounded request and returns only public success', async (context) => {
  const timeouts: number[] = [];
  context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  });
  let calls = 0;
  const provider = new OpenAICompatibleProvider(config, async (url, init) => {
    calls += 1;
    assert.equal(url, 'https://example.test/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.deepEqual(init?.headers, { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` });
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: 'test-model', stream: false, messages: [{ role: 'user', content: 'Reply with OK.' }], max_completion_tokens: 16,
    });
    return success();
  });
  const { gateway, registry } = setup(provider);
  assert.equal(registry.list()[0]?.supportsConnectionCheck, true);
  assert.equal(calls, 0);
  const result = await gateway.testConnection(provider.id);
  assert.equal(result.ok, true);
  safeResult(result);
  assert.equal(calls, 1);
  assert.deepEqual(timeouts, [15_000]);
});

test('a valid length-limited response verifies access even if reasoning consumed the tiny output budget', async () => {
  const provider = new OpenAICompatibleProvider(config, async () => Response.json({
    choices: [{ message: { content: '' }, finish_reason: 'length' }],
  }));
  await provider.testConnection();
  await assert.rejects(provider.execute(request), { code: 'RESPONSE_PARSE_ERROR' }, 'Work output must still be non-empty.');
});

test('authentication errors are friendly and never expose HTTP bodies, status text or credentials', async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    const provider = new OpenAICompatibleProvider(config, async () => {
      calls += 1;
      return new Response(`Authorization: Bearer ${secret}`, { status, statusText: secret });
    });
    const { gateway, registry } = setup(provider);
    const before = registry.list();
    const result = await gateway.testConnection(provider.id);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'authentication_failed');
      assert.equal(result.reason, '인증 정보를 확인해주세요.');
    }
    safeResult(result);
    assert.equal(calls, 1, 'No automatic retries.');
    assert.deepEqual(registry.list(), before, 'Failed checks must not change configured status.');
  }
});

test('server HTTP failures and unsupported request parameters produce safe server guidance without retry', async () => {
  for (const status of [302, 400, 429, 500, 503]) {
    let calls = 0;
    const { gateway } = setup(new OpenAICompatibleProvider(config, async () => {
      calls += 1;
      return new Response(secret, { status });
    }));
    const result = await gateway.testConnection(config.id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'server_error');
    safeResult(result);
    assert.equal(calls, 1);
  }
});

test('network exceptions and timeouts return safe unreachable messages', async (context) => {
  const provider = new OpenAICompatibleProvider(config, async () => { throw new Error(`private ${secret}`); });
  const { gateway } = setup(provider);
  for (const timeout of [false, true]) {
    if (timeout) context.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort());
    const result = await gateway.testConnection(config.id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'unreachable');
    safeResult(result);
  }
});

test('malformed JSON and unsupported completion shapes fail without remote text reaching IPC', async () => {
  const responses = [
    new Response(`invalid JSON ${secret}`),
    ...[null, {}, { choices: [] }, { choices: [null] }, { choices: [{ message: {} }] },
      { choices: [{ message: { content: null } }] }, { choices: [{ message: { content: [] } }] },
      { choices: [{ message: { content: ' ' }, finish_reason: 'stop' }] }, { error: secret }].map((body) => Response.json(body)),
  ];
  for (const response of responses) {
    const { gateway } = setup(new OpenAICompatibleProvider(config, async () => response));
    const result = await gateway.testConnection(config.id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'unsupported_response');
    safeResult(result);
  }
});

test('missing config, key, model or valid URL prevents all network access at adapter and gateway', async () => {
  const fetcher: typeof fetch = async () => { assert.fail('Incomplete configuration must never reach fetch.'); };
  for (const settings of [undefined, { ...config, apiKey: '' }, { ...config, model: '' },
    { ...config, baseUrl: '' }, { ...config, baseUrl: 'broken' }, { ...config, baseUrl: `https://example.test?key=${secret}` }]) {
    const provider = new OpenAICompatibleProvider(settings, fetcher);
    await assert.rejects(provider.testConnection(), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.ok(!String(error).includes(secret));
      return true;
    });
    const result = await setup(provider).gateway.testConnection(provider.id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'configuration_required');
    safeResult(result);
  }
});

test('unknown IDs and arbitrary URL/config payloads are rejected without calling a provider', async () => {
  const { gateway } = setup(new OpenAICompatibleProvider(config, async () => { assert.fail('Must not call fetch.'); }));
  for (const input of ['unknown', '', ' ', ' custom ', 'a'.repeat(101), 'https://example.test', null, [],
    { providerId: config.id, url: config.baseUrl, apiKey: secret }]) {
    const result = await gateway.testConnection(input as string);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'unavailable');
    safeResult(result);
  }
});

test('Mock advertises no check capability, rejects checks and still completes all five offline steps', async () => {
  const provider = new MockProvider(async () => {});
  const { registry, gateway } = setup(provider);
  assert.equal(registry.list()[0]?.supportsConnectionCheck, false);
  const result = await gateway.testConnection('mock');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'unsupported');
  const service = new LoopService(new MockPlanner(), new IpcProvider(registry.list()[0]!, gateway));
  const loop = await service.run(service.create('기존 Mock 흐름'));
  assert.equal(loop.status, 'completed');
  assert.equal(loop.steps.length, 5);
  assert.match(loop.finalResult!, /Mock AI/);
});

test('successful remote echoes and unexpected adapter return values are discarded before IPC', async () => {
  const providers: AIProvider[] = [
    new OpenAICompatibleProvider(config, async () => Response.json({ choices: [{ message: { content: secret } }], credential: secret })),
    { id: 'stub', displayName: 'Stub', execute: async () => ({ output: 'ok' }),
      testConnection: async () => ({ apiKey: secret, authorization: secret, stack: secret }) as never },
  ];
  for (const provider of providers) {
    const result = await setup(provider).gateway.testConnection(provider.id);
    assert.equal(result.ok, true);
    safeResult(result);
  }
});

test('unknown exceptions and mutated known errors only produce fixed public reasons', async () => {
  for (const error of [new Error(secret), secret, Object.assign(new ProviderError('HTTP_ERROR', 401), { message: secret, stack: secret })]) {
    const { gateway } = setup({ id: 'stub', displayName: 'Stub', execute: async () => ({ output: 'ok' }), testConnection: async () => { throw error; } });
    const result = await gateway.testConnection('stub');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, error instanceof ProviderError ? 'authentication_failed' : 'unknown_error');
    safeResult(result);
  }
});

test('same-provider checks cannot overlap and the guard releases after both success and failure', async () => {
  let finish!: () => void;
  let calls = 0;
  const { gateway } = setup({
    id: 'stub', displayName: 'Stub', execute: async () => ({ output: 'ok' }),
    testConnection: async () => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => { finish = resolve; });
      if (calls === 2) throw new Error(secret);
    },
  });
  const pending = gateway.testConnection('stub');
  const duplicate = await gateway.testConnection('stub');
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.code, 'busy');
  assert.equal(calls, 1);
  finish();
  assert.equal((await pending).ok, true);
  assert.equal((await gateway.testConnection('stub')).ok, false);
  assert.equal((await gateway.testConnection('stub')).ok, true);
  assert.equal(calls, 3);
});

test('a failed connection check cannot change a running or completed Loop or its execution lock', async () => {
  let finish!: (response: ProviderResponse) => void;
  const { registry, gateway } = setup({
    id: 'stub', displayName: 'Stub',
    execute: () => new Promise((resolve) => { finish = resolve; }),
    testConnection: async () => { throw new ProviderError('HTTP_ERROR', 401); },
  });
  const service = new LoopService(new MockPlanner('single-work'), new IpcProvider(registry.list()[0]!, gateway));
  const snapshots: Loop[] = [];
  const pending = service.run(service.create(request.userRequest), (loop) => snapshots.push(loop));
  const before = structuredClone(snapshots);
  assert.equal(snapshots.at(-1)?.status, 'running');
  assert.equal((await gateway.testConnection('stub')).ok, false);
  assert.deepEqual(snapshots, before);
  const duplicateWork = await gateway.executeProvider({ providerId: 'stub', request });
  assert.equal(duplicateWork.ok, false);
  if (!duplicateWork.ok) assert.equal(duplicateWork.error.code, 'BUSY');
  finish({ output: '보존된 결과' });
  const completed = await pending;
  const completedSnapshot = structuredClone(completed);
  assert.equal((await gateway.testConnection('stub')).ok, false);
  assert.deepEqual(completed, completedSnapshot);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.finalResult, '보존된 결과');
});

test('configuration refresh neither checks the network nor changes the last check or configuration', async () => {
  let calls = 0;
  const { gateway } = setup(new OpenAICompatibleProvider(config, async () => { calls += 1; return success(); }));
  const before = await gateway.listProviders();
  await gateway.listProviders();
  assert.equal(calls, 0);
  const checked = await gateway.testConnection(config.id);
  const copy = structuredClone(checked);
  assert.deepEqual(await gateway.listProviders(), before);
  assert.deepEqual(checked, copy);
  assert.equal(calls, 1);
});

test('transport failures use safe connection-specific guidance', () => {
  const result = connectionCheckFailure(new ProviderError('IPC_UNAVAILABLE'));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'unavailable');
  safeResult(result);
});
