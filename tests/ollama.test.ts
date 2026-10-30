// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http, { createServer } from 'node:http';
import { OllamaProvider, OLLAMA_ORIGIN, fetchLocalOllama } from '../electron/providers/ollama.ts';
import { OllamaStore } from '../electron/ollama-store.ts';
import { ProviderRuntime } from '../electron/provider-runtime.ts';
import { createProviderGateway } from '../electron/provider-gateway.ts';
import { ProviderError } from '../src/providers/provider-error.ts';
import type { ProviderErrorCode } from '../src/providers/provider-error.ts';
import { autoProviderPool, selectAlternativeProvider } from '../src/application/auto-router.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';
import { validOllamaModel } from '../src/providers/ollama.ts';

const model = 'local-text:latest';
const request = { userRequest: 'LOOP_OK', stepTitle: '작성', previousOutputs: ['untrusted context'], isFinalStep: true };
const entry = (name = model) => ({ name, model: name, size: 1000, digest: 'a'.repeat(64), details: { format: 'gguf' } });
const details = () => ({ details: { format: 'gguf' }, model_info: { architecture: 'test' }, capabilities: ['completion'] });
const completion = () => ({ model, done: true, done_reason: 'stop', message: { role: 'assistant', content: 'LOOP_OK' } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const code = (expected: ProviderErrorCode) => (cause: unknown) => {
  assert.ok(cause instanceof ProviderError); assert.equal(cause.code, expected); assert.doesNotMatch(String(cause), /private-secret/); return true;
};
function setup(options: { installed?: boolean; models?: (ReturnType<typeof entry> & { remote_host?: string; remote_model?: string })[]; saved?: string; timeoutMs?: number;
  override?: (route: string, init: RequestInit) => Promise<Response | undefined> | Response | undefined } = {}) {
  let saved = options.saved;
  const calls: { route: string; init: RequestInit }[] = [];
  const store = { read: async () => saved, save: async (value: string) => { saved = value; } };
  const fetcher: typeof fetch = async (url, init = {}) => {
    assert.equal(new URL(String(url)).origin, OLLAMA_ORIGIN);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.deepEqual(Object.keys(init.headers ?? {}), ['Content-Type']);
    const route = new URL(String(url)).pathname; calls.push({ route, init });
    const override = await options.override?.(route, init); if (override) return override;
    if (route === '/api/version') return json({ version: '0.34.0' });
    if (route === '/api/tags') return json({ models: options.models ?? [entry()] });
    if (route === '/api/show') return json(details());
    assert.equal(route, '/api/chat'); return json(completion());
  };
  const provider = new OllamaProvider(store, { fetch: fetcher, installed: async () => options.installed ?? true,
    timeoutMs: options.timeoutMs ?? 1000, metadataTimeoutMs: 1000 });
  return { provider, calls, store, fetcher };
}
async function ready(options: Parameters<typeof setup>[0] = {}) {
  const fixture = setup(options); await fixture.provider.refresh(); await fixture.provider.selectModel(model); return fixture;
}

for (const installed of [false, true]) test(`Ollama network unavailable distinguishes installation presence ${installed}`, async () => {
  const { provider } = setup({ installed, override: () => { throw new Error('private-secret'); } });
  await provider.refresh(); assert.equal(provider.configured, false);
  assert.equal(provider.status.state, installed ? 'stopped' : 'not_installed');
  assert.equal(provider.unavailableReason, installed ? 'OLLAMA_STOPPED' : 'OLLAMA_NOT_INSTALLED');
});
test('Ollama refresh validates metadata without chat and never auto-selects a model', async () => {
  const { provider, calls } = setup(); await provider.refresh();
  assert.equal(provider.status.state, 'select_model'); assert.equal(provider.configured, false);
  assert.deepEqual(provider.status.models, [model]); assert.equal(provider.status.version, '0.34.0');
  assert.ok(calls.every((call) => call.route !== '/api/chat'));
});
test('Ollama empty model list is not executable', async () => {
  const { provider } = setup({ models: [] }); await provider.refresh();
  assert.equal(provider.status.state, 'no_models'); await assert.rejects(provider.execute(request), code('OLLAMA_NO_MODELS'));
});

test('Ollama exposes bounded model identity and declared metadata without generating or verifying quality', async () => {
  const { provider, calls } = await ready({ override: (route) => route === '/api/show' ? json({ ...details(),
    details: { format: 'gguf', parameter_size: '4.0B', quantization_level: 'Q4_K_M' },
    model_info: { 'test.context_length': 262144, private_path: 'private-secret' },
    capabilities: ['tools', 'completion'], license: 'private-license', template: 'private-template' }) : undefined });
  const metadata = provider.status.modelMetadata![0]!;
  assert.deepEqual(metadata.identity, { providerId: provider.id, modelId: model, digest: 'a'.repeat(64), runtimeVersion: '0.34.0' });
  assert.deepEqual(metadata.capabilities, ['completion', 'tools']);
  assert.equal(metadata.parameterSize, '4.0B'); assert.equal(metadata.quantization, 'Q4_K_M');
  assert.equal(metadata.advertisedContextLength, 262144); assert.equal(metadata.licensePresent, true);
  assert.equal(provider.modelPolicy.permitted, false); assert.deepEqual(provider.modelPolicy.evaluations, []);
  assert.doesNotMatch(JSON.stringify(provider.status), /private-/);
  metadata.capabilities.length = 0; assert.equal(provider.status.modelMetadata![0]!.capabilities.length, 2);
  assert.ok(calls.every((call) => !/chat|pull/.test(call.route)));
});
test('Ollama absent optional metadata remains unknown rather than invented', async () => {
  const { provider } = await ready(); const metadata = provider.status.modelMetadata![0]!;
  assert.equal(metadata.parameterSize, undefined); assert.equal(metadata.quantization, undefined);
  assert.equal(metadata.advertisedContextLength, undefined); assert.equal(metadata.licensePresent, false);
});
for (const bad of [{ digest: undefined }, { digest: 'not-a-digest' }, { model: 'different-name' }]) {
  test(`Ollama incomplete or mismatched model identity fails closed ${JSON.stringify(bad)}`, async () => {
    const { provider, calls } = setup({ override: (route) => route === '/api/tags' ? json({ models: [{ ...entry(), ...bad }] }) : undefined });
    await provider.refresh(); assert.equal(provider.configured, false); assert.equal(provider.modelPolicy.model, undefined);
    assert.ok(calls.every((call) => call.route !== '/api/chat'));
  });
}
for (const bad of [{ capabilities: ['completion', 42] }, { capabilities: ['completion', 'private\nsecret'] },
  { details: { format: 'gguf', parameter_size: 4 } }, { details: { format: 'gguf', quantization_level: {} } },
  { model_info: { 'test.context_length': -1 } }, { model_info: { 'test.context_length': '4096' } }, { license: {} }]) {
  test(`Ollama rejects malformed optional metadata ${JSON.stringify(bad)}`, async () => {
    const { provider, calls } = setup({ override: (route) => route === '/api/show' ? json({ ...details(), ...bad }) : undefined });
    await provider.refresh(); assert.equal(provider.configured, false); assert.equal(provider.status.state, 'failed');
    assert.deepEqual(provider.status.modelMetadata, []); assert.ok(calls.every((call) => call.route !== '/api/chat'));
  });
}
test('Ollama refresh observes digest changes and removes unavailable metadata without new generation', async () => {
  let digest = 'a'.repeat(64); let online = true;
  const { provider, calls } = await ready({ override: (route) => {
    if (!online) throw new Error('offline');
    return route === '/api/tags' ? json({ models: [{ ...entry(), digest }] }) : undefined;
  } });
  digest = 'b'.repeat(64); await provider.refresh();
  assert.equal(provider.modelPolicy.model?.identity.digest, digest);
  online = false; await provider.refresh();
  const offline = provider.modelPolicy;
  assert.equal(offline.serverAvailable, false); assert.equal(offline.model, undefined);
  online = true; await provider.refresh(); assert.equal(provider.configured, true);
  assert.equal(provider.modelPolicy.model?.identity.digest, digest);
  assert.ok(calls.every((call) => call.route !== '/api/chat'));
});
test('Ollama cloud markers and renamed remote aliases are excluded', async () => {
  const { provider, calls } = setup({ models: [entry(), entry('test:cloud'), { ...entry('remote-alias'), remote_host: 'https://remote.invalid' }, entry('hidden-alias')],
    override: (route, init) => route === '/api/show' && JSON.parse(String(init.body)).model === 'hidden-alias' ? json({ ...details(), remote_model: 'remote' }) : undefined });
  await provider.refresh(); assert.deepEqual(provider.status.models, [model]);
  assert.ok(calls.every((call) => call.route !== '/api/chat'));
});
test('Ollama embedding-only or unknown local format cannot be selected', async () => {
  const { provider } = setup({ override: (route) => route === '/api/show' ? json({ ...details(), capabilities: ['embedding'] }) : undefined });
  await provider.refresh(); assert.deepEqual(provider.status.models, []);
});
for (const value of ['', 'https://remote.invalid/m', 'http://127.0.0.1:22', '../file', 'x\n', 'x:cloud', 'x:large-cloud', { model }, 'x'.repeat(201)]) {
  test(`Ollama rejects model identifier ${JSON.stringify(value)}`, async () => {
    assert.equal(validOllamaModel(value), false);
    const { provider, calls } = setup(); await assert.rejects(provider.selectModel(value), code('INVALID_REQUEST')); assert.equal(calls.length, 0);
  });
}
test('Ollama rejects names absent from the freshly queried list with no chat/download', async () => {
  const { provider, calls } = setup(); await provider.refresh();
  await assert.rejects(provider.selectModel('not-installed'), code('OLLAMA_MODEL_REQUIRED'));
  assert.ok(calls.every((call) => !/chat|pull|delete/.test(call.route)));
});
test('Ollama selected model persists and restores only when still local and available', async () => {
  const first = await ready();
  const second = new OllamaProvider(first.store, { fetch: first.fetcher, installed: async () => true });
  await second.refresh(); assert.equal(second.configured, true); assert.equal(second.status.selectedModel, model);
  const missing = setup({ saved: model, models: [] }); await missing.provider.refresh(); assert.equal(missing.provider.configured, false);
});
test('Ollama native chat request has bounded output, no key/tools and neutral task data', async () => {
  const { provider, calls } = await ready(); assert.deepEqual(await provider.execute(request), { output: 'LOOP_OK' });
  const chat = calls.filter((call) => call.route === '/api/chat'); assert.equal(chat.length, 1);
  const body = JSON.parse(String(chat[0]!.init.body));
  assert.equal(body.model, model); assert.equal(body.stream, false); assert.equal(body.options.num_predict, 4096);
  assert.equal(body.tools, undefined); assert.equal(JSON.parse(body.messages[1].content).request, request.userRequest);
  assert.deepEqual(JSON.parse(body.messages[1].content).context, request.previousOutputs);
});
for (const [name, body, expected] of [
  ['empty', { ...completion(), message: { role: 'assistant', content: '' } }, 'RESPONSE_PARSE_ERROR'],
  ['no content', { ...completion(), message: { role: 'assistant' } }, 'RESPONSE_PARSE_ERROR'],
  ['unfinished', { ...completion(), done: false }, 'EXECUTION_FAILED'],
  ['length', { ...completion(), done_reason: 'length' }, 'EXECUTION_FAILED'],
  ['missing reason', { ...completion(), done_reason: undefined }, 'EXECUTION_FAILED'],
  ['wrong role', { ...completion(), message: { role: 'user', content: 'LOOP_OK' } }, 'EXECUTION_FAILED'],
  ['wrong model', { ...completion(), model: 'other' }, 'EXECUTION_FAILED'],
  ['remote response', { ...completion(), remote_host: 'https://remote.invalid' }, 'EXECUTION_FAILED'],
  ['tools', { ...completion(), message: { ...completion().message, tool_calls: [{}] } }, 'EXECUTION_FAILED'],
  ['error', { error: 'private-secret' }, 'EXECUTION_FAILED'],
  ['too long', { ...completion(), message: { role: 'assistant', content: 'x'.repeat(100001) } }, 'OLLAMA_OUTPUT_LIMIT'],
] as const) test(`Ollama response rejects ${name}`, async () => {
  const { provider } = await ready({ override: (route) => route === '/api/chat' ? json(body) : undefined });
  await assert.rejects(provider.execute(request), code(expected));
});
for (const [name, response, expected] of [
  ['HTTP', () => json({ error: 'private-secret' }, 500), 'HTTP_ERROR'],
  ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://remote.invalid' } }), 'HTTP_ERROR'],
  ['bad JSON', () => new Response('{', { headers: { 'content-type': 'application/json' } }), 'RESPONSE_PARSE_ERROR'],
  ['HTML', () => new Response('private-secret', { headers: { 'content-type': 'text/html' } }), 'RESPONSE_PARSE_ERROR'],
  ['huge JSON', () => json({ text: 'x'.repeat(2_000_001) }), 'OLLAMA_OUTPUT_LIMIT'],
] as const) test(`Ollama rejects ${name} without exposing raw body`, async () => {
  const { provider } = await ready({ override: (route) => route === '/api/chat' ? response() : undefined });
  await assert.rejects(provider.execute(request), code(expected));
});
for (const body of [{}, { version: 'secret\n' }, { version: 123 }]) test(`Ollama invalid server version ${JSON.stringify(body)}`, async () => {
  const { provider } = setup({ override: (route) => route === '/api/version' ? json(body) : undefined });
  await provider.refresh(); assert.equal(provider.unavailableReason, 'RESPONSE_PARSE_ERROR'); assert.equal(provider.configured, false);
});
test('Ollama malformed tags and fake service response fail before user content', async () => {
  const { provider, calls } = setup({ override: (route) => route === '/api/tags' ? json({ models: [{}] }) : undefined });
  await provider.refresh(); assert.equal(provider.unavailableReason, 'RESPONSE_PARSE_ERROR'); assert.ok(calls.every((call) => call.route !== '/api/chat'));
});
test('Ollama metadata timeout fails without a generation request', async () => {
  const provider = new OllamaProvider({ read: async () => undefined, save: async () => {} }, { installed: async () => true, metadataTimeoutMs: 20,
    fetch: async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(Error('private-secret')), { once: true }); }) });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await provider.refresh(); assert.equal(provider.unavailableReason, 'TIMEOUT'); } finally { clearTimeout(keepAlive); }
});
test('Ollama model changing to a cloud alias blocks chat at execution time', async () => {
  let cloud = false;
  const { provider, calls } = await ready({ override: (route) => route === '/api/show' && cloud ? json({ ...details(), remote_host: 'https://remote.invalid' }) : undefined });
  cloud = true; await assert.rejects(provider.execute(request), code('OLLAMA_MODEL_REQUIRED'));
  assert.ok(calls.every((call) => call.route !== '/api/chat'));
});
for (const cancel of [true, false]) test(`Ollama ${cancel ? 'cancellation' : 'timeout'} aborts HTTP and never completes Loop`, async () => {
  const controller = new AbortController(); let arrived!: () => void; const started = new Promise<void>((resolve) => { arrived = resolve; });
  const { provider } = await ready({ timeoutMs: 60, override: (route, init) => route === '/api/chat' ? new Promise((_resolve, reject) => {
    arrived(); init.signal!.addEventListener('abort', () => reject(Error('private-secret')), { once: true });
  }) : undefined });
  const service = new LoopService(new MockPlanner('single-work'), provider);
  const pending = service.run(service.create('test'), () => {}, { signal: controller.signal });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await started; if (cancel) controller.abort(); const loop = await pending; assert.equal(loop.status, cancel ? 'cancelled' : 'failed'); assert.equal(loop.finalResult, undefined); }
  finally { clearTimeout(keepAlive); }
});
test('Ollama late response cannot replace cancelled state, and selection/execution locks hold', async () => {
  const controller = new AbortController(); let finish!: (response: Response) => void; let arrived!: () => void;
  const started = new Promise<void>((resolve) => { arrived = resolve; });
  const { provider } = await ready({ override: (route) => route === '/api/chat' ? new Promise((resolve) => { finish = resolve; arrived(); }) : undefined });
  const pending = provider.execute(request, { signal: controller.signal }); const rejected = assert.rejects(pending, code('CANCELLED'));
  await started; await assert.rejects(provider.selectModel(model), code('CONFIG_BUSY')); await assert.rejects(provider.execute(request), code('BUSY'));
  controller.abort(); finish(json(completion())); await rejected;
});
test('Ollama neutral runtime/IPC/Single integration excludes Auto and fallback, rejects URL payloads', async () => {
  const { provider } = setup(); const store = { read: async () => undefined, save: async () => {}, remove: async () => {} };
  const runtime = new ProviderRuntime({}, store, store, undefined, provider); await runtime.initialize();
  const gateway = createProviderGateway(runtime.registry, runtime);
  assert.equal((await gateway.selectOllamaModel({ model, url: 'https://remote.invalid' } as unknown as string)).ok, false);
  assert.equal((await gateway.selectOllamaModel(model)).ok, true);
  assert.throws(() => autoProviderPool(runtime.registry)); assert.equal(selectAlternativeProvider(runtime.registry, 'other'), undefined);
  const summary = runtime.registry.list().find((item) => item.id === provider.id)!;
  summary.ollama!.models.length = 0; assert.equal(runtime.registry.list().find((item) => item.id === provider.id)!.ollama!.models.length, 1);
  const service = new LoopService(new MockPlanner('single-work'), new IpcProvider(summary, gateway));
  const loop = await service.run(service.create('test')); assert.equal(loop.status, 'completed'); assert.equal(loop.finalResult, 'LOOP_OK');
  gateway.dispose(); assert.equal((await gateway.selectOllamaModel(model)).ok, false);
});
test('Ollama model store contains only non-secret model/version and rejects corrupted settings', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'ollama-settings-test-'));
  try {
    const store = new OllamaStore(folder); assert.equal(await store.read(), undefined);
    await store.save(model); assert.equal(await new OllamaStore(folder).read(), model);
    const file = path.join(folder, 'ollama-local.json'); assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, model });
    await writeFile(file, JSON.stringify({ version: 1, model, apiKey: 'private-secret' })); await assert.rejects(store.read(), code('STORAGE_CORRUPT'));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test('Ollama actual HTTP redirect is not followed to another local service', async () => {
  let targetRequests = 0;
  const target = createServer((_req, res) => { targetRequests++; res.end('{}'); });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetPort = (target.address() as { port: number }).port;
  const redirect = createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/` }); res.end(); });
  await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  const port = (redirect.address() as { port: number }).port;
  try {
    const provider = new OllamaProvider({ read: async () => undefined, save: async () => {} }, { installed: async () => true,
      fetch: (url, init) => { assert.equal(new URL(String(url)).origin, OLLAMA_ORIGIN); return fetch(`http://127.0.0.1:${port}/`, init); } });
    await provider.refresh(); assert.equal(provider.configured, false); assert.equal(targetRequests, 0);
  } finally { redirect.closeAllConnections(); target.closeAllConnections(); await Promise.all([new Promise<void>((resolve) => redirect.close(() => resolve())), new Promise<void>((resolve) => target.close(() => resolve()))]); }
});

