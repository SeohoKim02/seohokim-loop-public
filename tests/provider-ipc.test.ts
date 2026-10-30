// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { createProviderGateway } from '../electron/provider-gateway.ts';
import { registerProviderIpc } from '../electron/provider-ipc.ts';
import { OpenAICompatibleProvider } from '../electron/providers/openai-compatible.ts';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import { ProviderError } from '../src/providers/provider-error.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';
import type { AIProvider, ProviderResponse } from '../src/providers/ai-provider.ts';
import type { ProviderBridge, ProviderExecution, ProviderReply } from '../src/providers/provider-ipc.ts';

const input: ProviderExecution = {
  providerId: 'stub', request: { userRequest: '간단한 결과', stepTitle: '초안 생성', previousOutputs: [], isFinalStep: true },
};
function setup(execute: AIProvider['execute'] = async () => ({ output: '완료' })) {
  const registry = new ProviderRegistry();
  registry.register({ id: 'stub', displayName: 'Stub AI', execute }, { type: 'stub', configured: true });
  return { registry, gateway: createProviderGateway(registry) };
}

test('IPC gateway rejects arbitrary URLs, keys, extra fields and malformed/oversized requests', async () => {
  let calls = 0;
  const { gateway } = setup(async () => { calls += 1; return { output: '완료' }; });
  const invalid = [null, [], {}, 'command', { ...input, url: 'https://example.test' }, { ...input, apiKey: 'secret' },
    { ...input, providerId: '' }, { ...input, request: null },
    { ...input, request: { ...input.request, baseUrl: 'https://example.test' } },
    { ...input, request: { ...input.request, userRequest: ' ' } },
    { ...input, request: { ...input.request, userRequest: 'a'.repeat(20_001) } },
    { ...input, request: { ...input.request, stepTitle: 12 } },
    { ...input, request: { ...input.request, isFinalStep: 'true' } },
    { ...input, request: { ...input.request, previousOutputs: [null] } },
    { ...input, request: { ...input.request, previousOutputs: Array(21).fill('output') } },
    { ...input, request: { ...input.request, previousOutputs: Array(3).fill('x'.repeat(100_000)) } },
  ];
  for (const value of invalid) {
    const result = await gateway.executeProvider(value as ProviderExecution);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'INVALID_REQUEST');
  }
  assert.equal(calls, 0);
  const missing = await gateway.executeProvider({ ...input, providerId: 'missing' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, 'PROVIDER_NOT_FOUND');
});

test('gateway sanitizes unexpected exceptions and reconstructs known error messages', async () => {
  for (const cause of [new Error('test-key-sensitive'), 'test-key-sensitive', Object.assign(new ProviderError('HTTP_ERROR', 401), { message: 'test-key-sensitive' })]) {
    const { gateway } = setup(async () => { throw cause; });
    const reply = await gateway.executeProvider(input);
    assert.equal(reply.ok, false);
    assert.ok(!JSON.stringify(reply).includes('test-key-sensitive'));
    assert.ok(!JSON.stringify(reply).includes('stack'));
    if (!reply.ok) assert.equal(reply.error.code, cause instanceof ProviderError ? 'HTTP_ERROR' : 'EXECUTION_FAILED');
  }
});

test('gateway permits only one in-flight execution and releases after success or failure', async () => {
  let finish!: (response: ProviderResponse) => void;
  let calls = 0;
  const { gateway } = setup(async () => {
    calls += 1;
    if (calls === 1) return new Promise((resolve) => { finish = resolve; });
    if (calls === 2) throw new Error('failed');
    return { output: '다시 완료' };
  });
  const running = gateway.executeProvider(input);
  const duplicate = await gateway.executeProvider(input);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, 'BUSY');
  assert.equal(calls, 1);
  finish({ output: '완료' });
  assert.equal((await running).ok, true);
  assert.equal((await gateway.executeProvider(input)).ok, false);
  assert.equal((await gateway.executeProvider(input)).ok, true);
});

test('single-work Mock Planner uses contract + IPC adapter to call HTTP once and reach Final Result', async () => {
  let calls = 0;
  const provider = new OpenAICompatibleProvider({ id: 'stub', displayName: 'Custom', apiKey: 'test-only', model: 'test', baseUrl: 'https://example.test/v1' }, async () => {
    calls += 1;
    return Response.json({ choices: [{ message: { content: '실제 형식의 생성 결과' } }] });
  });
  const registry = new ProviderRegistry();
  registry.register(provider, { type: 'openai-compatible', configured: true });
  const service = new LoopService(new MockPlanner('single-work'), new IpcProvider(registry.list()[0]!, createProviderGateway(registry)));
  const result = await service.run(service.create('작업 요청'));
  assert.equal(calls, 1);
  assert.equal(result.steps.length, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.finalResult, '실제 형식의 생성 결과');
});

