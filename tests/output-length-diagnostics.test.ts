// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extractLengthCondition, diagnoseOutputLength, canDiagnoseLength } from '../src/application/output-length-diagnostics.ts';
import { createLoop } from '../src/domain/loop.ts';
import type { Loop } from '../src/domain/loop.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';
import { historySnapshot } from '../src/domain/loop-history.ts';
import { exportCompletedResult } from '../src/application/result-export.ts';

function completed(request: string, output: string): Loop {
  const loop = createLoop(request, [{ title: '글 작성' }], { id: 'mock', displayName: 'Mock' }, { mode: 'manual' });
  return { ...loop, startedAt: loop.createdAt, completedAt: loop.createdAt, status: 'completed', finalResult: output,
    steps: loop.steps.map(step => ({ ...step, status: 'completed', startedAt: loop.createdAt, completedAt: loop.createdAt, output })) };
}

for (const [request, minimum, maximum] of [
  ['최소 100자', 100, undefined], ['최대 200자', undefined, 200], ['100~200자로 작성해줘.', 100, 200],
  ['정확히 150자로 작성해줘.', 150, 150], ['100자 이상', 100, undefined], ['200자 이하', undefined, 200],
  ['200자 이내', undefined, 200], ['안내문을 최소100 자로 작성해주세요.', 100, undefined],
  ['100 ～ 200 자로 작성해줘.', 100, 200], ['정확히0자', 0, 0], ['최소 0자로 작성해줘', 0, undefined],
  ['최대 9007199254740991자로 작성해줘', undefined, Number.MAX_SAFE_INTEGER],
  // Stage 33 deliberately promotes this previously unsupported conjunction.
  ['100자 이상 200자 이하로 작성해줘.', 100, 200],
] as const) test(`extract explicit length: ${request}`, () => {
  const result = extractLengthCondition(request);
  assert.equal(result.available, true);
  if (result.available) { assert.equal(result.condition.minimum, minimum); assert.equal(result.condition.maximum, maximum); }
});

for (const request of [
  '짧게 작성해줘.', '적당한 분량으로 작성해줘.', '2026년 행사 안내문을 작성해줘.', '100자로 작성해줘.',
  '약 100자로 작성해줘.', '대략 100~200자로 작성해줘.',
  '최소 200자 최대 100자로 작성해줘.', '100~200자 또는 정확히 300자로 작성해줘.',
  '정확히 100자 정도로 작성해줘.', '최소 100자 말고 최대 200자로 작성해줘.',
  '최소 100자라는 문구를 작성해줘.', '원문: 최소 100자로 작성해줘.',
  '"최소 100자로 작성해줘"를 요약해줘.', '“100~200자로 작성해줘”를 요약해줘.',
  '> 최소 100자로 작성해줘.\n이 글을 요약해줘.', '```최대 200자로 작성해줘```',
  '자료를 최소 100자로 요약해주세요.', '첨부 파일에는 정확히 100자라고 적혀 있어.',
  '최소 100자로 작성하지 마.', '최소 100자가 아니어도 된다. 작성해줘.',
  '각 문단을 최소 100자로 작성해줘.', '제목은 최대 20자로 작성해줘.',
  '공백 제외 최소 100자로 작성해줘.', '공백을 빼고 최소 100자로 작성해줘.',
  '100~20자로 작성해줘.', '정확히 -100자로 작성해줘.', '최소 1.5자로 작성해줘.',
  '최소 1,000자로 작성해줘.', '최소 9007199254740992자로 작성해줘.',
  '최소 1e3자로 작성해줘.', '최소 100자로 작성해줘. 최대 글자 수는 200자.',
  '본문: 최소 100자로 작성해줘.', '[지시] 최소 100자로 작성해줘.',
  '최소 100자 이내로 작성해줘.', '100-200자로 작성해줘.', '', ' '.repeat(20_001),
  '첫 문단은 최소 100자로 작성해줘.', '서론은 최대 100자로 작성해줘.',
  '최소 100자로 작성한 문구를 다시 작성해줘.', '최소 100자라고 적힌 글을 작성해줘.',
  '최소 100자격으로 작성해줘.', 'abc100자 이상으로 작성해줘.',
]) test(`fail closed: ${request.slice(0, 60) || '(empty)'}`, () => {
  assert.equal(extractLengthCondition(request).available, false);
});

