// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AnthropicProvider } from '../electron/providers/anthropic.ts';
import { ConnectionStore } from '../electron/connection-store.ts';
import type { SecretEncryption } from '../electron/connection-store.ts';
import { ProviderRuntime, createProviderRegistry } from '../electron/provider-runtime.ts';
import { createProviderGateway } from '../electron/provider-gateway.ts';
import { ProviderError, toProviderFailure } from '../src/providers/provider-error.ts';
import type { ProviderErrorCode } from '../src/providers/provider-error.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';

const secret = 'fake-anthropic-unit-credential';
const openaiSecret = 'fake-openai-unit-credential';
const replacement = 'fake-claude-replacement';
const environmentSecret = 'fake-claude-environment';
const config = { model: 'test-claude-model', apiKey: secret };
const input = { providerId: 'anthropic', ...config } as const;
const openai = { baseUrl: 'https://example.test/v1', model: 'test-openai', apiKey: openaiSecret };
const request = { userRequest: '요청', stepTitle: '작업', previousOutputs: ['이전 결과'], isFinalStep: true };
const message = (text = 'CLAUDE_OK') => ({ type: 'message', role: 'assistant', content: [{ type: 'text', text }] });
const success = () => Response.json(message());
const environment = { SEOHOKIM_LOOP_ANTHROPIC_API_KEY: environmentSecret, SEOHOKIM_LOOP_ANTHROPIC_MODEL: 'environment-model' };
function safe(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const key of [secret, openaiSecret, replacement, environmentSecret]) assert.ok(!text.includes(key));
  assert.doesNotMatch(text, /encryptedApiKey|x-api-key|Authorization|stack/);
}
async function fails(action: () => Promise<unknown>, code: ProviderErrorCode) {
  await assert.rejects(action, (cause) => {
    assert.ok(cause instanceof ProviderError);
    assert.equal(cause.code, code);
    safe(String(cause)); safe(toProviderFailure(cause));
    return true;
  });
}
// Test-only authenticated encryption; desktop smoke separately exercises Windows DPAPI.
const cipherKey = randomBytes(32);
const encryption: SecretEncryption = {
  isAvailable: async () => true,
  async encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', cipherKey, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  },
  async decrypt(value) {
    const cipher = createDecipheriv('aes-256-gcm', cipherKey, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
  },
};
async function setup(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'seohokim-anthropic-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('seohokim-anthropic-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const openaiStore = new ConnectionStore(directory, encryption);
  const claudeStore = new ConnectionStore(directory, encryption, undefined, 'anthropic');
  const runtime = new ProviderRuntime(env, openaiStore, claudeStore);
  await runtime.initialize();
  return { directory, openaiStore, claudeStore, runtime, gateway: createProviderGateway(runtime.registry, runtime) };
}

test('Claude sends official Messages headers/body and normalizes multiple text blocks', async (t) => {
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return new AbortController().signal; });
  let calls = 0;
  const provider = new AnthropicProvider(config, async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'manual');
    assert.deepEqual(init?.headers, { 'Content-Type': 'application/json', 'x-api-key': secret, 'anthropic-version': '2023-06-01' });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, config.model); assert.equal(body.max_tokens, 2048); assert.equal(body.stream, false);
    assert.equal(body.messages.length, 1); assert.equal(body.messages[0].role, 'user');
    for (const value of [request.userRequest, request.stepTitle, ...request.previousOutputs]) assert.ok(body.messages[0].content.includes(value));
    assert.ok(!String(init?.body).includes(secret));
    return Response.json({ ...message(), content: [{ type: 'text', text: '첫 결과' }, { type: 'text', text: '다음 결과' }] });
  });
  assert.deepEqual(await provider.execute(request), { output: '첫 결과\n다음 결과' });
  assert.equal(calls, 1); assert.deepEqual(timeouts, [60_000]); safe(provider);
});

test('Claude missing configuration, key or model blocks fetch', async () => {
  const fetcher: typeof fetch = async () => { assert.fail('No network for incomplete settings.'); };
  for (const [settings, code] of [[undefined, 'CONFIG_MISSING'], [{ model: 'test' }, 'API_KEY_MISSING'],
    [{ ...config, apiKey: ' ' }, 'API_KEY_MISSING'], [{ apiKey: secret }, 'CONFIG_MISSING'],
    [{ ...config, model: ' ' }, 'CONFIG_MISSING'], [{ ...config, apiKey: `${secret}\n` }, 'CONFIG_INVALID']] as const) {
    const provider = new AnthropicProvider(settings, fetcher);
    assert.equal(provider.configurationError, code);
    await fails(() => provider.execute(request), code);
    await fails(() => provider.testConnection(), code);
  }
});

