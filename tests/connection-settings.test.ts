// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ConnectionStore } from '../electron/connection-store.ts';
import type { SecretEncryption } from '../electron/connection-store.ts';
import { ProviderRuntime } from '../electron/provider-runtime.ts';
import { createProviderGateway } from '../electron/provider-gateway.ts';
import { configurableProviderId as id } from '../src/providers/connection-configuration.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';

const secret = 'fake-settings-test-key-not-real';
const replacement = 'fake-replacement-key-not-real';
const settings = { baseUrl: 'https://example.test/v1', model: 'test-model', apiKey: secret };
const input = { providerId: id, ...settings } as const;
const request = { userRequest: '실행 확인', stepTitle: '초안 생성', previousOutputs: [], isFinalStep: true };
const environment = { SEOHOKIM_LOOP_OPENAI_API_KEY: 'fake-environment-key', SEOHOKIM_LOOP_OPENAI_BASE_URL: 'https://environment.test/v1', SEOHOKIM_LOOP_OPENAI_MODEL: 'environment-model' };

// Test-only cipher verifies serialization without accessing an OS key store.
const cipherKey = randomBytes(32);
const encryption: SecretEncryption = {
  isAvailable: async () => true,
  async encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', cipherKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  },
  async decrypt(value) {
    const cipher = createDecipheriv('aes-256-gcm', cipherKey, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
  },
};

async function setup(t: TestContext, env: NodeJS.ProcessEnv = {}, crypto = encryption) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'seohokim-settings-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('seohokim-settings-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'openai-compatible-connection.json');
  const store = new ConnectionStore(directory, crypto);
  const runtime = new ProviderRuntime(env, store);
  await runtime.initialize();
  return { directory, file, store, runtime, gateway: createProviderGateway(runtime.registry, runtime) };
}

function secretFree(value: unknown) {
  const text = JSON.stringify(value);
  for (const key of [secret, replacement, environment.SEOHOKIM_LOOP_OPENAI_API_KEY]) assert.ok(!text.includes(key));
  assert.doesNotMatch(text, /encryptedApiKey|Authorization|stack/);
}

test('save encrypts a new connection, updates configured immediately, and exposes only public metadata', async (t) => {
  const { gateway, file, store, runtime } = await setup(t);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Saving must never call the server.'); });
  const mock = runtime.registry.get('mock');
  const reply = await gateway.saveConfiguration(input);
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  assert.deepEqual(reply.value, { id, baseUrl: settings.baseUrl, model: settings.model, hasApiKey: true, source: 'saved', hasSavedConfiguration: true });
  secretFree(reply);
  const disk = await fs.readFile(file, 'utf8');
  assert.ok(!disk.includes(secret));
  assert.ok(!disk.includes(Buffer.from(secret).toString('base64')), 'Base64 plaintext is not encryption.');
  assert.deepEqual(Object.keys(JSON.parse(disk)).sort(), ['baseUrl', 'encryptedApiKey', 'model', 'providerId', 'version']);
  assert.deepEqual(await store.read(), settings);
  assert.equal(runtime.registry.list()[1]?.configured, true);
  assert.equal(runtime.registry.get('mock'), mock, 'Only the configurable adapter is replaced.');
  secretFree(await gateway.getConfiguration(id));
  secretFree(await gateway.listProviders());
});

test('new settings without an API key are rejected before writing', async (t) => {
  const { gateway, directory } = await setup(t);
  for (const apiKey of [undefined, '', ' ']) {
    const reply = await gateway.saveConfiguration({ ...input, apiKey });
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.equal(reply.error.code, 'KEY_REQUIRED');
    secretFree(reply);
  }
  assert.deepEqual(await fs.readdir(directory), []);
});

test('invalid URL, missing model, oversized fields and credential-bearing metadata cannot be saved', async (t) => {
  const { gateway, directory } = await setup(t);
  for (const changed of [
    { baseUrl: '' }, { baseUrl: 'broken' }, { baseUrl: 'http://remote.test/v1' }, { baseUrl: 'file:///private' },
    { baseUrl: `https://user:${secret}@example.test` }, { baseUrl: `https://example.test?key=${secret}` },
    { baseUrl: `https://example.test/${secret}` }, { model: secret }, { model: '' }, { model: ' ' },
    { model: 'a'.repeat(201) }, { apiKey: `abc\n${secret}` }, { apiKey: 'a'.repeat(8193) },
  ]) {
    const reply = await gateway.saveConfiguration({ ...input, ...changed });
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.equal(reply.error.code, 'CONFIG_INVALID');
    secretFree(reply);
  }
  assert.deepEqual(await fs.readdir(directory), []);
});

