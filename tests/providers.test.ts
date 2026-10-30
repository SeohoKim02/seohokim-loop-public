// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import { ProviderError, toProviderFailure } from '../src/providers/provider-error.ts';
import type { ProviderErrorCode } from '../src/providers/provider-error.ts';
import { MockProvider } from '../src/providers/mock-provider.ts';
import { OpenAICompatibleProvider } from '../electron/providers/openai-compatible.ts';
import { createProviderRegistry } from '../electron/provider-runtime.ts';
import type { ProviderRequest } from '../src/providers/ai-provider.ts';

const secret = 'unit-test-credential-never-real';
const config = { id: 'custom', displayName: 'Custom AI', baseUrl: 'https://example.test/v1/', model: 'test-model', apiKey: secret };
const request: ProviderRequest = { userRequest: '짧은 소개를 작성해줘.', stepTitle: '초안 생성', previousOutputs: ['앞선 결과'], isFinalStep: true };
const success = (content = '생성 결과') => Response.json({ choices: [{ message: { content } }] });

async function expectFailure(action: () => Promise<unknown>, code: ProviderErrorCode): Promise<ProviderError> {
  let captured: ProviderError | undefined;
  await assert.rejects(action, (cause: unknown) => {
    assert.ok(cause instanceof ProviderError);
    assert.equal(cause.code, code);
    assert.ok(!String(cause).includes(secret));
    assert.ok(!JSON.stringify(toProviderFailure(cause)).includes(secret));
    captured = cause;
    return true;
  });
  return captured!;
}

test('Registry registers and retrieves providers and lists only public connection metadata', async () => {
  const registry = new ProviderRegistry();
  const mock = new MockProvider(async () => {});
  const real = new OpenAICompatibleProvider(config, async () => success());
  registry.register(mock, { type: 'mock', configured: true });
  registry.register(real, { type: 'openai-compatible', configured: true });
  assert.equal(registry.get('custom'), real);
  assert.equal(registry.get('mock'), mock);
  assert.match((await registry.get('mock').execute(request)).output, /Mock AI/);
  assert.equal((await registry.get('custom').execute(request)).output, '생성 결과');
  const connections = registry.list();
  assert.equal(connections.length, 2);
  assert.deepEqual(Object.keys(connections[1]!).sort(), ['configured', 'displayName', 'id', 'supportsConnectionCheck', 'type', 'unavailableReason']);
  assert.ok(!JSON.stringify(connections).includes(secret));
  assert.ok(!JSON.stringify(connections).includes(config.baseUrl));
  connections.pop();
  assert.equal(registry.list().length, 2);
  assert.throws(() => registry.register(mock, { type: 'mock', configured: true }), /중복/);
  assert.throws(() => registry.get('unknown'), { code: 'PROVIDER_NOT_FOUND' });
});

test('main environment configuration distinguishes absent settings, missing keys and invalid URL', () => {
  const cases: [NodeJS.ProcessEnv, ProviderErrorCode | undefined][] = [
    [{}, 'CONFIG_MISSING'],
    [{ SEOHOKIM_LOOP_OPENAI_BASE_URL: config.baseUrl, SEOHOKIM_LOOP_OPENAI_MODEL: config.model }, 'API_KEY_MISSING'],
    [{ SEOHOKIM_LOOP_OPENAI_API_KEY: secret }, 'CONFIG_MISSING'],
    [{ SEOHOKIM_LOOP_OPENAI_API_KEY: secret, SEOHOKIM_LOOP_OPENAI_MODEL: config.model, SEOHOKIM_LOOP_OPENAI_BASE_URL: 'broken' }, 'INVALID_BASE_URL'],
    [{ SEOHOKIM_LOOP_OPENAI_API_KEY: secret, SEOHOKIM_LOOP_OPENAI_MODEL: config.model, SEOHOKIM_LOOP_OPENAI_BASE_URL: config.baseUrl }, undefined],
  ];
  for (const [environment, code] of cases) {
    const registry = createProviderRegistry(environment);
    const connection = registry.list()[1]!;
    assert.equal(connection.configured, code === undefined);
    assert.equal(connection.unavailableReason, code);
    assert.equal(registry.get('mock').id, 'mock');
    if (code) assert.throws(() => registry.get(connection.id), { code });
    assert.ok(!JSON.stringify(registry.list()).includes(secret));
  }
});

