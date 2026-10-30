// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspectLengthConstraintSources, splitLengthConstraintSource, extractLengthCondition, diagnoseOutputLength, getLengthDiagnosticGuidance } from '../src/application/output-length-diagnostics.ts';
import type { LengthConstraintSource } from '../src/application/output-length-diagnostics.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';
import { historySnapshot } from '../src/domain/loop-history.ts';
import { exportCompletedResult } from '../src/application/result-export.ts';

for (const [request, texts, kinds] of [
  ['최소 100자로 작성해줘.', ['최소 100자'], ['minimum']],
  ['최대 200자로 작성해줘.', ['최대 200자'], ['maximum']],
  ['100~200자로 작성해줘.', ['100~200자'], ['range']],
  ['정확히 150자로 작성해줘.', ['정확히 150자'], ['exact']],
  ['이 내용을 100자 이상, 200자 이하로 작성해줘.', ['100자 이상', '200자 이하'], ['minimum', 'maximum']],
  ['100자 이상, 150자 이상으로 작성해줘.', ['100자 이상', '150자 이상'], ['minimum', 'minimum']],
  ['200자 이하, 120자 이내로 작성해줘.', ['200자 이하', '120자 이내'], ['maximum', 'maximum']],
  ['100~200자, 최소 150자로 작성해줘.', ['100~200자', '최소 150자'], ['range', 'minimum']],
  ['100~200자, 정확히 150자로 작성해줘.', ['100~200자', '정확히 150자'], ['range', 'exact']],
  ['최소 100자, 최소 100자로 작성해줘.', ['최소 100자', '최소 100자'], ['minimum', 'minimum']],
  ['정확히 150자, 정확히 150자로 작성해줘.', ['정확히 150자', '정확히 150자'], ['exact', 'exact']],
  ['최소 200자, 최대 100자로 작성해줘.', ['최소 200자', '최대 100자'], ['minimum', 'maximum']],
  ['정확히 150자, 정확히 160자로 작성해줘.', ['정확히 150자', '정확히 160자'], ['exact', 'exact']],
  ['최소 0자, 최대 0자로 작성해줘.', ['최소 0자', '최대 0자'], ['minimum', 'maximum']],
] as const) test(`actual matching spans: ${request}`, () => {
  const before = Buffer.from(request);
  const inspection = inspectLengthConstraintSources(request);
  assert.equal(inspection.request, request); assert.equal(inspection.indexUnit, 'utf16');
  assert.deepEqual(inspection.extraction, extractLengthCondition(request));
  assert.deepEqual(inspection.conditions.map(source => source.text), texts);
  assert.deepEqual(inspection.conditions.map(source => source.kind), kinds);
  let cursor = 0;
  for (const [index, source] of inspection.conditions.entries()) {
    const expected = request.indexOf(texts[index]!, cursor);
    assert.equal(source.start, expected); assert.equal(source.end, expected + texts[index]!.length);
    assert.equal(request.slice(source.start, source.end), source.text); cursor = source.end;
  }
  const parts = splitLengthConstraintSource(request, inspection.conditions);
  assert.deepEqual(parts.filter(part => part.source).map(part => part.text), texts);
  assert.equal(parts.map(part => part.text).join(''), request);
  assert.deepEqual(Buffer.from(inspection.request), before);
});

for (const request of [
  '  최소 100자로 작성해줘.  ', 'English 최소 100자로 작성해줘.',
  '😀 최소 100자로 작성해줘.', '👨‍👩‍👧‍👦 최소 100자로 작성해줘.',
  'e\u0301 최소 100자로 작성해줘.', '✨ & % (공지) 최소 100자로 작성해줘.',
  '공지\r\n최소 100자,\r\n최대 200자로 작성해줘.', '공지\n최소 100자,\n최대 200자로 작성해줘.',
  '\t최소\t100 자, 최대 200 자로 작성해줘.\r\n',
  '최소\r\n100 자, 최대 200자로 작성해줘.',
  'javascript:alert(1) 최소 100자, 최대 200자로 작성해줘.',
]) test(`raw UTF-16 slicing without normalization: ${JSON.stringify(request)}`, () => {
  const result = inspectLengthConstraintSources(request);
  assert.ok(result.extraction.available); assert.ok(result.conditions.length);
  for (const source of result.conditions) assert.equal(request.slice(source.start, source.end), source.text);
  const restored = splitLengthConstraintSource(request, result.conditions).map(part => part.text).join('');
  assert.equal(restored, request);
  assert.equal(createHash('sha256').update(restored).digest('hex'), createHash('sha256').update(request).digest('hex'));
});
test('emoji prefix distinguishes UTF-16 source offsets from output codepoint counts', () => {
  const request = '😀 최소 3자로 작성해줘.';
  const source = inspectLengthConstraintSources(request).conditions[0]!;
  assert.equal(source.start, 3); assert.equal([...request.slice(0, source.start)].length, 2);
  assert.equal(source.text, '최소 3자'); assert.equal(source.end, 8);
});

for (const request of [
  '', '짧게 작성해줘.', '2026년 안내문을 작성해줘.',
  '"최소 100자"를 요약해줘.', '“최소 100자”를 요약해줘.',
  '> 최소 100자\n이 내용을 요약해줘.', '첨부 파일: 최소 100자',
  '최소 100자 이상 쓰지 마.', '최소 100자 또는 최대 200자로 작성해줘.',
  '대략 100~200자로 작성해줘.', '최소 -100자로 작성해줘.',
  '최대 1.5자로 작성해줘.', '200~100자로 작성해줘.', '최대 9007199254740992자로 작성해줘.',
  '최소 100자, 200글자로 작성해줘.', '최소 100자, 200자 미만으로 작성해줘.',
  '최소 100자, 최대 200자, 정확히 9999999999999999999999999999자로 작성해줘.',
  '최소 100자. 최대 200자로 작성해줘.', '[최소 100자]',
  '<script>window.sourceExecuted=true</script> 최소 100자로 작성해줘.',
  '<img src=x onerror=alert(1)> 최소 100자로 작성해줘.',
]) test(`no invented or partial source highlight: ${request || '(empty)'}`, () => {
  const result = inspectLengthConstraintSources(request);
  assert.deepEqual(result.extraction, extractLengthCondition(request)); assert.equal(result.extraction.available, false);
  assert.deepEqual(result.conditions, []);
  assert.deepEqual(splitLengthConstraintSource(request, result.conditions), [{ text: request }]);
});