test('Claude HTTP authentication, rate limit, server errors and redirects hide remote bodies', async () => {
  for (const status of [302, 400, 401, 403, 429, 500, 529]) {
    let calls = 0;
    await fails(() => new AnthropicProvider(config, async () => {
      calls++; return new Response(secret, { status, statusText: secret });
    }).execute(request), 'HTTP_ERROR');
    assert.equal(calls, 1);
  }
});

test('Claude network and aborted requests are distinct safe failures', async (t) => {
  const provider = new AnthropicProvider(config, async () => { throw new Error(secret); });
  await fails(() => provider.execute(request), 'NETWORK_ERROR');
  t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort());
  await fails(() => provider.execute(request), 'TIMEOUT');
});

test('Claude malformed JSON, error envelopes, empty/non-text content are rejected', async () => {
  for (const value of [null, {}, { error: secret }, { ...message(), role: 'user' }, { ...message(), content: [] },
    { ...message(), content: [null] }, { ...message(), content: [{ type: 'tool_use', text: secret }] },
    { ...message(), content: [{ type: 'text', text: 2 }] }, message(' ')]) {
    await fails(() => new AnthropicProvider(config, async () => Response.json(value)).execute(request), 'RESPONSE_PARSE_ERROR');
  }
  await fails(() => new AnthropicProvider(config, async () => new Response(secret)).execute(request), 'RESPONSE_PARSE_ERROR');
});

test('Claude interrupted response streams remain network failures and successful echoes redact keys', async () => {
  await fails(() => new AnthropicProvider(config, async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error(secret)); },
  }))).execute(request), 'NETWORK_ERROR');
  assert.deepEqual(await new AnthropicProvider(config, async () => Response.json(message(secret))).execute(request), { output: '[REDACTED]' });
});

test('Claude tiny check is explicit, bounded, duplicate guarded and returns no generated text', async (t) => {
  const { runtime, gateway } = await setup(t);
  let calls = 0;
  let release!: () => void;
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++;
    assert.deepEqual(JSON.parse(String(init.body)), { model: config.model, stream: false, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }] });
    await new Promise<void>((resolve) => { release = resolve; });
    return Response.json(message(secret));
  });
  await gateway.saveConfiguration(input); await gateway.listProviders(); await gateway.getConfiguration('anthropic');
  assert.equal(calls, 0);
  const pending = gateway.testConnection('anthropic');
  const duplicate = await gateway.testConnection('anthropic');
  assert.equal(duplicate.ok, false); if (!duplicate.ok) assert.equal(duplicate.code, 'busy');
  release(); const result = await pending;
  assert.equal(result.ok, true); assert.deepEqual(Object.keys(result).sort(), ['checkedAt', 'ok']); safe(result);
  assert.equal(calls, 1); assert.deepEqual(timeouts, [15_000]);
  assert.equal(runtime.registry.get('anthropic').id, 'anthropic');
});

test('Claude checks normalize authentication, server, network and malformed failures', async (t) => {
  const { gateway } = await setup(t);
  await gateway.saveConfiguration(input);
  for (const [mode, expected] of [['auth', 'authentication_failed'], ['server', 'server_error'], ['network', 'unreachable'], ['parse', 'unsupported_response']] as const) {
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      if (mode === 'network') throw new Error(secret);
      return new Response(secret, { status: mode === 'auth' ? 401 : mode === 'server' ? 500 : 200 });
    });
    const result = await gateway.testConnection('anthropic');
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, expected); safe(result);
    mock.mock.restore();
  }
});

test('Registry has three independent entries and rejects unknown/unconfigured Claude', async () => {
  const registry = createProviderRegistry({});
  assert.deepEqual(registry.list().map((p) => p.id), ['mock', 'openai-compatible', 'anthropic']);
  assert.equal(registry.get('mock').id, 'mock');
  assert.throws(() => registry.get('anthropic'), { code: 'CONFIG_MISSING' });
  assert.throws(() => registry.get('unknown'), { code: 'PROVIDER_NOT_FOUND' });
  const configured = createProviderRegistry(environment);
  assert.equal(configured.get('anthropic').displayName, 'Claude');
  assert.equal(configured.list()[1]?.configured, false);
  const reply = await createProviderGateway(registry).executeProvider({ providerId: 'anthropic', request });
  assert.equal(reply.ok, false); safe(reply);
});

