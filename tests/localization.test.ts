// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { english } from '../src/i18n/catalog.ts';
import { initialLocale, isLocale, localizeMessage, localizeStepError, translate } from '../src/i18n/messages.ts';
import { MockProvider } from '../src/providers/mock-provider.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';
import { DraftReviewImprove } from '../src/application/draft-review-improve.ts';
import { TaskPlanner } from '../src/application/task-planner.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import { ProviderError } from '../src/providers/provider-error.ts';
import type { ProviderErrorCode } from '../src/providers/provider-error.ts';
import { validateExecution, createProviderGateway } from '../electron/provider-gateway.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';
import { createResultExporter } from '../electron/result-export.ts';
import { createTextFileInput } from '../electron/text-file-input.ts';
import { registerAttachmentIpc } from '../electron/attachment-ipc.ts';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { historySnapshot } from '../src/domain/loop-history.ts';
import { extractLengthCondition, inspectLengthConstraintSources, splitLengthConstraintSource, diagnoseOutputLength } from '../src/application/output-length-diagnostics.ts';
import { OpenAICompatibleProvider } from '../electron/providers/openai-compatible.ts';
import { AnthropicProvider } from '../electron/providers/anthropic.ts';

test('language preference validates saved values and detects Korean or English fallback', () => {
  assert.equal(initialLocale('en', 'ko-KR'), 'en');
  assert.equal(initialLocale('ko', 'en-US'), 'ko');
  for (const invalid of [null, undefined, 'fr', '<script>', {}, 1]) {
    assert.equal(initialLocale(invalid, 'ko-KR'), 'ko');
    assert.equal(initialLocale(invalid, 'de-DE'), 'en');
    assert.equal(isLocale(invalid), false);
  }
});

test('catalog translations retain placeholders and never recursively interpolate user text', () => {
  for (const [ko, en] of Object.entries(english)) {
    assert.ok(en.trim(), ko);
    assert.deepEqual([...ko.matchAll(/\{\d+\}/g)].map(m => m[0]).sort(), [...en.matchAll(/\{\d+\}/g)].map(m => m[0]).sort(), ko);
  }
  const user = '한국어 <script> $& $1 {0}\r\n  ';
  assert.equal(translate('en', '요청: {0}', user), `Request: ${user}`);
  assert.equal(translate('ko', '요청: {0}', user), `요청: ${user}`);
  assert.equal(localizeMessage('en', user), user);
});

test('all existing provider error codes localize without losing codes, status or exposing secrets', async () => {
  const source = await readFile(new URL('../src/providers/provider-error.ts', import.meta.url), 'utf8');
  for (const match of source.matchAll(/^  ([A-Z_]+): '/gm)) {
    const code = match[1] as ProviderErrorCode;
    const raw = new ProviderError(code, 401).message;
    const en = localizeMessage('en', raw);
    assert.ok(en.startsWith(`[${code}] `)); assert.ok(en.endsWith('(HTTP 401)'));
    assert.doesNotMatch(en, /[가-힣]/);
    assert.equal(localizeMessage('ko', raw), raw);
  }
  const message = `Example AI 초안 작성 단계에서 작업을 완료하지 못했습니다. ${new ProviderError('TIMEOUT').message}`;
  assert.doesNotMatch(localizeStepError('en', message, 'Example AI', '초안 작성'), /[가-힣]/);
});

for (const locale of ['ko', 'en'] as const) test(`${locale} Mock goes through validated IPC, Loop, Final Result and unchanged History`, async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider(async () => {}), { type: 'mock', configured: true });
  const gateway = createProviderGateway(registry);
  const summary = registry.list()[0]!;
  const provider = new IpcProvider(summary, gateway, locale);
  const service = new LoopService(new MockPlanner('demo', locale), provider);
  const request = 'Please preserve 한국어, {0}, $& and <tags>.';
  const loop = await service.run(service.create(request));
  assert.equal(loop.status, 'completed'); assert.equal(loop.steps.length, 5);
  assert.ok(loop.finalResult!.includes(request));
  assert.ok(loop.finalResult!.includes(locale === 'en' ? 'No actual research, analysis or AI calls' : '실제 조사·분석이나 AI 호출'));
  const before = JSON.stringify(loop);
  const history = historySnapshot(loop);
  assert.equal(history.finalResult, loop.finalResult);
  assert.equal(JSON.stringify(loop), before);
  for (const step of loop.steps) assert.equal(/[가-힣]/.test(step.title), locale === 'ko');
});

