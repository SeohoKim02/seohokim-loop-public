// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createLoop } from '../src/domain/loop.ts';
import type { Loop, LoopStatus } from '../src/domain/loop.ts';
import type { LocalCliState } from '../src/providers/local-cli.ts';
import type { OllamaStatus } from '../src/providers/ollama.ts';
import { ProviderError } from '../src/providers/provider-error.ts';

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => server.close());
const { LanguageProvider } = await server.ssrLoadModule('/src/i18n/react.tsx') as typeof import('../src/i18n/react.tsx');
const { LoopProgress } = await server.ssrLoadModule('/src/ui/LoopProgress.tsx') as typeof import('../src/ui/LoopProgress.tsx');
const { LocalCliConnection } = await server.ssrLoadModule('/src/ui/LocalCliConnection.tsx') as typeof import('../src/ui/LocalCliConnection.tsx');
const { OllamaConnection } = await server.ssrLoadModule('/src/ui/OllamaConnection.tsx') as typeof import('../src/ui/OllamaConnection.tsx');
const { Connections } = await server.ssrLoadModule('/src/ui/Connections.tsx') as typeof import('../src/ui/Connections.tsx');
const { LocalCollaborationNotice } = await server.ssrLoadModule('/src/ui/LocalCollaborationNotice.tsx') as typeof import('../src/ui/LocalCollaborationNotice.tsx');
const en = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LanguageProvider, { initialLanguage: 'en', children: child }));
const noKorean = (html: string) => assert.doesNotMatch(html, /[가-힣]/);

for (const state of ['disabled', 'not_installed', 'installed', 'login_required', 'authenticated', 'ready', 'running', 'usage_limit', 'failed', 'unsupported'] as LocalCliState[]) {
  test(`English Codex connection state: ${state}`, () => noKorean(en(createElement(LocalCliConnection, { provider: {
    id: 'codex-cli', displayName: 'Codex CLI', type: 'local-cli', configured: state === 'ready', supportsConnectionCheck: false,
    localCli: { state, checkedAt: '2026-01-01T00:00:00Z', version: 'test', lastExecution: 'failed' },
    unavailableReason: 'CLI_DISABLED', experimentalManual: true,
  } }))));
}

for (const state of ['not_installed', 'stopped', 'no_models', 'select_model', 'ready', 'failed'] as OllamaStatus['state'][]) {
  test(`English Ollama connection state: ${state}`, () => noKorean(en(createElement(OllamaConnection, { disabled: false, refresh: async () => {}, provider: {
    id: 'ollama-local', displayName: '로컬 AI (Ollama)', type: 'local-ollama', configured: state === 'ready', supportsConnectionCheck: false,
    ollama: { state, installed: true, models: ['test:4b'], selectedModel: 'test:4b', version: 'test' },
    unavailableReason: 'OLLAMA_STOPPED', experimentalManual: true,
  } }))));
}

const base = createLoop('A synthetic task', [{ title: '초안 작성' }], { id: 'mock', displayName: 'Mock AI' }, { mode: 'manual' });
for (const status of ['pending', 'running', 'completed', 'failed', 'cancelled'] as LoopStatus[]) test(`English Loop state: ${status}`, () => {
  const error = `Mock AI 초안 작성 단계에서 작업을 완료하지 못했습니다. ${new ProviderError('HTTP_ERROR', 401).message}`;
  const loop: Loop = { ...base, status, startedAt: base.createdAt, completedAt: base.createdAt,
    finalResult: status === 'completed' ? 'Original output' : undefined, error: status === 'failed' ? error : undefined,
    steps: base.steps.map(step => ({ ...step, status, role: 'primary', startedAt: base.createdAt, completedAt: base.createdAt,
      error: status === 'failed' ? error : undefined, output: status === 'completed' ? 'Original output' : undefined })) };
  noKorean(en(createElement(LoopProgress, { loop })));
});

for (const variant of ['retry', 'fallback', 'planning', 'recovering', 'executing'] as const) test(`English advanced status: ${variant}`, () => {
  const auto = ['planning', 'recovering', 'executing'].includes(variant);
  const loop: Loop = { ...base, status: 'running',
    ...(auto ? { auto: { phase: variant as 'planning' | 'recovering' | 'executing', title: 'A generated plan' }, steps: base.steps.map(step => ({ ...step, title: 'Generated step' })) }
      : { steps: base.steps.map(step => ({ ...step, status: 'running', retryCount: 1, retryPending: variant === 'retry', fallbackCount: variant === 'fallback' ? 1 : 0,
        originalProvider: { id: 'old', displayName: 'Original AI' } })) }) };
  noKorean(en(createElement(LoopProgress, { loop })));
});

