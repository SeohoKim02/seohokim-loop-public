// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { extractLengthCondition, diagnoseOutputLength, getLengthDiagnosticGuidance } from '../src/application/output-length-diagnostics.ts';
import { createLoop } from '../src/domain/loop.ts';
import type { Loop } from '../src/domain/loop.ts';
import { historySnapshot } from '../src/domain/loop-history.ts';
import { exportCompletedResult } from '../src/application/result-export.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';

function completed(request: string, output = '가😀\r\n나'): Loop {
  const loop = createLoop(request, [{ title: '작성' }], { id: 'mock', displayName: 'Mock' }, { mode: 'manual' });
  return { ...loop, status: 'completed', startedAt: loop.createdAt, completedAt: loop.createdAt, finalResult: output,
    steps: loop.steps.map(step => ({ ...step, status: 'completed', startedAt: loop.createdAt, completedAt: loop.createdAt, output })) };
}
const general = '글자 수 조건을 명확하게 확인할 수 없습니다.';
const quoted = '인용·자료 표현이 있어 실제 작성 지시와 글자 수 조건을 구분할 수 없습니다.';
const ambiguous = '부정·선택 또는 모호한 표현이 있어 글자 수 조건을 확정할 수 없습니다.';
const unsupported = '현재 지원하지 않는 글자 수 표현입니다.';
const unit = '현재는 자 단위의 글자 수 조건만 확인할 수 있습니다.';
const number = '글자 수 조건의 숫자를 확인해주세요.';
const conflict = '요청한 글자 수 조건이 서로 충돌합니다.';

for (const [request, message, help] of [
  ['안내문을 작성해줘.', '요청에서 글자 수 조건을 찾지 못했습니다.', undefined],
  ['2026년 행사 안내문을 작성해줘.', '요청에서 글자 수 조건을 찾지 못했습니다.', undefined],
  ['최소 200자, 최대 100자', conflict, '결합한 최소 글자 수가 최대 글자 수보다 큽니다.'],
  ['정확히 150자, 정확히 160자', conflict, '서로 다른 정확한 글자 수가 요청되었습니다.'],
  ['정확히 150자, 100~120자', conflict, '결합한 최소 글자 수가 최대 글자 수보다 큽니다.'],
  ['200~100자', '최소 글자 수가 최대 글자 수보다 큽니다.', undefined],
  ['100자 미만으로 작성해줘.', unsupported, '최소 100자, 최대 200자처럼 명확한 조건으로 적어주세요.'],
  ['최소 50자, 100자 초과로 작성해줘.', unsupported, '최소 100자, 최대 200자처럼 명확한 조건으로 적어주세요.'],
  ['100자 이상 쓰지 마.', ambiguous, undefined],
  ['최소 100자를 안 지키고 작성해줘.', ambiguous, undefined],
  ['최소 100자 또는 최대 200자로 작성해줘.', ambiguous, undefined],
  ['대략 100~200자로 작성해줘.', ambiguous, undefined],
  ['가능하면 최소 100자로 작성해줘.', ambiguous, undefined],
  ['"최소 100자"를 요약해줘.', quoted, undefined],
  ['인용: 최소 100자', quoted, undefined],
  ['첨부 파일: 최대 100자', quoted, undefined],
  ['자료의 최소 100자 지시를 요약해줘.', quoted, undefined],
  ['최소 10자, 최대 20단어로 작성해줘.', unit, '단어나 바이트 수는 글자 수로 바꾸어 계산하지 않습니다.'],
  ['최소 10자, 20bytes로 작성해줘.', unit, '단어나 바이트 수는 글자 수로 바꾸어 계산하지 않습니다.'],
  ['20글자로 작성해줘.', unit, '단어나 바이트 수는 글자 수로 바꾸어 계산하지 않습니다.'],
  ['최소 -100자로 작성해줘.', number, '0 이상의 정수로 적어주세요. 너무 큰 수와 음수·소수·쉼표·지수 표기는 지원하지 않습니다.'],
  ['최대 1.5자로 작성해줘.', number, '0 이상의 정수로 적어주세요. 너무 큰 수와 음수·소수·쉼표·지수 표기는 지원하지 않습니다.'],
  ['최대 1,000자로 작성해줘.', number, '0 이상의 정수로 적어주세요. 너무 큰 수와 음수·소수·쉼표·지수 표기는 지원하지 않습니다.'],
  ['최소 1e3자로 작성해줘.', number, '0 이상의 정수로 적어주세요. 너무 큰 수와 음수·소수·쉼표·지수 표기는 지원하지 않습니다.'],
  ['최소 9007199254740992자로 작성해줘.', number, '0 이상의 정수로 적어주세요. 너무 큰 수와 음수·소수·쉼표·지수 표기는 지원하지 않습니다.'],
  ['[최소 100자]', general, undefined],
  ['최소 100자. 최대 200자로 작성해줘.', general, undefined],
  ['최소 100자 그리고', general, undefined],
  ['최소 100자, 최대 NaN자로 작성해줘.', general, undefined],
  ['버전 1.5 안내를 최소 100자로 작성해줘.', general, undefined],
  ['2026-10월 안내문을 최소 100자로 작성해줘.', general, undefined],
  ['최소 100자, 200글쓰기 사례로 작성해줘.', general, undefined],
] as const) test(`confirmed guidance: ${request}`, () => {
  const loop = completed(request); const result = diagnoseOutputLength(loop);
  assert.equal(result.available, false);
  const guidance = getLengthDiagnosticGuidance(request, result);
  assert.equal(guidance?.message, message); assert.equal(guidance?.help, help);
  assert.doesNotMatch(JSON.stringify(guidance), /API|Parser|Validator|uncertain|invalid|conflict|stack/i);
  assert.deepEqual(diagnoseOutputLength(loop), result);
});