test('IPC config payloads reject unknown providers, filesystem paths, commands, and extra fields', async (t) => {
  const { gateway } = await setup(t);
  for (const value of [null, [], {}, { ...input, providerId: 'mock' }, { ...input, file: 'C:/secret' },
    { ...input, command: 'anything' }, { ...input, headers: {} }, { ...input, apiKey: 12 }]) {
    const reply = await gateway.saveConfiguration(value as typeof input);
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.equal(reply.error.code, 'INVALID_REQUEST');
    secretFree(reply);
  }
  for (const providerId of ['mock', 'unknown', '../file', '', {}]) {
    for (const reply of [await gateway.getConfiguration(providerId as string), await gateway.removeConfiguration(providerId as string)]) {
      assert.equal(reply.ok, false);
      if (!reply.ok) assert.equal(reply.error.code, 'INVALID_REQUEST');
    }
  }
});

test('encryption unavailable or failing never falls back to plaintext or modifies old runtime settings', async (t) => {
  for (const [crypto, expected] of [
    [{ ...encryption, isAvailable: async () => false }, 'ENCRYPTION_UNAVAILABLE'],
    [{ ...encryption, isAvailable: async () => { throw new Error(secret); } }, 'ENCRYPTION_UNAVAILABLE'],
    [{ ...encryption, encrypt: async () => { throw new Error(secret); } }, 'ENCRYPTION_FAILED'],
  ] as const) {
    const { gateway, directory } = await setup(t, environment, crypto);
    const before = await gateway.getConfiguration(id);
    const reply = await gateway.saveConfiguration(input);
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.equal(reply.error.code, expected);
    secretFree(reply);
    assert.deepEqual(await fs.readdir(directory), []);
    assert.deepEqual(await gateway.getConfiguration(id), before);
  }
});

test('saved connection decrypts on restart and deterministically overrides environment fallback', async (t) => {
  const { store, runtime, gateway } = await setup(t, environment);
  assert.equal(runtime.getConfiguration(id).source, 'environment');
  await gateway.saveConfiguration(input);
  const restarted = new ProviderRuntime(environment, store);
  await restarted.initialize();
  assert.equal(restarted.getConfiguration(id).source, 'saved');
  assert.equal(restarted.getConfiguration(id).model, settings.model);
  secretFree(restarted.getConfiguration(id));
});

test('blank or omitted key retains the old secret during URL/model edits; a new key replaces it', async (t) => {
  const { gateway, store } = await setup(t);
  await gateway.saveConfiguration(input);
  const changed = { providerId: id, baseUrl: 'https://changed.test/v2', model: 'changed-model' } as const;
  for (const apiKey of [undefined, '', ' ']) {
    const reply = await gateway.saveConfiguration({ ...changed, apiKey });
    assert.equal(reply.ok, true);
    secretFree(reply);
    assert.deepEqual(await store.read(), { baseUrl: changed.baseUrl, model: changed.model, apiKey: secret });
  }
  assert.equal((await gateway.saveConfiguration({ ...changed, apiKey: replacement })).ok, true);
  assert.equal((await store.read())?.apiKey, replacement);
  secretFree(await gateway.getConfiguration(id));
});

test('environment key can be retained explicitly when saving settings without re-entering it', async (t) => {
  const { gateway, store } = await setup(t, environment);
  assert.equal((await gateway.saveConfiguration({ ...input, apiKey: '' })).ok, true);
  assert.equal((await store.read())?.apiKey, environment.SEOHOKIM_LOOP_OPENAI_API_KEY);
  secretFree(await gateway.getConfiguration(id));
});

test('key rotation cannot copy the prior or fallback credential into plaintext metadata', async (t) => {
  const { gateway, store } = await setup(t, environment);
  await gateway.saveConfiguration(input);
  for (const key of [secret, environment.SEOHOKIM_LOOP_OPENAI_API_KEY]) {
    const reply = await gateway.saveConfiguration({ ...input, apiKey: replacement, model: `model-${key}` });
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.equal(reply.error.code, 'CONFIG_INVALID');
    secretFree(reply);
  }
  assert.deepEqual(await store.read(), settings);
});

