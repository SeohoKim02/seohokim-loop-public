// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { useLanguage } from '../i18n/react.tsx';
import type { ProviderConnection } from '../providers/provider-registry.ts';
import { localCliLabels } from './connection-status.ts';
import { ProviderError } from '../providers/provider-error.ts';

export function LocalCliConnection({ provider }: { provider: ProviderConnection }) {
  const { t, message, locale } = useLanguage();
  const local = provider.localCli;
  return <article className="card connection-card" aria-label={provider.displayName}
    data-testid="connection-card" data-provider-id={provider.id} data-state={local?.state ?? 'disabled'}>
    <p role="status">{t("이 공개 Preview에서는 Codex CLI가 비활성화되어 있습니다. 환경 변수로 활성화되지 않습니다.")}</p>
    <div className="connection-heading">
      <div><p className="connection-kind">{t("개인 로컬 개발용 ·")}{' '}{provider.experimentalManual ? t("Single AI / 실험적 검토") : t("Single AI 전용")}</p><h2>{provider.displayName}</h2></div>
      <span className={`connection-status connection-${provider.configured ? 'ready' : 'unavailable'}`}>
        {message(localCliLabels[local?.state ?? 'disabled'])}
      </span>
    </div>
    <p className="connection-description">{t("설치된 공식 Codex CLI를 사용합니다. ChatGPT 로그인 기반이며 플랜 사용량과 이용 한도가 적용됩니다.")}</p>
    <p className="connection-detail">{t("별도 API 키 연결과 다릅니다. API 과금 방식으로 자동 전환하지 않으며, 상용 배포용 연결은 비활성입니다.")}</p>
    {local?.version && <p>{t("CLI 버전:")}{' '}{local.version}</p>}
    {provider.unavailableReason && <p role="status">{message(new ProviderError(provider.unavailableReason).message)}</p>}
    <p>{t("공개 Preview에서는 Codex 설치·로그인 상태를 조회하거나 Codex를 실행하지 않습니다.")}</p>
    {local?.checkedAt && <p className="connection-checked-at">{t("마지막 로컬 확인:")}{' '}{new Date(local.checkedAt).toLocaleString(locale === 'en' ? 'en-US' : 'ko-KR')}</p>}
    <p>{provider.configured ? t("ChatGPT 로그인 확인됨 · 단일 AI에서 명시적으로 실행할 수 있습니다. 모델 접근과 실제 실행 성공은 아직 별도 확인이 필요합니다.")
      : t("CLI 어댑터의 자동 테스트는 합성 응답만 사용합니다. 공개판에서 로그인하거나 연결할 필요가 없습니다.")}</p>
    <p>{t("읽기 전용 임시 작업공간에서 텍스트만 처리합니다. 완전한 파일 읽기 격리를 보장하지 않으므로 민감한 자료는 입력하지 마세요.")}{' '}{provider.experimentalManual
      ? t("첨부·Auto는 지원하지 않습니다. 개발용 직접 협업에서는 Ollama 초안의 검토만 명시적으로 선택할 수 있습니다. 역할 품질은 미검증입니다.")
      : t("첨부·Auto·직접 협업은 지원하지 않습니다.")}</p>
    <p role="status">{t("마지막 실행:")}{' '}{local?.lastExecution === 'completed' ? t("완료") : local?.lastExecution === 'failed' ? t("실패")
      : local?.lastExecution === 'cancelled' ? t("중지") : t("미검증 (모델 호출 없음)")}</p>
  </article>;
}