test('Ollama direct transport fixes host/port, omits credentials/proxies, parses and aborts real HTTP', async () => {
  let requests = 0; let aborted = false; let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const server = createServer(async (req, res) => {
    requests++; assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
    if (req.url === '/api/chat') { reached(); res.on('close', () => { aborted = true; }); return; }
    if (req.url === '/api/tags') { res.writeHead(302, { location: 'https://remote.invalid' }); res.end(); return; }
    if (req.url === '/api/show') { res.writeHead(600); res.end(); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: '0.34.0' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const original = http.request;
  const stub = mock.method(http, 'request', ((options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
    assert.equal(options.hostname, '127.0.0.1'); assert.equal(options.port, 11434);
    assert.ok(options.agent instanceof http.Agent); assert.notEqual(options.agent, http.globalAgent);
    assert.deepEqual((options.agent as http.Agent & { options: http.AgentOptions }).options.proxyEnv, {});
    return original({ ...options, port }, callback);
  }) as typeof http.request);
  try {
    const response = await fetchLocalOllama(OLLAMA_ORIGIN + '/api/version', { headers: { Authorization: 'private-secret', Cookie: 'private-secret' } });
    assert.deepEqual(await response.json(), { version: '0.34.0' });
    const redirect = await fetchLocalOllama(OLLAMA_ORIGIN + '/api/tags'); assert.equal(redirect.status, 302); await redirect.body?.cancel();
    await assert.rejects(fetchLocalOllama(OLLAMA_ORIGIN + '/api/show'), code('HTTP_ERROR'));
    const controller = new AbortController();
    const pending = fetchLocalOllama(OLLAMA_ORIGIN + '/api/chat', { body: '{}', signal: controller.signal });
    const rejected = assert.rejects(pending); await started; controller.abort(); await rejected;
    for (let i = 0; i < 20 && !aborted; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(aborted, true); assert.equal(requests, 4);
  } finally { stub.mock.restore(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('Ollama direct transport rejects foreign hosts, ports, paths and credentials before connecting', async () => {
  for (const url of ['https://remote.invalid/api/chat', 'http://127.0.0.1:9999/api/chat', 'http://secret@127.0.0.1:11434/api/chat',
    OLLAMA_ORIGIN + '/api/pull', OLLAMA_ORIGIN + '/api/chat?url=remote', OLLAMA_ORIGIN + '/api/chat#remote']) {
    await assert.rejects(fetchLocalOllama(url), code('INVALID_REQUEST'));
  }
});
