// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

export function LocalCollaborationNotice({ model, checked, disabled, onChange }: {
  model?: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void;
}) {
  return <div className="local-collaboration-notice" data-testid="local-collaboration-notice">
    <strong>개인 로컬 개발용 · 실험적 협업</strong>
    <p>Ollama ({model ?? '선택한 모델'}) 초안 → Codex CLI 검토 → Ollama 개선: 총 3회 실행합니다.</p>
    <p>Ollama 로컬 HTTP는 CPU/GPU를 2회 사용합니다. 공식 Codex CLI는 기존 ChatGPT 로그인으로 1회 실행하며 플랜 사용량을 소비할 수 있습니다.</p>
    <p>두 모델의 작성·검토·개선 역할 품질은 미검증입니다. 검토 의견도 틀릴 수 있습니다. Auto 자격은 부여하지 않습니다.</p>
    <p>공개 가능한 텍스트만 입력하세요. 첨부는 지원하지 않으며 재시도·다른 AI 전환·별도 API 과금 전환은 없습니다.</p>
    <label><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /> 이번 실험의 3회 실행과 미검증 역할을 확인했습니다.</label>
  </div>;
}
