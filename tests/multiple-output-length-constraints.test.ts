// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { extractLengthCondition, diagnoseOutputLength, lengthUnavailableMessages } from '../src/application/output-length-diagnostics.ts';
import { createLoop } from '../src/domain/loop.ts';
import type { Loop } from '../src/domain/loop.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';
import { historySnapshot } from '../src/domain/loop-history.ts';
import { exportCompletedResult } from '../src/application/result-export.ts';

function completed(request: string, output: string): Loop {
  const loop = createLoop(request, [{ title: '작성' }], { id: 'mock', displayName: 'Mock' }, { mode: 'manual' });
  return { ...loop, status: 'completed', startedAt: loop.createdAt, completedAt: loop.createdAt, finalResult: output,
    steps: loop.steps.map(step => ({ ...step, status: 'completed', startedAt: loop.createdAt, completedAt: loop.createdAt, output })) };
}

for (const [request, minimum, maximum, label] of [
  ['최소 100자, 최대 200자로 작성해줘.', 100, 200, '100~200자'],
  ['100자 이상, 200자 이하로 정리해줘.', 100, 200, '100~200자'],
  ['100~200자, 150자 이상', 150, 200, '150~200자'],
  ['100~200자, 최대 180자', 100, 180, '100~180자'],
  ['200자 이하, 120자 이하', undefined, 120, '최대 120자'],
  ['100자 이상, 150자 이상', 150, undefined, '최소 150자'],
  ['정확히 150자, 100~200자', 150, 150, '정확히 150자'],
  ['정확히 150자, 정확히 150자', 150, 150, '정확히 150자'],
  ['최소 100자, 최소 100자', 100, undefined, '최소 100자'],
  ['최대 200자, 최대 200자', undefined, 200, '최대 200자'],
  ['100~200자, 100~200자', 100, 200, '100~200자'],
  ['10~200자, 100~300자, 최소 150자, 최대 180자', 150, 180, '150~180자'],
  ['100~150자, 150~200자', 150, 150, '정확히 150자'],
  ['정확히 150자, 최소 100자, 최대 200자', 150, 150, '정확히 150자'],
  ['최소 0자, 최대 0자', 0, 0, '정확히 0자'],
  ['0~5자, 정확히 0자', 0, 0, '정확히 0자'],
  ['최소 0자, 최대 5자', 0, 5, '0~5자'],
  ['최소100 자,최대200 자로 작성해주세요.', 100, 200, '100~200자'],
  ['최소 100자\r\n최대 200자', 100, 200, '100~200자'],
  ['최소 100자 그리고 최대 200자로 작성해줘.', 100, 200, '100~200자'],
  ['최소 100자 및 최대 200자로 작성해줘.', 100, 200, '100~200자'],
  ['2026년 행사 안내문을 최소 100자, 최대 200자로 작성해줘.', 100, 200, '100~200자'],
  ['최소 9007199254740991자, 최대 9007199254740991자', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, '정확히 9007199254740991자'],
] as const) test(`inclusive intersection: ${request}`, () => {
  assert.deepEqual(extractLengthCondition(request), { available: true, condition: { minimum, maximum, label } });
});

for (const request of [
  '최소 200자, 최대 100자로 작성해줘.', '정확히 150자, 정확히 160자',
  '100~150자, 200자 이상', '100~150자, 90자 이하',
  '정확히 80자, 최소 100자', '정확히 200자, 최대 100자',
  '정확히 0자, 최소 1자', '100~200자, 201~300자',
  '최소 100자, 최대 200자, 정확히 50자',
]) test(`empty intersection is a conflict: ${request}`, () => {
  assert.deepEqual(extractLengthCondition(request), { available: false, reason: 'conflict' });
  const loop = completed(request, '실제 원본');
  const before = JSON.stringify(loop);
  const result = diagnoseOutputLength(loop);
  assert.deepEqual(result, { available: false, reason: 'conflict' });
  assert.ok(!('actual' in result) && !('verdict' in result));
  assert.equal(JSON.stringify(loop), before);
  assert.equal(lengthUnavailableMessages.conflict, '요청한 글자 수 조건이 서로 충돌합니다.');
});