for (const [request, minimum, maximum, length, verdict] of [
  ['최소 100자, 최대 200자', 100, 200, 4, 'under'],
  ['정확히 150자, 100~200자', 150, 150, 4, 'under'],
  ['최소 3자, 최대 5자', 3, 5, 4, 'satisfied'],
  ['최대 3자', undefined, 3, 4, 'over'],
  ['정확히 4자, 정확히 4자', 4, 4, 4, 'satisfied'],
  ['최소 0자, 최대 0자', 0, 0, 4, 'over'],
] as const) test(`guidance cannot alter valid bounds/count: ${request}`, () => {
  const parsed = extractLengthCondition(request);
  assert.ok(parsed.available); assert.equal(parsed.condition.minimum, minimum); assert.equal(parsed.condition.maximum, maximum);
  const loop = completed(request, ' \t가😀\r\n나  ');
  const result = diagnoseOutputLength(loop);
  assert.ok(result.available); assert.equal(result.actual, length); assert.equal(result.verdict, verdict);
  assert.equal(getLengthDiagnosticGuidance(request, result), undefined);
});

test('unknown evidence stays generic, oversized request is not falsely a numeric error', () => {
  const request = '최소 1자로 작성해줘.' + ' '.repeat(20_001);
  const result = diagnoseOutputLength({ ...completed('최소 1자'), userRequest: request });
  assert.deepEqual(result, { available: false, reason: 'invalid' });
  assert.deepEqual(getLengthDiagnosticGuidance(request, result), { message: general });
});
test('guidance cannot attach a cause from a mismatched failure class', () => {
  assert.deepEqual(getLengthDiagnosticGuidance('최소 1자', { available: false, reason: 'conflict' }), { message: general });
  assert.deepEqual(getLengthDiagnosticGuidance('최소 2자, 최대 1자', { available: false, reason: 'invalid' }), { message: general });
});
test('unavailable run status retains its own message, not a request diagnosis', () => {
  const loop = { ...completed('최소 -100자'), status: 'running' as const };
  assert.deepEqual(getLengthDiagnosticGuidance(loop.userRequest, diagnoseOutputLength(loop)),
    { message: '완료된 단일 AI 결과에서만 분량을 확인할 수 있습니다.' });
});
test('guidance returns independent plain text and never echoes request or output', () => {
  const request = '"private-guidance-secret 최소 100자"를 요약해줘.';
  const result = diagnoseOutputLength(completed(request, '<script>private-output</script>'));
  const guidance = getLengthDiagnosticGuidance(request, result)!;
  assert.doesNotMatch(JSON.stringify(guidance), /private|<script>/);
  guidance.message = 'changed';
  assert.equal(getLengthDiagnosticGuidance(request, result)?.message, quoted);
});
test('long digit runs remain bounded with guidance enabled', { timeout: 2000 }, () => {
  for (const request of ['9'.repeat(19_900) + '로 작성해줘.', '최대 ' + '9'.repeat(19_800) + '.5자로 작성해줘.']) {
    const result = diagnoseOutputLength(completed(request));
    assert.equal(result.available, false);
    assert.ok(getLengthDiagnosticGuidance(request, result)?.message);
  }
});
for (const id of ['mock', 'openai-compatible', 'anthropic', 'codex-cli-local', 'ollama-local']) {
  test(`${id}: reason guidance preserves Loop/History/export with no execution`, async () => {
    let calls = 0; const raw = '  # 원문 😀\r\n\n**완료**  ';
    const service = new LoopService(new MockPlanner('single-work'), { id, displayName: id,
      async execute() { calls++; return { output: raw }; } });
    const loop = await service.run(service.create('최소 200자, 최대 100자로 작성해줘.', 'manual'));
    const before = JSON.stringify(loop); const history = historySnapshot(loop);
    const hash = createHash('sha256').update(raw).digest('hex');
    const result = diagnoseOutputLength(loop);
    for (let n = 0; n < 3; n++) assert.equal(getLengthDiagnosticGuidance(loop.userRequest, result)?.message, conflict);
    assert.equal(JSON.stringify(loop), before); assert.equal(loop.status, 'completed'); assert.equal(calls, 1);
    assert.deepEqual(historySnapshot(loop), history);
    assert.equal(createHash('sha256').update(loop.finalResult!).digest('hex'), hash);
    assert.deepEqual(await exportCompletedResult(loop, { async exportMarkdown(input) {
      assert.deepEqual(Buffer.from(input.finalResult), Buffer.from(raw)); return { status: 'saved' };
    } }), { status: 'saved' });
    assert.equal(calls, 1);
  });
}
