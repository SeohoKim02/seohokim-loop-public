// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { Fragment, useState } from 'react';
import type { Loop } from '../domain/loop.ts';
import { canDiagnoseLength, diagnoseOutputLength, getLengthDiagnosticGuidance, inspectLengthConstraintSources, splitLengthConstraintSource } from '../application/output-length-diagnostics.ts';
import type { LengthDiagnostic, LengthGuidance, LengthSourceInspection, LengthConstraintSource } from '../application/output-length-diagnostics.ts';

const sourceLabels: Record<LengthConstraintSource['kind'], string> = { minimum: '최소 조건', maximum: '최대 조건', range: '범위 조건', exact: '정확한 글자 수' };

export function OutputLengthDiagnostics({ loop }: { loop: Loop }) {
  const [checked, setChecked] = useState<{ request: string; output: string; result: LengthDiagnostic; guidance?: LengthGuidance; sources: LengthSourceInspection }>();
  if (!canDiagnoseLength(loop)) return null;
  const result = checked?.request === loop.userRequest && checked.output === loop.finalResult ? checked.result : undefined;
  return <div className="length-diagnostics" data-testid="length-diagnostics">
    <button type="button" className="secondary-button" onClick={() => {
      const result = diagnoseOutputLength(loop);
      setChecked({ request: loop.userRequest, output: loop.finalResult!, result,
        guidance: getLengthDiagnosticGuidance(loop.userRequest, result), sources: inspectLengthConstraintSources(loop.userRequest) });
    }}>분량 확인</button>
    {result && <div role="status" data-testid="length-result" data-verdict={result.available ? result.verdict : 'unavailable'}>
      {result.available ? <>
        <p>요청한 분량: {result.condition.label}</p>
        <p>실제 결과: {result.actual}자</p>
        <p>{result.verdict === 'under' ? `최소 기준보다 ${result.difference}자 부족합니다.`
          : result.verdict === 'over' ? `최대 기준보다 ${result.difference}자 초과합니다.` : '분량 조건 충족'}</p>
      </> : <>
        <p data-testid="length-guidance">{checked?.guidance?.message}</p>
        {checked?.guidance?.help && <p className="length-note" data-testid="length-guidance-help">{checked.guidance.help}</p>}
      </>}
      {!!checked?.sources.conditions.length && <details className="length-source" data-testid="length-source">
        <summary>인식한 원문 보기</summary>
        <p className="length-note">이번 분량 검사에서 인식한 조건을 강조했습니다. 원래 요청은 변경하지 않습니다.</p>
        <div className="length-source-text" data-testid="length-source-text" tabIndex={0} aria-label="인식한 분량 조건을 강조한 원래 요청">
          {splitLengthConstraintSource(checked.request, checked.sources.conditions).map((part, index) => part.source
            ? <mark key={index} data-kind={part.source.kind} title={sourceLabels[part.source.kind]} aria-label={`${sourceLabels[part.source.kind]}: ${part.text}`}>{part.text}</mark>
            : <Fragment key={index}>{part.text}</Fragment>)}
        </div>
      </details>}
      <p className="length-note">원본과 실행 상태는 유지됩니다. AI 추가 호출 없이 이 화면에서만 확인합니다.</p>
      <details><summary>글자 수 계산 기준</summary>
        <p>Unicode 코드포인트 기준입니다. CRLF는 줄바꿈 하나로 계산하며 앞뒤 공백은 제외합니다.
          내부 공백·줄바꿈·Markdown 문자는 포함합니다. 분량 충족은 글의 품질 승인을 뜻하지 않습니다.</p>
      </details>
    </div>}
  </div>;
}
