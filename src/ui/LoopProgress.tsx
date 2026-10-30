// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { AutoRole, CollaborationRole, Loop, LoopStatus } from '../domain/loop.ts';
import { ResultExport } from './ResultExport.tsx';
import { OutputLengthDiagnostics } from './OutputLengthDiagnostics.tsx';
import { canDiagnoseLength } from '../application/output-length-diagnostics.ts';

const roleLabels: Record<AutoRole | CollaborationRole, string> = {
  primary: '작업 AI', reviewer: '검토 AI', analyze: '분석', write: '작성', review: '검토', improve: '개선', deliver: '최종 정리',
};

const statusLabels: Record<LoopStatus, string> = {
  pending: '대기 중',
  running: '진행 중',
  completed: '완료',
  failed: '실패',
  cancelled: '중지됨',
};

const formatTime = (iso: string): string => new Date(iso).toLocaleTimeString('ko-KR', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

export function LoopProgress({ loop, idPrefix = '', allowLengthDiagnostics = false }: { loop: Loop; idPrefix?: string; allowLengthDiagnostics?: boolean }) {
  const completed = loop.steps.filter((step) => step.status === 'completed').length;
  const activeStep = loop.steps.find((step) => step.status === 'running');
  const activeSteps = loop.steps.filter((step) => step.status === 'running');
  const planning = !!loop.auto && loop.auto.phase !== 'executing';
  const planningMessage = loop.auto?.phase === 'recovering' ? '작업 계획을 다시 정리하고 있습니다.' : '작업 계획 준비';
  const announcement = loop.status === 'completed' ? 'Loop 완료. 최종 결과가 준비되었습니다.'
    : loop.status === 'cancelled' ? '작업이 중지되었습니다.'
    : loop.status === 'failed' ? 'Loop 실패. 오류 내용을 확인해주세요.'
      : planning ? planningMessage : activeSteps.length > 1 ? `${activeSteps.map((step) => step.title).join(', ')} 진행 중`
        : activeStep ? `${activeStep.title} ${activeStep.fallbackCount ? '다른 AI가 이어가는 중' : activeStep.retryPending || activeStep.retryCount ? '다시 시도하는 중' : '진행 중'}` : 'Loop를 준비하고 있습니다.';

  return (
    <div className="work-grid">
      <section className="card progress-card" aria-labelledby={`${idPrefix}progress-title`} data-testid="loop" data-status={loop.status}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">CURRENT LOOP</p>
            <h2 id={`${idPrefix}progress-title`}>작업 진행</h2>
          </div>
          <span className={`status status-${loop.status}`} data-testid="loop-status">{statusLabels[loop.status]}</span>
        </div>
        <p className="request-preview" data-testid="loop-request">{loop.userRequest}</p>
        {loop.auto && <p className="provider-name" data-testid="auto-plan">
          {planning ? loop.status !== 'running' ? '작업 계획 중단' : planningMessage : loop.auto.title}
          {loop.auto.planner && ` · 계획 AI: ${loop.auto.planner.displayName}`}
        </p>}
        <div className="progress-meta">
          <span>{loop.startedAt ? `${formatTime(loop.startedAt)} 시작` : '시작 준비 중'}</span>
          <span>{planning ? loop.status === 'running' ? '단계 구성 중' : '실행된 단계 없음' : `${completed} / ${loop.steps.length} 단계 완료`}</span>
        </div>
        <progress aria-label="Loop 진행률" max={loop.steps.length || 1}
          value={planning && loop.status === 'running' ? undefined : completed} />
        <p className="sr-only" role="status">{announcement}</p>
        <ol className="step-list" aria-label="작업 단계">
          {loop.steps.map((step, index) => (
            <li className={`step step-${step.status}`} key={step.id} data-testid="step" data-status={step.status}
              data-provider-id={step.assignedProvider.id} data-role={step.role} data-retry-count={step.retryCount} data-retry-pending={!!step.retryPending}
              data-fallback-count={step.fallbackCount ?? 0}>
              <span className="step-number" aria-hidden="true">
                {step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : step.status === 'cancelled' ? '−' : index + 1}
              </span>
              <div className="step-content">
                <div className="step-heading">
                  <h3>{step.title}</h3>
                  <span className={`step-state text-${step.status}`}>{loop.status === 'cancelled' && step.status === 'pending' ? '실행되지 않음' : statusLabels[step.status]}</span>
                </div>
                <p className="provider-name">{step.role && `${roleLabels[step.role]} · `}{step.assignedProvider.displayName}</p>
                {step.originalProvider && <p className="provider-name" data-testid="provider-change">
                  {step.originalProvider.displayName}에서 {step.assignedProvider.displayName}로 변경됨
                </p>}
                {step.status === 'running' && step.fallbackCount === 1
                  && <p className="provider-name" data-testid="step-fallback">다른 AI로 작업을 이어가고 있습니다.</p>}
                {step.status === 'running' && !step.fallbackCount && (step.retryPending || step.retryCount > 0)
                  && <p className="provider-name" data-testid="step-retry">일시적인 오류가 발생해 다시 시도하고 있습니다.</p>}
                {step.startedAt && <p className="step-time">{formatTime(step.startedAt)} 시작{step.completedAt && ` · ${formatTime(step.completedAt)} 종료`}</p>}
                {step.status === 'completed' && (step.retryCount > 0 || !!step.fallbackCount) && <p className="provider-name">재시도 {step.retryCount}회 · 다른 AI 전환 {step.fallbackCount ?? 0}회</p>}
                {step.output && (
                  <details>
                    <summary>단계 결과 보기</summary>
                    <p className="step-output">{step.output}</p>
                  </details>
                )}
                {step.error && <p className="step-error">{step.error}</p>}
              </div>
            </li>
          ))}
        </ol>
        {loop.status === 'failed' && (
          <p className="error-message" role="alert">작업을 완료하지 못했습니다. {loop.error} 입력 내용을 확인하고 새 Loop를 시작해주세요.</p>
        )}
        {loop.status === 'cancelled' && <p className="cancellation-message">작업이 중지되었습니다. 완료된 결과는 단계 기록에서 확인할 수 있습니다.</p>}
      </section>

      <section className="card result-card" aria-labelledby={`${idPrefix}result-title`}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">FINAL RESULT</p>
            <h2 id={`${idPrefix}result-title`}>최종 결과</h2>
          </div>
          {loop.status === 'completed' && <span className="result-check" aria-label="결과 준비 완료">✓</span>}
        </div>
        <ResultExport loop={loop} />
        {loop.status === 'completed' && loop.finalResult ? (
          <>
            <span className="demo-tag">{loop.steps.at(-1)?.assignedProvider.id === 'mock'
              ? 'Mock AI · 예시 결과' : `${loop.steps.at(-1)?.assignedProvider.displayName} · 생성 결과`}</span>
            <p className="final-output" data-testid="final-result">{loop.finalResult}</p>
            {allowLengthDiagnostics && canDiagnoseLength(loop) && <OutputLengthDiagnostics key={loop.id} loop={loop} />}
            {loop.completedAt && <p className="result-time">{formatTime(loop.completedAt)} 완료</p>}
          </>
        ) : (
          <div className="result-placeholder">
            <span className="result-placeholder-icon" aria-hidden="true">{loop.status === 'failed' ? '!' : '…'}</span>
            <h3>{loop.status === 'cancelled' ? '작업이 중지되었습니다' : loop.status === 'failed' ? '결과를 만들지 못했습니다' : '결과가 모이는 곳'}</h3>
            <p>{loop.status === 'cancelled' ? '완성된 최종 결과는 없습니다. 새 Loop를 시작할 수 있습니다.' : loop.status === 'failed' ? '작업 진행 카드에서 실패한 단계를 확인할 수 있습니다.' : '모든 단계가 끝나면 이곳에서\n최종 결과를 확인할 수 있습니다.'}</p>
          </div>
        )}
      </section>
    </div>
  );
}