for (const request of [
  '최소 -100자, 최대 200자로 작성해줘.', '최소 100자, 최대 200.5자로 작성해줘.',
  '최소 100자, 최대 1,000자로 작성해줘.', '최소 1e2자, 최대 200자로 작성해줘.',
  '최소 100자, 최대 9007199254740992자로 작성해줘.',
  '200~100자, 정확히 150자로 작성해줘.',
  '최소 200자, 최대 100자, 최대 999999999999999999999999자',
  '－100자 이상, 최대 200자로 작성해줘.', '＋100자 이상, 최대 200자로 작성해줘.',
]) test(`invalid number/range never repaired: ${request}`, () => {
  assert.deepEqual(extractLengthCondition(request), { available: false, reason: 'invalid' });
});

for (const request of [
  '"최소 100자, 최대 200자로 작성해줘"를 요약해줘.',
  '“최소 100자” 그리고 최대 200자로 작성해줘.',
  '인용: 최소 100자, 최대 200자', '첨부 파일: 최소 100자, 최대 200자',
  '> 최소 100자\n최대 200자로 작성해줘.', '예시: 최소 100자, 최대 200자',
  '100자 이상 쓰지 마. 최대 200자로 작성해줘.',
  '최소 100자는 지키지 마세요. 최대 200자로 작성해줘.',
  '최소 100자 또는 최대 200자로 작성해줘.', '최소 100자 혹은 최대 200자로 작성해줘.',
  '최소 100자거나 최대 200자로 작성해줘.', '최소 100자 or 최대 200자로 작성해줘.',
  '최소 100자, 최대 200자 중 하나로 작성해줘.',
  '최소 100자 대신 최대 200자로 작성해줘.', '최소 100자와 비슷하게 최대 200자로 작성해줘.',
  '최소 100자, 약 200자로 작성해줘.', '최소 100자, 최대 200자 정도로 작성해줘.',
  '최소 100자, 200자 미만으로 작성해줘.', '최소 100자, 200자 초과로 작성해줘.',
  '최소 100자, 200글자 미만으로 작성해줘.', '최소 100자, 200글자로 작성해줘.',
  '최소 100자, 200단어로 작성해줘.', '최소 100자, 200 bytes로 작성해줘.',
  '최소 100자, 200 words로 작성해줘.', '최소 100자, 200 characters로 작성해줘.',
  '최소 100자, 최대 백 자로 작성해줘.', '최소 100자, 최대 NaN자로 작성해줘.',
  '최소 100자, 최대 Infinity자로 작성해줘.', '최소 100자, 최대 ２００자로 작성해줘.',
  '최소 100자, ２００자 이내로 작성해줘.',
  '첫 문단 최소 100자, 본문 최대 200자로 작성해줘.',
  '최소 100자, 최대 200자라는 문구를 작성해줘.',
  '공백 제외 최소 100자, 최대 200자로 작성해줘.',
  '최소 100자로 작성해줘. 최대 글자 수는 200자.',
  '최소 100자, 200자 내로 작성해줘.',
  '최소 100자, 최대 200자, 길이는 적당하게 작성해줘.',
  '최소 200자, 최대 100자 또는 정확히 50자로 작성해줘.',
  '최소 100자. 최대 200자로 작성해줘.',
  '최소 100자, 최대 200자 그리고', '최소 100자, ２００자로 작성해줘.',
  '최소 100자, 백 자로 작성해줘.', '최소 100자, 200행으로 작성해줘.',
  '최소 100자, 글자 수는 적당하게 작성해줘.',
  '최소 100자, 200bytes로 작성해줘.', '최소 100자, 200characters로 작성해줘.',
  '최소 100자, 200문자로 작성해줘.',
  '최소 100자, 최대 200자를 안 지키고 작성해줘.',
  '최소 100자, 최대 200자로 쓸 필요 없이 작성해줘.',
  '가능하면 최소 100자, 최대 200자로 작성해줘.',
  '만약 최소 100자, 최대 200자로 작성해줘.',
]) test(`do not silently drop unparsed related instructions: ${request}`, () => {
  assert.deepEqual(extractLengthCondition(request), { available: false, reason: 'uncertain' });
});