test('Provider failures pass safely through IPC and mark the current Step and Loop failed', async () => {
  const { registry, gateway } = setup(async () => { throw new ProviderError('HTTP_ERROR', 401); });
  const service = new LoopService(new MockPlanner(), new IpcProvider(registry.list()[0]!, gateway));
  const result = await service.run(service.create('작업 요청'));
  assert.equal(result.status, 'failed');
  assert.equal(result.steps[0]?.status, 'failed');
  assert.match(result.error!, /HTTP_ERROR.*401/);
  assert.equal(result.steps[0]?.error, result.error);
  assert.ok(result.steps.slice(1).every((step) => step.status === 'pending'));
  assert.equal(result.finalResult, undefined);
});

test('IPC transport rejection is safe and distinct from provider failure', async () => {
  const { registry, gateway } = setup();
  const provider = new IpcProvider(registry.list()[0]!, {
    ...gateway, executeProvider: async () => { throw new Error('sensitive transport details'); },
  });
  await assert.rejects(provider.execute(input.request), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'IPC_UNAVAILABLE');
    assert.ok(!error.message.includes('sensitive'));
    return true;
  });
});

test('Electron IPC accepts only the owning window main frame with the exact renderer URL', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipc: Pick<IpcMain, 'handle' | 'removeHandler'> = {
    handle: (name, handler) => { handlers.set(name, handler); },
    removeHandler: (name) => { handlers.delete(name); },
  };
  const frame = { url: 'file:///app/dist/index.html' };
  const contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents;
  const { gateway } = setup();
  const dispose = registerProviderIpc(ipc, contents, frame.url, gateway);
  assert.deepEqual([...handlers.keys()], ['seohokim-loop:ollama:select-model', 'seohokim-loop:providers:list', 'seohokim-loop:providers:execute', 'seohokim-loop:execution:cancel', 'seohokim-loop:providers:test-connection',
    'seohokim-loop:connections:get', 'seohokim-loop:connections:save', 'seohokim-loop:connections:remove']);
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent;
  const call = async (candidate: IpcMainInvokeEvent): Promise<ProviderReply<unknown>> =>
    await handlers.get('seohokim-loop:providers:execute')!(candidate, input) as ProviderReply<unknown>;
  assert.equal((await call(event)).ok, true);
  for (const candidate of [
    { ...event, sender: {} }, { ...event, senderFrame: null },
    { ...event, senderFrame: { url: frame.url } }, // Even a same-URL subframe is denied.
  ]) {
    const reply = await call(candidate as IpcMainInvokeEvent);
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.equal(reply.error.code, 'IPC_FORBIDDEN');
    const deniedModel = await handlers.get('seohokim-loop:ollama:select-model')!(candidate as IpcMainInvokeEvent, 'local:latest') as ProviderReply<unknown>;
    assert.equal(deniedModel.ok, false);
    if (!deniedModel.ok) assert.equal(deniedModel.error.code, 'IPC_FORBIDDEN');
    const deniedCancel = await handlers.get('seohokim-loop:execution:cancel')!(candidate as IpcMainInvokeEvent, crypto.randomUUID()) as ProviderReply<unknown>;
    assert.equal(deniedCancel.ok, false);
    if (!deniedCancel.ok) assert.equal(deniedCancel.error.code, 'IPC_FORBIDDEN');
    const checkReply = await handlers.get('seohokim-loop:providers:test-connection')!(candidate as IpcMainInvokeEvent, 'stub') as Awaited<ReturnType<ProviderBridge['testConnection']>>;
    assert.equal(checkReply.ok, false);
    if (!checkReply.ok) assert.equal(checkReply.code, 'unavailable');
    for (const channel of ['get', 'save', 'remove']) {
      const denied = await handlers.get(`seohokim-loop:connections:${channel}`)!(candidate as IpcMainInvokeEvent, 'openai-compatible') as ProviderReply<unknown>;
      assert.equal(denied.ok, false);
      if (!denied.ok) assert.equal(denied.error.code, 'IPC_FORBIDDEN');
    }
  }
  frame.url = 'https://untrusted.test/';
  assert.equal((await call(event)).ok, false);
  const listReply = await handlers.get('seohokim-loop:providers:list')!(event) as Awaited<ReturnType<ProviderBridge['listProviders']>>;
  assert.equal(listReply.ok, false);
  const checkReply = await handlers.get('seohokim-loop:providers:test-connection')!(event, 'stub') as Awaited<ReturnType<ProviderBridge['testConnection']>>;
  assert.equal(checkReply.ok, false);
  if (!checkReply.ok) assert.equal(checkReply.code, 'unavailable');
  dispose();
  assert.equal(handlers.size, 0);
});