test('removing saved settings deletes the encrypted key and returns to unconfigured state', async (t) => {
  const { gateway, directory, runtime } = await setup(t);
  await gateway.saveConfiguration(input);
  const reply = await gateway.removeConfiguration(id);
  assert.equal(reply.ok, true);
  if (reply.ok) assert.equal(reply.value.source, 'none');
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal(runtime.registry.list()[1]?.configured, false);
  assert.equal((await gateway.removeConfiguration(id)).ok, true, 'Removal is idempotent.');
});

test('removal restores the captured environment config and key without requiring restart', async (t) => {
  const { gateway, runtime } = await setup(t, environment);
  await gateway.saveConfiguration(input);
  assert.equal((await gateway.removeConfiguration(id)).ok, true);
  assert.equal(runtime.getConfiguration(id).source, 'environment');
  assert.equal(runtime.getConfiguration(id).model, 'environment-model');
  assert.equal(runtime.registry.list()[1]?.configured, true);
});

test('malformed files fail closed without crashing Mock or silently using environment credentials', async (t) => {
  const { file, store } = await setup(t);
  for (const content of ['broken', 'null', '{}', JSON.stringify({ ...settings, version: 1 }),
    JSON.stringify({ version: 1, providerId: id, baseUrl: settings.baseUrl, model: settings.model, encryptedApiKey: 'not-base64!' })]) {
    await fs.writeFile(file, content);
    const runtime = new ProviderRuntime(environment, store);
    await runtime.initialize();
    assert.equal(runtime.getConfiguration(id).storageError, 'STORAGE_CORRUPT');
    assert.equal(runtime.getConfiguration(id).source, 'unavailable');
    assert.equal(runtime.registry.list()[1]?.configured, false);
    assert.equal(runtime.registry.get('mock').id, 'mock');
    secretFree(runtime.getConfiguration(id));
  }
});

test('decryption failure never returns ciphertext or secret and can be repaired using a new key', async (t) => {
  const { directory, store } = await setup(t);
  await store.save(settings);
  const broken = new ConnectionStore(directory, { ...encryption, decrypt: async () => { throw new Error(secret); } });
  const runtime = new ProviderRuntime(environment, broken);
  await runtime.initialize();
  assert.equal(runtime.getConfiguration(id).storageError, 'DECRYPTION_FAILED');
  secretFree(runtime.getConfiguration(id));
  const gateway = createProviderGateway(runtime.registry, runtime);
  const blank = await gateway.saveConfiguration({ ...input, apiKey: '' });
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.error.code, 'KEY_REQUIRED');
  assert.equal((await gateway.saveConfiguration(input)).ok, true);
  assert.equal(runtime.getConfiguration(id).storageError, undefined);
});

test('unavailable OS encryption while reading a saved file does not fall back to environment', async (t) => {
  const { directory, store } = await setup(t);
  await store.save(settings);
  const runtime = new ProviderRuntime(environment, new ConnectionStore(directory, { ...encryption, isAvailable: async () => false }));
  await runtime.initialize();
  assert.equal(runtime.getConfiguration(id).storageError, 'ENCRYPTION_UNAVAILABLE');
  assert.equal(runtime.registry.list()[1]?.configured, false);
});

test('file read failure is safe and does not crash the application', async (t) => {
  const { directory } = await setup(t);
  const store = new ConnectionStore(directory, encryption, { ...fs, readFile: (async () => { throw new Error(secret); }) as typeof fs.readFile });
  const runtime = new ProviderRuntime(environment, store);
  await runtime.initialize();
  assert.equal(runtime.getConfiguration(id).storageError, 'STORAGE_READ_FAILED');
  secretFree(runtime.getConfiguration(id));
});

test('write/rename failure preserves the previous file and runtime and cleans temporary ciphertext', async (t) => {
  const { directory, store, file } = await setup(t);
  await store.save(settings);
  const original = await fs.readFile(file, 'utf8');
  for (const method of ['writeFile', 'rename'] as const) {
    const failing = new ConnectionStore(directory, encryption, { ...fs, [method]: async () => { throw new Error(secret); } });
    const runtime = new ProviderRuntime({}, failing);
    await runtime.initialize();
    const gateway = createProviderGateway(runtime.registry, runtime);
    const reply = await gateway.saveConfiguration({ ...input, model: 'new-model' });
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.equal(reply.error.code, 'STORAGE_WRITE_FAILED');
    secretFree(reply);
    assert.equal(runtime.getConfiguration(id).model, settings.model);
    assert.equal(await fs.readFile(file, 'utf8'), original);
    assert.deepEqual(await fs.readdir(directory), [path.basename(file)]);
  }
});