for (const [request, output, verdict, difference] of [
  ['최소 3자, 최대 5자', '가나다', 'satisfied', 0],
  ['최소 3자, 최대 5자', '가나다라마', 'satisfied', 0],
  ['최소 3자, 최대 5자', '가나', 'under', 1],
  ['최소 3자, 최대 5자', '가나다라마바', 'over', 1],
  ['2~5자, 정확히 3자', '가😀나', 'satisfied', 0],
  ['최소 3자, 최대 3자', ' \t가\r\n나  ', 'satisfied', 0],
  ['최소 6자, 최대 6자', '  # 가😀\r\n나  ', 'satisfied', 0],
  ['정확히 0자, 최대 0자', '가', 'over', 1],
] as const) test(`combined boundary diagnostic: ${request} / ${JSON.stringify(output)}`, () => {
  const result = diagnoseOutputLength(completed(request, output));
  assert.equal(result.available, true);
  if (result.available) { assert.equal(result.verdict, verdict); assert.equal(result.difference, difference); }
});

test('intersection is order independent, idempotent, and agrees with enumerated sets', () => {
  for (let low = 0; low <= 5; low++) for (let high = 0; high <= 5; high++) {
    const clauses = [`최소 ${low}자`, `최대 ${high}자`, '1~4자'];
    const expected = Array.from({ length: 6 }, (_, n) => n).filter(n => n >= low && n <= high && n >= 1 && n <= 4);
    const result = extractLengthCondition(clauses.join(', '));
    assert.deepEqual(extractLengthCondition([...clauses].reverse().join(', ')), result);
    assert.deepEqual(extractLengthCondition([...clauses, ...clauses].join(', ')), result);
    if (!expected.length) assert.deepEqual(result, { available: false, reason: 'conflict' });
    else {
      assert.ok(result.available);
      assert.equal(result.condition.minimum, expected[0]); assert.equal(result.condition.maximum, expected.at(-1));
    }
  }
});

test('bounded input and pathological digit runs terminate without partial rules', { timeout: 2000 }, () => {
  assert.deepEqual(extractLengthCondition('최소 1자, '.repeat(3000)), { available: false, reason: 'invalid' });
  assert.equal(extractLengthCondition('9'.repeat(19_900) + '로 작성해줘.').available, false);
  assert.equal(extractLengthCondition('최소 ' + '9'.repeat(19_900) + '자, 최대 5자').available, false);
  const result = extractLengthCondition('최소 1자, '.repeat(1000) + '최대 5자');
  assert.ok(result.available && result.condition.minimum === 1 && result.condition.maximum === 5);
});

test('unrelated numbers alone are not constraints', () => {
  assert.deepEqual(extractLengthCondition('2026년 10월 행사 안내문을 작성해줘.'), { available: false, reason: 'no_condition' });
});

for (const id of ['mock', 'openai-compatible', 'anthropic', 'codex-cli-local', 'ollama-local']) {
  test(`${id}: combined/conflicting checks preserve full completed Loop, history/export and request count`, async () => {
    for (const request of ['최소 100자, 최대 200자로 작성해줘.', '최소 200자, 최대 100자로 작성해줘.']) {
      let calls = 0;
      const raw = '  # 원문 😀\r\n\n**완료**  ';
      const service = new LoopService(new MockPlanner('single-work'), { id, displayName: id,
        async execute() { calls++; return { output: raw }; } });
      const loop = await service.run(service.create(request, 'manual'));
      const before = JSON.stringify(loop); const history = historySnapshot(loop);
      const hash = createHash('sha256').update(raw).digest('hex');
      for (let n = 0; n < 3; n++) {
        const diagnosis = diagnoseOutputLength(loop);
        if (request.startsWith('최소 200자')) assert.deepEqual(diagnosis, { available: false, reason: 'conflict' });
        else assert.ok(diagnosis.available && diagnosis.verdict === 'under');
      }
      assert.equal(JSON.stringify(loop), before); assert.equal(calls, 1);
      assert.equal(loop.status, 'completed'); assert.equal(loop.userRequest, request);
      assert.equal(createHash('sha256').update(loop.finalResult!).digest('hex'), hash);
      assert.deepEqual(historySnapshot(loop), history);
      assert.deepEqual(await exportCompletedResult(loop, { async exportMarkdown(input) {
        assert.deepEqual(Buffer.from(input.finalResult), Buffer.from(raw)); return { status: 'saved' };
      } }), { status: 'saved' });
      assert.equal(calls, 1);
    }
  });
}
