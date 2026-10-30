// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAICompatibleProvider } from '../electron/providers/openai-compatible.ts';
import { AnthropicProvider } from '../electron/providers/anthropic.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';
import { ProviderError } from '../src/providers/provider-error.ts';

const config = { id: 'openai-compatible', displayName: 'Test', baseUrl: 'https://api.openai.com/v1', model: 'test-model', apiKey: 'test-only-key' };
const request = { userRequest: '짧은 설명', stepTitle: '작성', previousOutputs: [], isFinalStep: true };
function provider(kind: 'openai' | 'claude', reason: string | undefined, onCall = () => {}) {
  const fetcher: typeof fetch = async () => {
    onCall();
    return Response.json(kind === 'openai'
      ? { choices: [{ message: { content: '아직 완성되지 않은 답변' }, ...(reason === undefined ? {} : { finish_reason: reason }) }] }
      : { type: 'message', role: 'assistant', content: [{ type: 'text', text: '아직 완성되지 않은 답변' }], ...(reason === undefined ? {} : { stop_reason: reason }) });
  };
  return kind === 'openai' ? new OpenAICompatibleProvider(config, fetcher) : new AnthropicProvider(config, fetcher);
}
for (const [kind, reasons] of [
  ['openai', ['length', 'content_filter', 'tool_calls', 'function_call']],
  ['claude', ['max_tokens', 'model_context_window_exceeded', 'pause_turn', 'tool_use', 'refusal']],
] as const) {
  for (const reason of reasons) test(`${kind}: ${reason} must not become a successful final result`, async () => {
    let calls = 0; const adapter = provider(kind, reason, () => calls++);
    const service = new LoopService(new MockPlanner('single-work'), adapter);
    const loop = await service.run(service.create(request.userRequest));
    assert.equal(loop.status, 'failed'); assert.equal(loop.steps[0]?.status, 'failed');
    assert.equal(loop.finalResult, undefined); assert.equal(loop.steps[0]?.output, undefined);
    assert.equal(calls, 1, 'No implicit paid retry or continuation');
  });
}
for (const kind of ['openai', 'claude'] as const) test(`${kind}: ordinary text and omitted legacy stop metadata remain compatible`, async () => {
  for (const reason of [undefined, ...(kind === 'openai' ? ['stop'] : ['end_turn', 'stop_sequence'])]) {
    assert.equal((await provider(kind, reason).execute(request)).output, '아직 완성되지 않은 답변');
  }
});
for (const kind of ['openai', 'claude'] as const) test(`${kind}: tiny connection probe may reach its token limit, execution may not`, async () => {
  const adapter = provider(kind, kind === 'openai' ? 'length' : 'max_tokens');
  await adapter.testConnection();
  await assert.rejects(() => adapter.execute(request), (cause) => cause instanceof ProviderError && cause.code === 'EXECUTION_FAILED');
});