test('remove failure preserves the active saved connection and hides filesystem details', async (t) => {
  const { directory, store } = await setup(t);
  await store.save(settings);
  const failing = new ConnectionStore(directory, encryption, { ...fs, unlink: async () => { throw new Error(secret); } });
  const runtime = new ProviderRuntime({}, failing);
  await runtime.initialize();
  const reply = await createProviderGateway(runtime.registry, runtime).removeConfiguration(id);
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.error.code, 'STORAGE_REMOVE_FAILED');
  secretFree(reply);
  assert.equal(runtime.getConfiguration(id).source, 'saved');
});

test('saved and updated settings drive both connection checks and Loop execution without restart', async (t) => {
  const { gateway, runtime } = await setup(t);
  const calls: { url: string; key: string; model: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, key: (init.headers as Record<string, string>).Authorization!, model: JSON.parse(String(init.body)).model });
    return Response.json({ choices: [{ message: { content: '완료 결과' } }] });
  });
  for (const current of [input, { ...input, baseUrl: 'https://changed.test/v2', model: 'second-model', apiKey: replacement }]) {
    assert.equal((await gateway.saveConfiguration(current)).ok, true);
    assert.equal((await gateway.testConnection(id)).ok, true);
    const service = new LoopService(new MockPlanner('single-work'), new IpcProvider(runtime.registry.list()[1]!, gateway));
    const loop = await service.run(service.create('요청'));
    assert.equal(loop.status, 'completed');
    assert.equal(loop.finalResult, '완료 결과');
    for (const call of calls.slice(-2)) assert.deepEqual(call, { url: `${current.baseUrl}/chat/completions`, key: `Bearer ${current.apiKey}`, model: current.model });
  }
  assert.equal(calls.length, 4);
  await gateway.listProviders();
  await gateway.getConfiguration(id);
  assert.equal(calls.length, 4, 'Refresh does not send requests.');
});

test('pending saves block overlapping writes, checks and work until durable commit', async (t) => {
  const { store } = await setup(t);
  let release!: () => void;
  const runtime = new ProviderRuntime({}, { read: () => store.read(), remove: () => store.remove(),
    save: async (value) => { await new Promise<void>((resolve) => { release = resolve; }); await store.save(value); } });
  await runtime.initialize();
  const gateway = createProviderGateway(runtime.registry, runtime);
  const pending = gateway.saveConfiguration(input);
  for (const result of [await gateway.saveConfiguration(input), await gateway.removeConfiguration(id)]) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'CONFIG_BUSY');
  }
  assert.equal((await gateway.testConnection(id)).ok, false);
  const work = await gateway.executeProvider({ providerId: 'mock', request });
  assert.equal(work.ok, false);
  if (!work.ok) assert.equal(work.error.code, 'BUSY');
  release();
  assert.equal((await pending).ok, true);
  assert.equal((await gateway.removeConfiguration(id)).ok, true);
});

test('active work and connection checks reject configuration changes without disrupting the request', async (t) => {
  const { gateway, runtime } = await setup(t);
  let release!: () => void;
  t.mock.method(globalThis, 'fetch', async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return Response.json({ choices: [{ message: { content: '완료' } }] });
  });
  await gateway.saveConfiguration(input);
  for (const action of [() => gateway.testConnection(id), () => gateway.executeProvider({ providerId: id, request })]) {
    const pending = action();
    for (const reply of [await gateway.saveConfiguration({ ...input, model: 'new' }), await gateway.removeConfiguration(id)]) {
      assert.equal(reply.ok, false);
      if (!reply.ok) assert.equal(reply.error.code, 'CONFIG_BUSY');
    }
    release();
    assert.equal((await pending).ok, true);
    assert.equal(runtime.getConfiguration(id).model, settings.model);
  }
});

test('malformed environment metadata containing credentials is never returned in editable configuration', async (t) => {
  for (const fields of [{ SEOHOKIM_LOOP_OPENAI_BASE_URL: `https://example.test/${secret}` },
    { SEOHOKIM_LOOP_OPENAI_MODEL: `model-${secret}` }, { SEOHOKIM_LOOP_OPENAI_BASE_URL: `https://example.test?key=${secret}` }]) {
    const { gateway } = await setup(t, { ...environment, SEOHOKIM_LOOP_OPENAI_API_KEY: secret, ...fields });
    secretFree(await gateway.getConfiguration(id));
  }
});