for (const source of ['saved', 'environment', 'none', 'unavailable'] as const) test(`English connection settings, check error and storage failure: ${source}`, () => {
  const html = en(createElement(Connections, {
    providers: [{ id: 'openai-compatible', displayName: 'OpenAI-compatible', type: 'api', configured: source !== 'none', supportsConnectionCheck: true, unavailableReason: 'API_KEY_MISSING' }],
    isLoading: false, refresh: async () => {}, checks: { 'openai-compatible': { checking: false,
      result: { ok: false, checkedAt: '2026-01-01T00:00:00Z', reason: '인증 정보를 확인해주세요.', code: 'authentication_failed' } } },
    testConnection: async () => {}, configurations: { 'openai-compatible': { id: 'openai-compatible', baseUrl: 'https://fake.invalid/v1', model: 'fake', source, hasApiKey: true, hasSavedConfiguration: true, storageError: 'DECRYPTION_FAILED' } },
    configurationErrors: { 'openai-compatible': '연결 정보를 저장하지 못했습니다.' }, isSaving: false, isLoopRunning: false,
    saveConfiguration: async () => false, removeConfiguration: async () => false,
  }));
  noKorean(html); assert.match(html, /Check your credentials/);
});

test('English experimental collaboration retains all warnings and opt-in label', () => {
  const html = en(createElement(LocalCollaborationNotice, { model: 'fake:4b', checked: false, disabled: false, onChange: () => {} }));
  noKorean(html); assert.match(html, /3 executions/); assert.match(html, /unverified/); assert.match(html, /No attachments, retries/);
});

test('Language chrome never translates saved or returned Korean model content', () => {
  const raw = '한국어 원문 & <tag> $& {0}\r\n  ';
  const loop = { ...base, userRequest: '한국어 사용자 요청', status: 'completed' as const, finalResult: raw,
    steps: base.steps.map(step => ({ ...step, status: 'completed' as const, output: raw })) };
  const before = JSON.stringify(loop); const html = en(createElement(LoopProgress, { loop }));
  assert.ok(html.includes('한국어 사용자 요청')); assert.ok(html.includes('한국어 원문 &amp; &lt;tag&gt; $&amp; {0}'));
  assert.equal(JSON.stringify(loop), before); assert.match(html, /Final result/);
});

test('English error rendering preserves generated step titles and user provider names', () => {
  const provider = { id: 'custom', displayName: '완료' };
  const error = `${provider.displayName} 검토 단계에서 작업을 완료하지 못했습니다. ${new ProviderError('TIMEOUT').message}`;
  const loop: Loop = { ...base, status: 'failed', auto: { phase: 'executing', title: '계획 원문' }, error,
    steps: base.steps.map(step => ({ ...step, title: '검토', assignedProvider: provider, status: 'failed', error })) };
  const html = en(createElement(LoopProgress, { loop }));
  assert.match(html, /<h3>검토<\/h3>/); assert.match(html, /완료 could not complete the 검토 step/);
  assert.doesNotMatch(html, /Completed could not|the Review step/);
});
test('English built-in Ollama error localizes identity without altering original Loop', () => {
  const provider = { id: 'ollama-local', displayName: '로컬 AI (Ollama)' };
  const error = `${provider.displayName} 초안 작성 단계에서 작업을 완료하지 못했습니다. ${new ProviderError('TIMEOUT').message}`;
  const loop: Loop = { ...base, status: 'failed', error, steps: base.steps.map(step => ({ ...step, assignedProvider: provider, status: 'failed', error })) };
  const before = JSON.stringify(loop); noKorean(en(createElement(LoopProgress, { loop }))); assert.equal(JSON.stringify(loop), before);
});
test('unexpected exception strings are never shown in the Loop error UI', () => {
  const loop: Loop = { ...base, status: 'failed', error: 'private-secret at C:\\Users\\person', steps: base.steps.map(step => ({ ...step, status: 'failed', error: '[TIMEOUT] private-secret' })) };
  const html = en(createElement(LoopProgress, { loop })); noKorean(html); assert.doesNotMatch(html, /private-secret|Users/);
});