test('Claude encrypted file is independent, has no base URL, and public config has no credential', async (t) => {
  const { gateway, runtime, directory, claudeStore, openaiStore } = await setup(t);
  await gateway.saveConfiguration({ providerId: 'openai-compatible', ...openai });
  const before = await fs.readFile(path.join(directory, 'openai-compatible-connection.json'), 'utf8');
  const reply = await gateway.saveConfiguration(input);
  assert.equal(reply.ok, true); safe(reply); safe(await gateway.listProviders());
  assert.deepEqual(runtime.getConfiguration('anthropic'), { id: 'anthropic', model: config.model, hasApiKey: true, source: 'saved', hasSavedConfiguration: true });
  const disk = await fs.readFile(path.join(directory, 'anthropic-connection.json'), 'utf8');
  for (const key of [secret, openaiSecret]) { assert.ok(!disk.includes(key)); assert.ok(!disk.includes(Buffer.from(key).toString('base64'))); }
  assert.deepEqual(Object.keys(JSON.parse(disk)).sort(), ['encryptedApiKey', 'model', 'providerId', 'version']);
  assert.equal(await fs.readFile(path.join(directory, 'openai-compatible-connection.json'), 'utf8'), before);
  assert.deepEqual(await claudeStore.read(), config); assert.deepEqual(await openaiStore.read(), openai);
  assert.deepEqual(runtime.registry.list().map((p) => p.id), ['mock', 'openai-compatible', 'anthropic']);
  assert.equal(runtime.registry.get('openai-compatible').id, 'openai-compatible');
});

test('Claude model edits retain blank/omitted keys and explicit replacement rotates only Claude', async (t) => {
  const { gateway, claudeStore, openaiStore } = await setup(t);
  await gateway.saveConfiguration({ providerId: 'openai-compatible', ...openai }); await gateway.saveConfiguration(input);
  for (const apiKey of [undefined, '', ' ']) {
    const reply = await gateway.saveConfiguration({ providerId: 'anthropic', model: 'edited-model', apiKey });
    assert.equal(reply.ok, true); safe(reply);
    assert.deepEqual(await claudeStore.read(), { model: 'edited-model', apiKey: secret });
  }
  await gateway.saveConfiguration({ ...input, apiKey: replacement });
  assert.equal((await claudeStore.read())?.apiKey, replacement); assert.deepEqual(await openaiStore.read(), openai);
});

test('Claude saved settings override environment on restart; removal restores its own fallback', async (t) => {
  const { gateway, openaiStore, claudeStore } = await setup(t, environment);
  await gateway.saveConfiguration(input);
  const restarted = new ProviderRuntime(environment, openaiStore, claudeStore); await restarted.initialize();
  assert.equal(restarted.getConfiguration('anthropic').source, 'saved');
  assert.equal(restarted.getConfiguration('anthropic').model, config.model);
  const removed = await restarted.removeConfiguration('anthropic');
  assert.equal(removed.source, 'environment'); assert.equal(removed.model, 'environment-model'); safe(removed);
  assert.equal(await claudeStore.read(), undefined);
  await restarted.saveConfiguration({ providerId: 'anthropic', model: 'edited' });
  assert.equal((await claudeStore.read())?.apiKey, environmentSecret);
});

test('deleting either provider preserves the other credential and configured state', async (t) => {
  const { gateway, runtime, claudeStore, openaiStore } = await setup(t);
  await gateway.saveConfiguration(input); await gateway.saveConfiguration({ providerId: 'openai-compatible', ...openai });
  await gateway.removeConfiguration('anthropic');
  assert.equal(await claudeStore.read(), undefined); assert.deepEqual(await openaiStore.read(), openai);
  assert.equal(runtime.getConfiguration('anthropic').source, 'none'); assert.equal(runtime.registry.get('openai-compatible').id, 'openai-compatible');
  await gateway.saveConfiguration(input); await gateway.removeConfiguration('openai-compatible');
  assert.equal(await openaiStore.read(), undefined); assert.deepEqual(await claudeStore.read(), config);
  assert.equal(runtime.registry.get('anthropic').id, 'anthropic');
});

test('legacy OpenAI v1 file is loaded unchanged while Claude is added', async (t) => {
  const { directory, openaiStore, claudeStore } = await setup(t);
  const legacy = JSON.stringify({ version: 1, providerId: 'openai-compatible', baseUrl: openai.baseUrl,
    model: openai.model, encryptedApiKey: (await encryption.encrypt(openai.apiKey)).toString('base64') });
  const file = path.join(directory, 'openai-compatible-connection.json'); await fs.writeFile(file, legacy);
  const runtime = new ProviderRuntime({}, openaiStore, claudeStore); await runtime.initialize();
  assert.equal(runtime.getConfiguration('openai-compatible').source, 'saved');
  await runtime.saveConfiguration(input);
  assert.equal(await fs.readFile(file, 'utf8'), legacy); assert.deepEqual(await openaiStore.read(), openai);
});