test('repeated text retains occurrences while duplicate descriptors highlight only once', () => {
  const request = '최소 100자, 최소 100자';
  const inspection = inspectLengthConstraintSources(request);
  const sources = inspection.conditions;
  assert.equal(sources.length, 2); assert.notEqual(sources[0]!.start, sources[1]!.start);
  const parts = splitLengthConstraintSource(request, [sources[1]!, sources[0]!, { ...sources[0]! }]);
  assert.equal(parts.filter(part => part.source).length, 2);
  assert.equal(parts.map(part => part.text).join(''), request);
  assert.deepEqual(sources, inspectLengthConstraintSources(request).conditions);
});
test('overlapping or contradictory descriptors do not guess which substring to mark', () => {
  const request = '100~200자';
  const whole: LengthConstraintSource = { kind: 'range', start: 0, end: 8, text: request };
  for (const other of [
    { kind: 'maximum' as const, start: 4, end: 8, text: '200자' },
    { ...whole, kind: 'exact' as const },
  ]) assert.deepEqual(splitLengthConstraintSource(request, [whole, other]), [{ text: request }]);
});
test('bad source coordinates or mismatched text fail closed without corrupting the request', () => {
  const request = '😀 최소 3자';
  for (const source of [
    { start: -1, end: 2, text: '' }, { start: 3, end: 99, text: '' },
    { start: 3, end: 3, text: '' }, { start: 1.5, end: 2, text: '' },
    { start: NaN, end: 2, text: '' }, { start: 1, end: 2, text: request.slice(1, 2) },
    { start: 0, end: 1, text: request.slice(0, 1) }, { start: 3, end: 8, text: '최대 3자' },
  ]) assert.deepEqual(splitLengthConstraintSource(request, [{ ...source, kind: 'minimum' }]), [{ text: request }]);
});
test('source data is independent across inspections and old public result shapes stay intact', () => {
  const request = '최소 3자, 최대 5자';
  const first = inspectLengthConstraintSources(request);
  first.conditions[0]!.text = 'mutated';
  assert.equal(inspectLengthConstraintSources(request).conditions[0]!.text, '최소 3자');
  assert.deepEqual(extractLengthCondition(request), { available: true, condition: { minimum: 3, maximum: 5, label: '3~5자' } });
});
test('long request still respects the original input limit and preserves duplicate conditions', { timeout: 2000 }, () => {
  const request = '최소 1자, '.repeat(1000) + '최대 5자';
  const inspection = inspectLengthConstraintSources(request);
  assert.equal(inspection.conditions.length, 1001);
  assert.equal(splitLengthConstraintSource(request, inspection.conditions).map(part => part.text).join(''), request);
  assert.deepEqual(inspectLengthConstraintSources(request.repeat(4)).conditions, []);
});
test('safe rendering uses text children and adds no HTML or credential/transport surface', () => {
  const ui = readFileSync(new URL('../src/ui/OutputLengthDiagnostics.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML|innerHTML|\beval\s*\(|\bfetch\s*\(|console\.|localStorage|sessionStorage|window\.|process\.|node:/);
  assert.match(ui, /<mark[^>]*>\{part\.text\}<\/mark>/);
  assert.match(ui, /<Fragment key=\{index\}>\{part\.text\}<\/Fragment>/);
});
for (const id of ['mock', 'openai-compatible', 'anthropic', 'codex-cli-local', 'ollama-local']) {
  test(`${id}: sources leave request/output/status/diagnostic/history/export and execution count intact`, async () => {
    for (const request of ['최소 3자, 최대 10자로 작성해줘.', '최소 10자, 최대 3자로 작성해줘.']) {
      let calls = 0; const raw = '  가😀\r\n나  ';
      const service = new LoopService(new MockPlanner('single-work'), { id, displayName: id,
        async execute() { calls++; return { output: raw }; } });
      const loop = await service.run(service.create(request, 'manual'));
      const before = JSON.stringify(loop); const history = historySnapshot(loop);
      const result = diagnoseOutputLength(loop); const guidance = getLengthDiagnosticGuidance(request, result);
      const sources = inspectLengthConstraintSources(loop.userRequest);
      assert.equal(sources.conditions.length, 2);
      assert.equal(splitLengthConstraintSource(request, sources.conditions).map(part => part.text).join(''), request);
      assert.deepEqual(diagnoseOutputLength(loop), result); assert.deepEqual(getLengthDiagnosticGuidance(request, result), guidance);
      if (result.available) { assert.equal(result.actual, 4); assert.equal(result.verdict, 'satisfied'); }
      else assert.equal(result.reason, 'conflict');
      assert.equal(JSON.stringify(loop), before); assert.equal(calls, 1);
      assert.deepEqual(historySnapshot(loop), history);
      assert.deepEqual(await exportCompletedResult(loop, { async exportMarkdown(input) {
        assert.deepEqual(Buffer.from(input.finalResult), Buffer.from(raw)); return { status: 'saved' };
      } }), { status: 'saved' });
      assert.equal(calls, 1);
    }
  });
}