for (const [output, length] of [
  ['한국어', 3], ['abc', 3], ['123', 3], ['!@#', 3], ['😀', 1], ['e\u0301', 2], ['👨‍👩‍👧‍👦', 7],
  [' a b ', 3], ['가\n나', 3], ['가\r\n나', 3], ['# 글\n**끝**', 9], ['\t 가\t나 \r\n', 3],
] as const) test(`reuse frozen counting: ${JSON.stringify(output)}`, () => {
  const result = diagnoseOutputLength(completed(`정확히 ${length}자로 작성해줘.`, output));
  assert.equal(result.available, true);
  if (result.available) { assert.equal(result.actual, length); assert.equal(result.verdict, 'satisfied'); }
});

for (const [request, output, verdict, difference] of [
  ['최소 3자', '가나', 'under', 1], ['최소 3자', '가나다', 'satisfied', 0],
  ['최대 3자', '가나다라', 'over', 1], ['최대 3자', '가나다', 'satisfied', 0],
  ['2~4자', '가', 'under', 1], ['2~4자', '가나', 'satisfied', 0], ['2~4자', '가나다라', 'satisfied', 0],
  ['2~4자', '가나다라마', 'over', 1], ['정확히 3자', '가나', 'under', 1],
  ['정확히 3자', '가나다라', 'over', 1], ['정확히 0자', '가', 'over', 1],
] as const) test(`strict comparison ${request}/${output}`, () => {
  const result = diagnoseOutputLength(completed(request, output));
  assert.equal(result.available, true);
  if (result.available) { assert.equal(result.verdict, verdict); assert.equal(result.difference, difference); }
});

for (const status of ['pending', 'running', 'failed', 'cancelled'] as const) test(`no diagnosis in ${status}`, () => {
  const loop = { ...completed('최소 100자', '짧음'), status };
  assert.equal(canDiagnoseLength(loop), false);
  assert.deepEqual(diagnoseOutputLength(loop), { available: false, reason: 'unavailable_result' });
});
for (const output of ['', ' \r\n ', '\ud800', '가'.repeat(200_001)]) test(`invalid output safe (${output.length})`, () => {
  assert.equal(canDiagnoseLength(completed('최소 100자', output)), false);
});
test('Auto and Manual collaboration excluded regardless of final output/provider', () => {
  const loop = completed('최소 100자', '결과');
  assert.equal(canDiagnoseLength({ ...loop, mode: 'auto' }), false);
  assert.equal(canDiagnoseLength({ ...loop, auto: { phase: 'executing' } }), false);
  assert.equal(canDiagnoseLength({ ...loop, collaboration: { strategy: 'test', primaryProviderId: 'a', reviewerProviderId: 'b' } }), false);
});
test('no conditions reported without guessing; request/output pairs stay independent', () => {
  assert.deepEqual(diagnoseOutputLength(completed('짧게 써줘', '내용')), { available: false, reason: 'no_condition' });
  const first = diagnoseOutputLength(completed('최소 100자', '가'));
  const second = diagnoseOutputLength(completed('최대 2자', '가나'));
  assert.ok(first.available && first.verdict === 'under' && first.difference === 99);
  assert.ok(second.available && second.verdict === 'satisfied');
});
for (const id of ['mock', 'openai-compatible', 'anthropic', 'codex-cli-local', 'ollama-local']) {
  test(`${id}: real LoopService contract, no additional execution, unchanged History/export/status`, async () => {
    let calls = 0;
    const raw = '  # 원본 😀\r\n\r\n**글**  \n';
    const service = new LoopService(new MockPlanner('single-work'), { id, displayName: id,
      async execute() { calls++; return { output: raw }; } });
    const loop = await service.run(service.create('최소 100자로 작성해줘.', 'manual'));
    const before = JSON.stringify(loop); const history = historySnapshot(loop);
    const hash = createHash('sha256').update(loop.finalResult!).digest('hex');
    for (let count = 0; count < 3; count++) assert.ok(diagnoseOutputLength(loop).available);
    assert.equal(calls, 1); assert.equal(loop.status, 'completed'); assert.equal(JSON.stringify(loop), before);
    assert.equal(createHash('sha256').update(loop.finalResult!).digest('hex'), hash);
    assert.deepEqual(historySnapshot(loop), history);
    const saved = await exportCompletedResult(loop, { async exportMarkdown(input) {
      assert.deepEqual(Buffer.from(input.finalResult), Buffer.from(raw)); return { status: 'saved' };
    } });
    assert.deepEqual(saved, { status: 'saved' }); assert.equal(calls, 1);
  });
}
test('diagnostics have no transport, credentials, persistence, or model-policy dependencies', () => {
  const source = readFileSync(new URL('../src/application/output-length-diagnostics.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(imports, ['../domain/loop.ts', './writing-constraints.ts']);
  assert.doesNotMatch(source, /\bfetch\s*\(|window\.|process\.|localStorage|console\.|node:/);
});
