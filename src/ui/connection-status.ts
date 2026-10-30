// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { ProviderConnection } from '../providers/provider-registry.ts';
import type { LocalCliState } from '../providers/local-cli.ts';

export const localCliLabels: Record<LocalCliState, string> = {
  disabled: '개발용 연결 꺼짐', not_installed: 'CLI 미설치', installed: 'CLI 설치됨',
  login_required: 'ChatGPT 로그인 필요', authenticated: '로그인 확인됨', ready: '로그인 확인 · 실행 가능',
  running: '실행 중', usage_limit: '사용량 제한', failed: '실행/확인 실패', unsupported: '지원하지 않는 버전',
};

export interface ConnectionStatus {
  state: 'ready' | 'needs_configuration' | 'unavailable';
  label: string;
  detail: string;
}

// Presentation only: the main process's configured flag remains the source of truth.
// A complete configuration does not prove that the remote server or key works.
export function connectionStatus(connection: ProviderConnection): ConnectionStatus {
  if (connection.localCli) return { state: connection.configured ? 'ready' : 'unavailable',
    label: localCliLabels[connection.localCli.state], detail: localCliLabels[connection.localCli.state] };
  if (connection.configured) {
    return {
      state: 'ready',
      label: connection.type === 'mock' ? '사용 가능' : '설정 완료',
      detail: connection.type === 'mock'
        ? '인터넷 연결 없이 작업 흐름을 체험할 수 있습니다.'
        : 'Loop에서 선택할 수 있습니다. 설정 완료는 실제 연결 성공을 뜻하지 않습니다.',
    };
  }

  switch (connection.unavailableReason) {
    case 'CONFIG_MISSING':
      return { state: 'needs_configuration', label: '설정 필요', detail: 'AI 연결 설정이 필요합니다.' };
    case 'API_KEY_MISSING':
      return { state: 'needs_configuration', label: '설정 필요', detail: 'API 키 설정이 필요합니다.' };
    case 'INVALID_BASE_URL':
      return { state: 'needs_configuration', label: '설정 필요', detail: '서버 주소 설정을 확인해주세요.' };
    default:
      return { state: 'unavailable', label: '사용할 수 없음', detail: '연결 설정을 확인한 뒤 앱을 다시 시작해주세요.' };
  }
}