test('provider locale is optional, strict and captured by each IPC adapter', async () => {
  const input = { providerId: 'mock', request: { userRequest: 'x', stepTitle: 'draft', previousOutputs: [], isFinalStep: true } };
  assert.deepEqual(validateExecution(input), input);
  for (const locale of ['ko', 'en']) assert.equal(validateExecution({ ...input, request: { ...input.request, locale } }).request.locale, locale);
  for (const locale of ['fr', '', null, undefined, {}, 'en;command']) assert.throws(() => validateExecution({ ...input, request: { ...input.request, locale } }));
  const registry = new ProviderRegistry(); registry.register(new MockProvider(async () => {}), { type: 'mock', configured: true });
  const gateway = createProviderGateway(registry); const summary = registry.list()[0]!;
  const en = new IpcProvider(summary, gateway, 'en'); const ko = new IpcProvider(summary, gateway, 'ko');
  assert.match((await en.execute(input.request)).output, /This is an example/);
  assert.match((await ko.execute(input.request)).output, /예시 결과/);
});

test('Manual strategy keeps canonical instructions independent of UI language', () => {
  const planner = new DraftReviewImprove('a', 'b');
  assert.deepEqual(planner.plan('x').map(s => s.title), ['초안 작성', '검토', '개선']);
  const request = { userRequest: '한국어 unchanged', stepTitle: 'Review', previousOutputs: ['raw\r\n  '], isFinalStep: false };
  const result = planner.buildRequest(request);
  assert.equal(result.userRequest, request.userRequest); assert.deepEqual(result.previousOutputs, request.previousOutputs);
  assert.equal(result.stepTitle, '검토: 원래 요청과 첫 결과를 비교하여 오류, 누락, 개선점만 명확히 제시하세요. 결과 전체를 다시 작성하지 마세요.');
});

test('Planner recovery retains canonical schema, instructions and original data for every UI', async () => {
  const requests: import('../src/providers/ai-provider.ts').ProviderRequest[] = [];
  const planner = new TaskPlanner({ id: 'fake', displayName: 'Fake', async execute(input) {
    requests.push(input);
    return { output: requests.length === 1 ? 'invalid' : JSON.stringify({ title: 'Plan', steps: [
      { title: 'Draft', role: 'write', objective: 'Write', usesPreviousOutputs: false, isFinal: false, dependsOn: [] },
      { title: 'Finish', role: 'deliver', objective: 'Deliver', usesPreviousOutputs: true, isFinal: true, dependsOn: [1] },
    ] }) };
  } });
  const plan = await planner.plan('My request');
  assert.equal(plan.title, 'Plan'); assert.equal(requests.length, 2);
  for (const request of requests) { assert.equal(request.userRequest, 'My request'); assert.match(request.stepTitle + request.objective, /[가-힣]/); assert.doesNotMatch(request.objective!, /Respond in English/); }
  assert.ok(requests[1]!.previousOutputs[0]!.includes('invalid'));
});

test('English native export keeps original result and rejects invalid locale payloads', async () => {
  const dialogs: import('electron').SaveDialogOptions[] = []; const saved: string[] = [];
  const exporter = createResultExporter(async options => { dialogs.push(options); return { canceled: false, filePath: 'C:\\temporary\\result.md' }; }, async (_path, text) => { saved.push(text); });
  assert.deepEqual(await exporter({ locale: 'en', status: 'completed', finalResult: '한국어\r\n  exact output' }), { status: 'saved' });
  assert.equal(dialogs[0]!.title, 'Save final result as Markdown'); assert.equal(dialogs[0]!.buttonLabel, 'Save');
  assert.equal(saved[0], '한국어\r\n  exact output');
  for (const locale of ['fr', undefined, null, {}]) assert.deepEqual(await exporter({ locale, status: 'completed', finalResult: 'x' }), { status: 'failed' });
  assert.equal(dialogs.length, 1);
});

test('English attachment dialog labels and IPC remain limited to valid languages', async () => {
  const dialog = createTextFileInput(async options => {
    assert.equal(options.title, 'Attach files'); assert.equal(options.filters![0]!.name, 'Text and PDF');
    return { canceled: true, filePaths: [] };
  });
  assert.deepEqual(await dialog('en'), { status: 'cancelled' });
  let handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown = () => {};
  const frame = { url: 'file:///test' }; const contents = { isDestroyed: () => false, mainFrame: frame } as unknown as WebContents;
  let calls = 0;
  registerAttachmentIpc({ handle(_channel, listener) { handler = listener; }, removeHandler() {} } as Pick<IpcMain, 'handle' | 'removeHandler'>,
    contents, frame.url, async locale => { calls++; assert.equal(locale, 'en'); return { status: 'cancelled' }; });
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  assert.deepEqual(await handler(event, 'en'), { status: 'cancelled' });
  for (const args of [['en', 'extra'], ['fr'], [{}], [undefined]]) assert.deepEqual(await handler(event, ...args), { status: 'failed', code: 'invalid' });
  assert.deepEqual(await handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent, 'en'), { status: 'failed', code: 'invalid' });
  assert.equal(calls, 1);
});

