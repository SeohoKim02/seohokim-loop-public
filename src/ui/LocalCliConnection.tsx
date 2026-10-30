// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { ProviderConnection } from '../providers/provider-registry.ts';
import { localCliLabels } from './connection-status.ts';
import { ProviderError } from '../providers/provider-error.ts';

export function LocalCliConnection({ provider }: { provider: ProviderConnection }) {
  const local = provider.localCli;
  return <article className="card connection-card" aria-label={provider.displayName}
    data-testid="connection-card" data-provider-id={provider.id} data-state={local?.state ?? 'disabled'}>
    <div className="connection-heading">
      <div><p className="connection-kind">개인 로컬 개발용 · {provider.experimentalManual ? 'Single AI / 실험적 검토' : 'Single AI 전용'}</p><h2>{provider.displayName}</h2></div>
      <span className={`connection-status connection-${provider.configured ? 'ready' : 'unavailable'}`}>
        {localCliLabels[local?.state ?? 'disabled']}
      </span>
    </div>
    <p className="connection-description">설치된 공식 Codex CLI를 사용합니다. ChatGPT 로그인 기반이며 플랜 사용량과 이용 한도가 적용됩니다.</p>
    <p className="connection-detail">별도 API 키 연결과 다릅니다. API 과금 방식으로 자동 전환하지 않으며, 상용 배포용 연결은 비활성입니다.</p>
    {local?.version && <p>CLI 버전: {local.version}</p>}
    {provider.unavailableReason && <p role="status">{new ProviderError(provider.unavailableReason).message}</p>}
    <p>설치·로그인 확인은 AI 요청을 보내지 않습니다. 새로고침으로 다시 확인할 수 있습니다.</p>
    {local?.checkedAt && <p className="connection-checked-at">마지막 로컬 확인: {new Date(local.checkedAt).toLocaleString('ko-KR')}</p>}
    <p>{provider.configured ? 'ChatGPT 로그인 확인됨 · 단일 AI에서 명시적으로 실행할 수 있습니다. 모델 접근과 실제 실행 성공은 아직 별도 확인이 필요합니다.'
      : '설치·로그인·개발용 활성화 방법은 README를 참고하세요. 로그인은 공식 CLI에서 직접 진행합니다.'}</p>
    <p>읽기 전용 임시 작업공간에서 텍스트만 처리합니다. 완전한 파일 읽기 격리를 보장하지 않으므로 민감한 자료는 입력하지 마세요. {provider.experimentalManual
      ? '첨부·Auto는 지원하지 않습니다. 개발용 직접 협업에서는 Ollama 초안의 검토만 명시적으로 선택할 수 있습니다. 역할 품질은 미검증입니다.'
      : '첨부·Auto·직접 협업은 지원하지 않습니다.'}</p>
    <p role="status">마지막 실행: {local?.lastExecution === 'completed' ? '완료' : local?.lastExecution === 'failed' ? '실패'
      : local?.lastExecution === 'cancelled' ? '중지' : '미검증 (모델 호출 없음)'}</p>
  </article>;
}
