// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProviderRegistry } from '../electron/provider-runtime.ts';
import { createProviderGateway } from '../electron/provider-gateway.ts';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import { connectionStatus } from '../src/ui/connection-status.ts';

const fakeSecret = 'connections-test-credential-not-real';
const request = { userRequest: '작업 요청', stepTitle: '초안 생성', previousOutputs: [], isFinalStep: true };

test('Connections distinguishes offline Mock from a configured but unverified external AI', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => { assert.fail('Listing connections must never call an external API.'); });
  const environment = {
    SEOHOKIM_LOOP_OPENAI_API_KEY: fakeSecret,
    SEOHOKIM_LOOP_OPENAI_MODEL: 'test-model',
    SEOHOKIM_LOOP_OPENAI_BASE_URL: 'https://example.test/v1',
  };
  const registry = createProviderRegistry(environment);
  const gateway = createProviderGateway(registry);
  const reply = await gateway.listProviders();
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  const [mock, external] = reply.value;
  assert.equal(mock?.type, 'mock');
  assert.equal(connectionStatus(mock!).label, '사용 가능');
  assert.equal(connectionStatus(external!).state, 'ready');
  assert.equal(connectionStatus(external!).label, '설정 완료');
  assert.match(connectionStatus(external!).detail, /설정 완료는 실제 연결 성공을 뜻하지 않습니다/);
  assert.equal(mock?.supportsConnectionCheck, false);
  assert.equal(external?.supportsConnectionCheck, true);
  environment.SEOHOKIM_LOOP_OPENAI_API_KEY = '';
  assert.deepEqual(await gateway.listProviders(), reply, 'Refresh reads the startup snapshot, not new environment settings.');
});

test('Connections gives short actionable messages for absent configuration, key and invalid URL', () => {
  const cases = [
    { environment: {}, expected: 'AI 연결 설정이 필요합니다.' },
    { environment: { SEOHOKIM_LOOP_OPENAI_MODEL: 'test-model' }, expected: 'API 키 설정이 필요합니다.' },
    { environment: { SEOHOKIM_LOOP_OPENAI_API_KEY: fakeSecret, SEOHOKIM_LOOP_OPENAI_MODEL: 'test-model', SEOHOKIM_LOOP_OPENAI_BASE_URL: 'broken' }, expected: '서버 주소 설정을 확인해주세요.' },
  ];
  for (const { environment, expected } of cases) {
    const connection = createProviderRegistry(environment).list()[1]!;
    assert.equal(connection.configured, false);
    assert.deepEqual(connectionStatus(connection), { state: 'needs_configuration', label: '설정 필요', detail: expected });
  }
  const unavailable = connectionStatus({ id: 'other', displayName: 'Other', type: 'other', configured: false, supportsConnectionCheck: false, unavailableReason: 'EXECUTION_FAILED' });
  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.label, '사용할 수 없음');
  assert.doesNotMatch(unavailable.detail, /EXECUTION_FAILED|stack|IPC|Adapter/);
});

test('Connections IPC replies contain only allowlisted public fields, even with credentials in other config fields', async () => {
  const registry = createProviderRegistry({
    SEOHOKIM_LOOP_OPENAI_API_KEY: fakeSecret,
    SEOHOKIM_LOOP_OPENAI_MODEL: `model-${fakeSecret}`,
    SEOHOKIM_LOOP_OPENAI_BASE_URL: `https://example.test/${fakeSecret}`,
  });
  const reply = await createProviderGateway(registry).listProviders();
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  for (const summary of reply.value) {
    assert.deepEqual(Object.keys(summary).sort(), ['configured', 'displayName', 'id', 'supportsConnectionCheck', 'type', 'unavailableReason']);
  }
  assert.ok(!JSON.stringify(reply).includes(fakeSecret));
  assert.doesNotMatch(JSON.stringify(reply), /apiKey|Authorization|baseUrl|model|process|environment/);
});

test('Registry drops non-public properties instead of spreading registration data into IPC', async () => {
  const registry = new ProviderRegistry();
  const state = { type: 'stub', configured: true, apiKey: fakeSecret, credentials: { token: fakeSecret }, authorization: `Bearer ${fakeSecret}` };
  registry.register({ id: 'stub', displayName: 'Test', execute: async () => ({ output: 'ok' }) }, state);
  const reply = await createProviderGateway(registry).listProviders();
  assert.ok(!JSON.stringify(reply).includes(fakeSecret));
  assert.doesNotMatch(JSON.stringify(reply), /apiKey|credentials|authorization/);
});

test('Connection listing failure crosses IPC as a safe failure, never a raw exception', async () => {
  const registry = new ProviderRegistry();
  registry.list = () => { throw new Error(`private stack ${fakeSecret}`); };
  const reply = await createProviderGateway(registry).listProviders();
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.error.code, 'EXECUTION_FAILED');
  assert.ok(!JSON.stringify(reply).includes(fakeSecret));
  assert.doesNotMatch(JSON.stringify(reply), /stack/);
});

test('A displayed unavailable connection cannot execute while Mock remains usable', async () => {
  let calls = 0;
  const registry = new ProviderRegistry();
  registry.register({ id: 'offline', displayName: 'Offline', execute: async () => { calls += 1; return { output: 'wrong' }; } }, {
    type: 'stub', configured: false, unavailableReason: 'API_KEY_MISSING',
  });
  const gateway = createProviderGateway(registry);
  assert.equal(connectionStatus(registry.list()[0]!).state, 'needs_configuration');
  const reply = await gateway.executeProvider({ providerId: 'offline', request });
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.error.code, 'API_KEY_MISSING');
  assert.equal(calls, 0);
  assert.equal(createProviderRegistry({}).get('mock').id, 'mock');
});