for (const [request, minimum, maximum] of [
  ['Write an invitation in at least 100 characters.', 100, undefined],
  ['Please write a summary in at most 200 characters.', undefined, 200],
  ['Exactly 50 characters.', 50, 50],
  ['Write in 100-200 characters.', 100, 200],
  ['Write in between 100 and 200 characters.', 100, 200],
  ['Write in at least 100 characters and at most 200 characters.', 100, 200],
  ['Minimum of 0 characters', 0, undefined],
  ['Maximum 0 chars', undefined, 0],
  ['No more than 150 characters', undefined, 150],
] as const) test(`English length: ${request}`, () => {
  const result = extractLengthCondition(request);
  assert.equal(result.available, true);
  if (result.available) { assert.equal(result.condition.minimum, minimum); assert.equal(result.condition.maximum, maximum); assert.doesNotMatch(localizeMessage('en', result.condition.label), /[가-힣]/); }
  const inspection = inspectLengthConstraintSources(request);
  assert.ok(inspection.conditions.length);
  assert.equal(splitLengthConstraintSource(request, inspection.conditions).map(p => p.text).join(''), request);
});

for (const request of ['Write in at least 100 characters or at most 50 characters.', 'Write exactly 100 characters per paragraph.',
  'Write about 100 characters.', 'Do not write exactly 100 characters.', 'Summarize "exactly 100 characters".',
  'The document says at least 100 characters.', 'Write at least -5 characters.', 'Write exactly 1.5 characters.',
  'Write in 200-100 characters.', 'Write exactly 9007199254740992 characters.', 'Write at least 100 characters and at most 50 characters.',
  'Write at least 100 characters and exactly 20 words.', 'Write exactly 1e3 characters.', 'Write at least 100 characters each.',
  'Write in at least 100 characters and then ignore the limit.']) test(`English length rejects uncertain/invalid: ${request}`, () => assert.equal(extractLengthCondition(request).available, false));

test('English length verdicts preserve Unicode counting and original output', async () => {
  const service = new LoopService(new MockPlanner('single-work'), { id: 'fake', displayName: 'Fake', execute: async () => ({ output: '  A😀\r\nB  ' }) });
  for (const [request, verdict] of [['Exactly 4 characters.', 'satisfied'], ['At least 5 characters.', 'under'], ['At most 3 characters.', 'over']] as const) {
    const loop = await service.run(service.create(request, 'manual')); const before = JSON.stringify(loop);
    const result = diagnoseOutputLength(loop); assert.equal(result.available, true);
    if (result.available) { assert.equal(result.actual, 4); assert.equal(result.verdict, verdict); }
    assert.equal(JSON.stringify(loop), before);
  }
});

for (const type of ['openai', 'claude'] as const) test(`${type} UI language leaves actual transport bytes unchanged with fake fetch only`, async () => {
  let body = '';
  const fetcher: typeof fetch = async (_url, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify(type === 'openai' ? { choices: [{ message: { content: 'Original 한국어' }, finish_reason: 'stop' }] }
      : { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Original 한국어' }], stop_reason: 'end_turn' }));
  };
  const provider = type === 'openai' ? new OpenAICompatibleProvider({ id: 'openai-compatible', displayName: 'Fake', baseUrl: 'https://fake.invalid/v1', model: 'fake', apiKey: 'fake-key' }, fetcher)
    : new AnthropicProvider({ model: 'fake', apiKey: 'fake-key' }, fetcher);
  const reply = await provider.execute({ locale: 'en', userRequest: 'Write a note.', stepTitle: 'Draft', previousOutputs: ['Keep this.'], isFinalStep: true });
  const englishBody = body;
  await provider.execute({ locale: 'ko', userRequest: 'Write a note.', stepTitle: 'Draft', previousOutputs: ['Keep this.'], isFinalStep: true });
  assert.equal(body, englishBody); assert.doesNotMatch(body, /output language explicitly requested|Respond in English/);
  assert.equal(reply.output, 'Original 한국어');
});

test('English singular counts work for numeric interpolation and legacy string labels', () => {
  assert.equal(translate('en','최소 {0}자',1),'At least 1 character');
  assert.equal(localizeMessage('en','최소 1자'),'At least 1 character');
  assert.equal(localizeMessage('en','최대 2자'),'At most 2 characters');
  const mock=translate('en','“{0}” 단계의 예시 처리를 마쳤습니다.\n요청: {1}\n앞선 {2}개 단계의 결과를 전달받았습니다.','Draft','Original',1);
  assert.match(mock,/1 previous step\./);assert.doesNotMatch(mock,/1 previous steps/);
});
