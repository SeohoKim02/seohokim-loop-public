// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import type { FormEvent } from 'react';
import { LoopProgress } from './ui/LoopProgress.tsx';
import { useLoop } from './ui/use-loop.ts';
import { Connections } from './ui/Connections.tsx';
import { useConnections } from './ui/use-connections.ts';
import { connectionStatus } from './ui/connection-status.ts';
import { History } from './ui/History.tsx';
import { useHistorySave } from './ui/use-history-save.ts';
import { historySaveMessage } from './application/history-ipc.ts';
import { useAttachments } from './ui/use-attachments.ts';
import { AttachmentPreview } from './ui/AttachmentPreview.tsx';
import { roleEligibility } from './application/role-eligibility.ts';
import { localManualCandidate, manualCollaborationPolicy } from './application/manual-collaboration-policy.ts';
import { LocalCollaborationNotice } from './ui/LocalCollaborationNotice.tsx';

export function App() {
  const [request, setRequest] = useState('');
  const attachments = useAttachments(request);
  const [page, setPage] = useState<'loop' | 'connections' | 'history'>('loop');
  const connections = useConnections();
  const { providers } = connections;
  const { loop, error, isRunning, isCancelling, start, cancel, providerId, setProviderId, reviewerId, setReviewerId, executionMode, setExecutionMode, experimentalConsent, setExperimentalConsent } = useLoop(providers);
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const historySave = useHistorySave(loop);
  const historyNotice = historySave.notice;
  const [replaceUnsavedId, setReplaceUnsavedId] = useState<string>();
  const selectedReviewer = providers.find((provider) => provider.id === reviewerId);
  const collaboration = executionMode === 'collaboration';
  const manualPolicy = manualCollaborationPolicy(selectedProvider, selectedReviewer);
  const automatic = executionMode === 'auto';
  const autoAvailable = providers.some((provider) => provider.type !== 'mock' && roleEligibility(provider, 'planning').eligible);
  const selectionDisabled = isRunning || connections.isLoading || connections.isSaving || providers.length === 0;
  const validSelection = automatic ? autoAvailable : selectedProvider?.configured
    && !(selectedProvider.singleOnly && attachments.files.length)
    && (!collaboration || (manualPolicy.allowed && (!manualPolicy.experimental || experimentalConsent)));

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectionDisabled || attachments.pending() || attachments.inputError || !request.trim() || !validSelection || historySave.startProtection() === 'saving') return;
    if (historySave.startProtection() === 'unsaved') { setReplaceUnsavedId(loop!.id); return; }
    setReplaceUnsavedId(undefined);
    void start(request, attachments.files); attachments.clear();
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
            <rect width="40" height="40" rx="12" fill="currentColor" />
            <path d="M22 12h-5a7 7 0 0 0 0 14h2m-1-12h5a7 7 0 0 1 0 14h-5" stroke="white" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
          <span>SeohoKim <strong>Loop</strong></span>
        </div>
        <span className="version-badge">v0.1 <span aria-hidden="true">·</span> 미리보기</span>
      </header>

      <nav className="app-navigation" aria-label="주 메뉴">
        <button type="button" aria-current={page === 'loop' ? 'page' : undefined} onClick={() => setPage('loop')}>Loop</button>
        <button type="button" aria-current={page === 'connections' ? 'page' : undefined} onClick={() => setPage('connections')}>Connections</button>
        <button type="button" aria-current={page === 'history' ? 'page' : undefined} onClick={() => setPage('history')}>기록</button>
      </nav>

      <main>
        <div hidden={page !== 'loop'}>
        <section className="intro" aria-labelledby="page-title">
          <p className="eyebrow">나의 AI 작업 공간</p>
          <h1 id="page-title">할 일을 적으면, Loop가 이어갑니다.</h1>
          <p>요청부터 최종 정리까지, 여러 AI가 함께할 작업 공간입니다.</p>
        </section>

        <form className="card request-card" onSubmit={handleSubmit}>
          <div className="section-heading">
            <label htmlFor="request">새 작업</label>
            <span className="mode-badge"><span aria-hidden="true" /> {automatic ? '자동' : '직접 선택'}</span>
          </div>
          <textarea
            id="request"
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            placeholder="무엇을 함께 해결할까요?"
            aria-describedby="request-help"
            disabled={isRunning}
            rows={4}
            maxLength={20_000}
          />
          <div className="attachments" data-testid="attachments">
            <button type="button" className="secondary-button" disabled={isRunning || attachments.selecting || attachments.files.length >= 2}
              onClick={() => void attachments.select()}>{attachments.selecting ? '파일 선택 중…' : '파일 첨부'}</button>
            <p>최대 2개 · TXT/MD/CSV/JSON 128KiB · PDF 5MiB/30페이지 · 추출 텍스트 합계 16,000자</p>
            <p>텍스트 PDF만 지원합니다. 이미지·도표는 분석하지 않으며 스캔/OCR·암호화 PDF는 지원하지 않습니다.</p>
            {attachments.selecting && <p role="status">파일 선택 또는 PDF 텍스트 추출 중입니다. 잠시 기다려주세요.</p>}
            <p>첨부된 파일 내용은 작업을 수행하는 연결된 AI에 전송될 수 있습니다. 선택만으로는 전송되지 않습니다.</p>
            <p>실행을 시작하면 첨부 목록은 비워집니다. 파일 원문은 History에 별도로 보관하지 않으며, AI 결과에 인용된 내용은 기록에 포함될 수 있습니다.</p>
            {attachments.files.map((file) => <div className="attachment-row" key={file.id} data-attachment-id={file.id}>
              <span>{file.name} · {file.type.toUpperCase()} · {file.text.length.toLocaleString()}자 · {file.size.toLocaleString()}바이트{file.type === 'pdf' && ' · 텍스트 준비 완료'}</span>
              <div className="attachment-actions">
                <button className="secondary-button" type="button" disabled={isRunning || attachments.selecting}
                  onClick={() => attachments.openPreview(file.id)} aria-label={`${file.name} 내용 보기`}
                  aria-expanded={attachments.preview?.id === file.id} aria-controls={attachments.preview?.id === file.id ? 'attachment-preview' : undefined}>내용 보기</button>
                <button className="secondary-button" type="button" disabled={isRunning || attachments.selecting} onClick={() => attachments.remove(file.id)} aria-label={`${file.name} 첨부 제거`}>첨부 제거</button>
              </div>
            </div>)}
            {attachments.preview && <AttachmentPreview key={attachments.preview.id} file={attachments.preview} onClose={attachments.closePreview} />}
            {(attachments.error || attachments.inputError) && <p role="alert" className="error-message">{attachments.inputError ?? attachments.error}</p>}
          </div>
          <div className="provider-choice">
            <label htmlFor="execution-mode">실행 방식</label>
            <select id="execution-mode" value={executionMode} disabled={selectionDisabled}
              onChange={(event) => setExecutionMode(event.target.value as 'auto' | 'single' | 'collaboration')}>
              <option value="auto">자동</option>
              <option value="single">단일 AI</option>
              <option value="collaboration">직접 협업</option>
            </select>
          </div>
          {!automatic && <div className="provider-choice">
            <label htmlFor="provider">{collaboration ? '작업 AI' : '사용할 AI'}</label>
            <select id="provider" value={providerId} onChange={(event) => setProviderId(event.target.value)}
              disabled={selectionDisabled} aria-describedby="request-help">
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id} disabled={!provider.configured || (collaboration && provider.singleOnly && !localManualCandidate(provider, 'primary'))}>
                  {provider.displayName}{provider.type === 'mock' ? ' · 테스트용' : ''}{provider.configured ? '' : ` · ${connectionStatus(provider).detail}`}
                </option>
              ))}
            </select>
          </div>}
          {collaboration && <div className="provider-choice">
            <label htmlFor="reviewer">검토 AI</label>
            <select id="reviewer" value={reviewerId} onChange={(event) => setReviewerId(event.target.value)}
              disabled={selectionDisabled} aria-describedby="request-help">
              <option value="">검토할 AI를 선택하세요</option>
              {providers.map((provider) => <option key={provider.id} value={provider.id} disabled={!provider.configured || (provider.singleOnly && !localManualCandidate(provider, 'reviewer')) || provider.id === providerId}>
                {provider.displayName}{provider.type === 'mock' ? ' · 테스트용' : ''}
                {!provider.configured ? ` · ${connectionStatus(provider).detail}` : provider.id === providerId ? ' · 작업 AI와 동일' : ''}
              </option>)}
            </select>
          </div>}
          {collaboration && manualPolicy.experimental && <LocalCollaborationNotice model={selectedProvider?.ollama?.selectedModel}
            checked={experimentalConsent} disabled={selectionDisabled} onChange={setExperimentalConsent} />}
          <div className="request-footer">
            <p id="request-help">{connections.error ? 'Connections에서 AI 연결 상태를 다시 확인해주세요.'
              : automatic ? autoAvailable ? <>연결된 AI가 계획을 만들고 필요한 작업을 순서대로 진행합니다.<br />오류 시 제한된 재시도나 다른 AI 전환을 포함해 최대 9회 요청하며, 추가 API 요금이 발생할 수 있습니다.</>
                : <>먼저 사용할 AI를 연결해주세요. <button type="button" onClick={() => setPage('connections')}>AI 연결하기</button></>
              : collaboration && manualPolicy.experimental ? '선택한 로컬 연결만 사용합니다. 최종 결과는 마지막 개선이 정상 완료된 경우에만 생성됩니다.'
              : collaboration ? <>작업 AI가 초안을 만들고 검토 AI의 의견을 받아 한 번 개선합니다.<br />
                서로 다른 AI를 선택하세요. 두 실제 AI를 사용하면 총 3회 요청하며 사용 요금이 발생할 수 있습니다.
                {(selectedProvider?.type === 'mock' || selectedReviewer?.type === 'mock') && <><br />Mock AI는 테스트용 예시 결과를 만듭니다.</>}</>
              : !selectedProvider ? 'AI 연결 상태를 확인하고 있습니다.' : selectedProvider.type === 'mock'
                ? <><strong>Mock AI</strong>로 5단계 예시를 체험합니다.<br />Connections에서 사용할 AI를 확인하세요.</>
                : selectedProvider.type === 'local-ollama'
                  ? <>선택한 Ollama 모델을 내 PC에서 실행합니다. 별도 API 요금은 없으며 PC 자원과 전력을 사용합니다.<br />텍스트 요청만 지원합니다. 첨부는 제거해주세요. Cloud 모델과 다른 Provider로 자동 전환하지 않습니다.</>
                : selectedProvider.type === 'local-cli'
                  ? <>개인 로컬 개발용 Codex를 한 번 실행합니다. Start Loop를 누르면 ChatGPT 플랜 사용량을 소비할 수 있습니다.<br />공개 가능한 텍스트만 입력하세요. 첨부는 제거해주세요. API 과금으로 자동 전환하지 않습니다.</>
                  : <>선택한 AI로 초안을 생성합니다.<br />요청을 외부 API에 한 번 전송하며 사용 요금이 발생할 수 있습니다.</>}</p>
            <div className="execution-actions">
            <button className="primary-button" type="submit" disabled={selectionDisabled || attachments.selecting || !!attachments.inputError || historySave.saving || !request.trim() || !validSelection}>
              {isRunning ? 'Loop 진행 중' : 'Start Loop'}
              {isRunning ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">→</span>}
            </button>
            {isRunning && <button className="stop-button" type="button" disabled={isCancelling} onClick={cancel}>
              {isCancelling ? '중지 중…' : '작업 중지'}
            </button>}
            </div>
          </div>
          {error && <p className="error-message" role="alert">{error}</p>}
          {connections.error && <p className="error-message" role="alert">{connections.error}</p>}
          {replaceUnsavedId === loop?.id && historyNotice?.phase === 'failed' && <div className="history-confirm" data-testid="unsaved-confirm">
            <p role="alert">이전 결과가 아직 기록에 저장되지 않았습니다. 다시 저장하거나 Markdown으로 보관해주세요. 새 작업을 시작하면 이전 결과를 이 화면에서 다시 저장할 수 없습니다.</p>
            <div className="connection-actions">
              <button className="secondary-button" type="button" onClick={() => setReplaceUnsavedId(undefined)}>이전 결과 유지</button>
              <button className="secondary-button" type="button" disabled={selectionDisabled || attachments.selecting || !!attachments.inputError || !request.trim() || !validSelection} onClick={() => {
                if (selectionDisabled || attachments.pending() || attachments.inputError || !request.trim() || !validSelection || replaceUnsavedId !== loop?.id
                  || historySave.startProtection() !== 'unsaved') return;
                setReplaceUnsavedId(undefined); void start(request, attachments.files); attachments.clear();
              }}>저장하지 않고 새 작업 시작</button>
            </div>
          </div>}
        </form>

        {historyNotice && <div className="history-save" data-testid="history-save" data-phase={historyNotice.phase}>
          <p className={historyNotice.phase === 'failed' ? 'error-message' : 'history-save-notice'} role={historyNotice.phase === 'failed' ? 'alert' : 'status'}>{historyNotice.message}</p>
          {historyNotice.phase === 'failed' && <>
            {historyNotice.message !== historySaveMessage(historyNotice.code) && <p className="history-save-help">{historySaveMessage(historyNotice.code)}</p>}
            <p className="history-save-help">저장되지 않은 결과는 앱 종료 후 복원을 보장할 수 없습니다. 다시 저장하거나 최종 결과를 Markdown으로 보관해주세요.</p>
          </>}
          {(historyNotice.phase === 'failed' || historyNotice.phase === 'resaving') && <button className="secondary-button" type="button"
            disabled={historyNotice.phase === 'resaving'} onClick={() => { setReplaceUnsavedId(undefined); historySave.retry(); }}>
            {historyNotice.phase === 'resaving' ? '재저장 중…' : '다시 저장'}
          </button>}
        </div>}
        {loop ? <LoopProgress loop={loop} allowLengthDiagnostics={!isRunning} /> : (
          <section className="empty-state" aria-labelledby="empty-title">
            <span className="empty-mark" aria-hidden="true">↗</span>
            <div>
              <h2 id="empty-title">첫 번째 Loop를 시작해보세요</h2>
              <p>조사, 글쓰기, 아이디어, 코딩까지. 원하는 작업을 자유롭게 적어주세요.</p>
            </div>
          </section>
        )}
        </div>
        {page === 'connections' && <Connections {...connections} isLoopRunning={isRunning} />}
        {page === 'history' && <History />}
      </main>
      <footer className="app-footer">하나의 요청, 차근차근 완성되는 결과.</footer>
    </div>
  );
}