test('Claude corruption or decryption failure disables only Claude without falling back', async (t) => {
  const { directory, gateway, openaiStore, claudeStore } = await setup(t, environment);
  await gateway.saveConfiguration(input); await gateway.saveConfiguration({ providerId: 'openai-compatible', ...openai });
  const file = path.join(directory, 'anthropic-connection.json');
  for (const failure of ['decrypt', 'corrupt']) {
    if (failure === 'corrupt') await fs.writeFile(file, '{}');
    const store = failure === 'decrypt' ? new ConnectionStore(directory, { ...encryption, decrypt: async () => { throw new Error(secret); } }, undefined, 'anthropic') : claudeStore;
    const runtime = new ProviderRuntime(environment, openaiStore, store); await runtime.initialize();
    assert.equal(runtime.getConfiguration('anthropic').source, 'unavailable'); safe(runtime.getConfiguration('anthropic'));
    assert.equal(runtime.registry.get('openai-compatible').id, 'openai-compatible'); assert.equal(runtime.registry.get('mock').id, 'mock');
  }
});

test('Claude fails closed when encryption is unavailable and rejects URLs/paths/secret metadata', async (t) => {
  const { directory, runtime, gateway, openaiStore } = await setup(t);
  const store = new ConnectionStore(directory, { ...encryption, isAvailable: async () => false }, undefined, 'anthropic');
  await fails(() => store.save(config), 'ENCRYPTION_UNAVAILABLE');
  assert.deepEqual(await fs.readdir(directory), []);
  await fails(() => runtime.saveConfiguration({ providerId: 'anthropic', model: 'test' }), 'KEY_REQUIRED');
  for (const extra of [{ baseUrl: 'https://bad.test' }, { path: 'C:/elsewhere' }, { command: 'test' }, { endpoint: 'http://127.0.0.1' }]) {
    await fails(() => runtime.saveConfiguration({ ...input, ...extra }), 'INVALID_REQUEST');
  }
  await gateway.saveConfiguration({ providerId: 'openai-compatible', ...openai });
  await fails(() => runtime.saveConfiguration({ ...input, model: openaiSecret }), 'CONFIG_INVALID');
  await gateway.saveConfiguration(input);
  await fails(() => runtime.saveConfiguration({ providerId: 'openai-compatible', ...openai, model: secret }), 'CONFIG_INVALID');
  assert.deepEqual(await openaiStore.read(), openai);
});

test('Claude and OpenAI execute through the same Loop contract; Claude failure leaves OpenAI intact', async (t) => {
  const { gateway, runtime, openaiStore } = await setup(t);
  let failClaude = false;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    calls++;
    if (String(url).includes('anthropic.com')) return failClaude ? new Response(secret, { status: 401 }) : success();
    return Response.json({ choices: [{ message: { content: 'OPENAI_OK' } }] });
  });
  await gateway.saveConfiguration(input); await gateway.saveConfiguration({ providerId: 'openai-compatible', ...openai });
  for (const id of ['anthropic', 'openai-compatible']) {
    const service = new LoopService(new MockPlanner('single-work'), new IpcProvider(runtime.registry.list().find((p) => p.id === id)!, gateway));
    const loop = await service.run(service.create('단일 실행'));
    assert.equal(loop.status, 'completed'); assert.equal(loop.steps.length, 1);
    assert.equal(loop.finalResult, id === 'anthropic' ? 'CLAUDE_OK' : 'OPENAI_OK');
  }
  failClaude = true;
  const service = new LoopService(new MockPlanner('single-work'), new IpcProvider(runtime.registry.list().find((p) => p.id === 'anthropic')!, gateway));
  const failed = await service.run(service.create('실패 확인'));
  assert.equal(failed.status, 'failed'); assert.equal(failed.steps[0]?.status, 'failed'); safe(failed);
  assert.equal(calls, 3); assert.deepEqual(await openaiStore.read(), openai);
  assert.equal(runtime.registry.get('openai-compatible').id, 'openai-compatible');
  for (const file of ['../src/application/loop-service.ts', '../src/domain/loop.ts']) {
    assert.doesNotMatch(await fs.readFile(new URL(file, import.meta.url), 'utf8'), /anthropic|claude|openai|fetch\s*\(/i);
  }
});