test('OpenAI-compatible adapter sends one non-streaming Chat Completions request and parses text', async () => {
  let calls = 0;
  const provider = new OpenAICompatibleProvider(config, async (url, init) => {
    calls += 1;
    assert.equal(url, 'https://example.test/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(init?.headers, { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, false);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
    for (const part of [request.userRequest, request.stepTitle, ...request.previousOutputs]) {
      assert.ok(body.messages[0].content.includes(part));
    }
    assert.ok(!String(init?.body).includes(secret));
    return success();
  });
  assert.deepEqual(await provider.execute(request), { output: '생성 결과' });
  assert.equal(calls, 1);
});

test('invalid or unsafe base URLs never reach fetch, while HTTPS and loopback HTTP do', async () => {
  for (const baseUrl of ['broken', `https://user:${secret}@example.test`, `https://example.test?key=${secret}`, 'https://example.test/#fragment', 'ftp://example.test', 'http://example.test']) {
    let called = false;
    const provider = new OpenAICompatibleProvider({ ...config, baseUrl }, async () => { called = true; return success(); });
    await expectFailure(() => provider.execute(request), 'INVALID_BASE_URL');
    assert.equal(called, false);
  }
  for (const baseUrl of ['https://example.test/api/v1', 'http://127.0.0.1:1234/v1/', 'http://localhost:1234/v1', 'http://[::1]:1234/v1']) {
    const provider = new OpenAICompatibleProvider({ ...config, baseUrl }, async (url) => {
      assert.equal(String(url), `${baseUrl.replace(/\/$/, '')}/chat/completions`);
      return success();
    });
    assert.equal((await provider.execute(request)).output, '생성 결과');
  }
});

test('missing configuration and API keys fail before fetch', async () => {
  const fetcher: typeof fetch = async () => { assert.fail('fetch must not run'); };
  await expectFailure(() => new OpenAICompatibleProvider(undefined, fetcher).execute(request), 'CONFIG_MISSING');
  for (const apiKey of [undefined, '', '  ']) {
    await expectFailure(() => new OpenAICompatibleProvider({ ...config, apiKey }, fetcher).execute(request), 'API_KEY_MISSING');
  }
  await expectFailure(() => new OpenAICompatibleProvider({ ...config, model: '' }, fetcher).execute(request), 'CONFIG_MISSING');
});

test('HTTP errors and redirects expose status only, never remote body or status text', async () => {
  for (const status of [302, 401, 429, 500]) {
    const provider = new OpenAICompatibleProvider(config, async () => new Response(secret, { status, statusText: secret }));
    const error = await expectFailure(() => provider.execute(request), 'HTTP_ERROR');
    assert.equal(error.httpStatus, status);
    assert.ok(error.message.includes(`HTTP ${status}`));
  }
});

test('network exceptions are sanitized and timeouts have a distinct error code', async (context) => {
  const provider = new OpenAICompatibleProvider(config, async () => { throw new Error(`network ${secret}`); });
  await expectFailure(() => provider.execute(request), 'NETWORK_ERROR');
  context.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort());
  await expectFailure(() => provider.execute(request), 'TIMEOUT');
});

test('malformed JSON, invalid shapes and missing/empty text are parsing failures', async () => {
  const bodies: unknown[] = [null, {}, { choices: [] }, { choices: [null] }, { choices: [{ message: {} }] },
    { choices: [{ message: { content: null } }] }, { choices: [{ message: { content: [] } }] },
    { choices: [{ message: { content: ' \n' } }] }, { error: { message: secret } }];
  for (const body of bodies) {
    const provider = new OpenAICompatibleProvider(config, async () => Response.json(body));
    await expectFailure(() => provider.execute(request), 'RESPONSE_PARSE_ERROR');
  }
  await expectFailure(() => new OpenAICompatibleProvider(config, async () => new Response(secret)).execute(request), 'RESPONSE_PARSE_ERROR');
});

test('network interruption during response body reading remains a network failure', async () => {
  const provider = new OpenAICompatibleProvider(config, async () => new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError(`Connection reset ${secret}`)); },
  })));
  await expectFailure(() => provider.execute(request), 'NETWORK_ERROR');
});

test('even a successful remote echo cannot send the API key to the renderer', async () => {
  const provider = new OpenAICompatibleProvider(config, async () => success(`Echo: Bearer ${secret}`));
  assert.equal((await provider.execute(request)).output, 'Echo: Bearer [REDACTED]');
  assert.ok(!JSON.stringify(provider).includes(secret));
});

test('Loop Service depends on the provider contract, never the concrete HTTP adapter or Electron', async () => {
  const source = await readFile(new URL('../src/application/loop-service.ts', import.meta.url), 'utf8');
  assert.match(source, /import type \{ AIProvider \}/);
  assert.doesNotMatch(source, /openai|electron|fetch\s*\(/i);
  const domain = await readFile(new URL('../src/domain/loop.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(domain, /openai|electron|fetch\s*\(/i);
});
