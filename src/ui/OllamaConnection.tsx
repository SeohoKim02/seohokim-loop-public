// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import type { ProviderConnection } from '../providers/provider-registry.ts';
import { ProviderError } from '../providers/provider-error.ts';
import { modelRoles } from '../providers/model-capability.ts';
import { modelQualityState } from '../application/model-quality.ts';

const labels = { not_installed: '설치 확인 필요', stopped: '서버 중지', no_models: '모델 없음', select_model: '모델 선택 필요', ready: '사용 가능', failed: '확인 실패' };

export function OllamaConnection({ provider, disabled, refresh }: { provider: ProviderConnection; disabled: boolean; refresh(): Promise<void> }) {
  const status = provider.ollama;
  const metadata = status?.modelMetadata?.find((entry) => entry.identity.modelId === status.selectedModel);
  const roleNames = { planning: '계획', analyze: '분석·정보 정리', write: '작성', review: '검토', improve: '개선', deliver: '최종 통합' };
  const verified = modelRoles.filter((role) => modelQualityState(provider.modelPolicy?.model, role, provider.modelPolicy?.evaluations ?? []) === 'verified');
  const [model, setModel] = useState(status?.selectedModel ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => setModel(status?.selectedModel ?? ''), [status?.selectedModel]);
  async function save() {
    if (saving || disabled || !status?.models.includes(model)) return;
    setSaving(true); setError(undefined);
    try {
      if (!window.seohoKimLoop) throw new Error();
      const result = await window.seohoKimLoop.selectOllamaModel(model);
      if (!result.ok) setError(result.error.message);
      await refresh();
    } catch { setError('로컬 모델 선택을 저장하지 못했습니다. 연결을 다시 확인해주세요.'); }
    finally { setSaving(false); }
  }
  return <article className="card connection-card" aria-label={provider.displayName} data-testid="connection-card"
    data-provider-id={provider.id} data-state={status?.state ?? 'stopped'}>
    <div className="connection-heading">
      <div><p className="connection-kind">내 PC에서 실행 · {provider.experimentalManual ? 'Single AI / 실험적 초안·개선' : 'Single AI 전용'}</p><h2>{provider.displayName}</h2></div>
      <span className={`connection-status connection-${provider.configured ? 'ready' : 'unavailable'}`}>{labels[status?.state ?? 'stopped']}</span>
    </div>
    <p className="connection-description">설치된 로컬 텍스트 모델만 사용합니다. API 키나 별도 API 요금 없이 PC의 CPU/GPU·메모리·전력을 사용합니다.</p>
    <p className="connection-detail">Cloud 모델과 외부 서버는 연결하지 않습니다. 모델별 성능과 라이선스는 다릅니다.</p>
    <p>{status?.installed ? '기본 경로에서 Ollama 설치 파일 확인됨' : '기본 경로의 설치 파일은 확인되지 않았습니다.'}</p>
    {status?.version && <p>로컬 API 버전: {status.version}</p>}
    <div data-testid="local-model-qualification">
      <p>실행: {provider.configured ? '사용 가능 · Single AI' : '연결 및 모델 확인 필요'}</p>
      {metadata && <p>모델 사양: {[metadata.parameterSize, metadata.quantization, metadata.format].filter(Boolean).join(' · ')}</p>}
      <p>Auto 참여: {verified.length ? '현재 Single AI 전용' : '추가 검증 필요'}</p>
      <p>검증된 Auto 역할: {verified.length ? verified.map((role) => roleNames[role]).join(', ') : '아직 없음'}</p>
      <p className="connection-check-note">모델 실행 가능 여부와 역할별 답변 품질은 별개입니다. Auto 검증 여부와 관계없이 Single AI를 사용할 수 있습니다.</p>
    </div>
    {provider.unavailableReason && <p role="status">{new ProviderError(provider.unavailableReason).message}</p>}
    <div className="connection-settings">
      <label htmlFor="ollama-model">사용할 로컬 모델</label>
      <select id="ollama-model" value={status?.models.includes(model) ? model : ''} onChange={(event) => setModel(event.target.value)} disabled={disabled || saving || !status?.models.length}>
        <option value="">모델을 선택하세요</option>
        {status?.models.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <p className="connection-check-note">현재 선택: {status?.selectedModel ?? '없음'}</p>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="connection-actions">
        <button type="button" className="secondary-button" disabled={disabled || saving || !status?.models.includes(model)} onClick={() => void save()}>{saving ? '저장 중…' : '모델 선택 저장'}</button>
        <button type="button" className="secondary-button" disabled={disabled || saving} onClick={() => void refresh()}>연결 확인</button>
      </div>
    </div>
    <p className="connection-check-note">연결 확인은 서버와 설치 모델만 조회합니다. AI 생성이나 모델 다운로드를 실행하지 않습니다.</p>
    <p className="connection-check-note">Ollama 설치·모델 준비 방법은 README를 참고하세요. 이번 버전은 첨부 없는 단일 AI 텍스트 실행을 지원합니다.</p>
    {provider.experimentalManual && <p className="connection-check-note">개발용 직접 협업에서 Codex CLI 검토와 함께 초안·개선을 명시적으로 선택할 수 있습니다. 역할 품질은 미검증이며 Auto 자격은 변경되지 않습니다.</p>}
  </article>;
}
