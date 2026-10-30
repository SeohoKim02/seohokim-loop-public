// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { ProviderErrorCode } from './provider-error.ts';

export const configurableProviderId = 'openai-compatible';
export const configurableProviderIds = [configurableProviderId, 'anthropic'] as const;
export type ConfigurableProviderId = typeof configurableProviderIds[number];
export function isConfigurableProviderId(id: unknown): id is ConfigurableProviderId {
  return id === configurableProviderId || id === 'anthropic';
}

interface ConfigurationSummary {
  model: string;
  hasApiKey: boolean;
  source: 'saved' | 'environment' | 'none' | 'unavailable';
  hasSavedConfiguration: boolean;
  storageError?: ProviderErrorCode;
}
export type ConnectionConfiguration = ConfigurationSummary & (
  { id: 'openai-compatible'; baseUrl: string } | { id: 'anthropic' }
);

export type SaveConnectionConfiguration = {
  model: string;
  // Write-only. Omitted/empty preserves the current key in main.
  apiKey?: string;
} & ({ providerId: 'openai-compatible'; baseUrl: string } | { providerId: 'anthropic' });

export function configurationErrorMessage(code?: ProviderErrorCode): string {
  switch (code) {
    case 'ENCRYPTION_UNAVAILABLE': return '이 환경에서는 API 키를 안전하게 저장할 수 없습니다.';
    case 'ENCRYPTION_FAILED': return 'API 키를 보호하지 못했습니다. 다시 시도해주세요.';
    case 'STORAGE_READ_FAILED': return '저장된 연결을 읽지 못했습니다. 앱을 다시 시작하거나 연결을 다시 설정해주세요.';
    case 'STORAGE_CORRUPT': return '저장된 연결이 손상되었습니다. 새 키로 다시 저장하거나 연결을 제거해주세요.';
    case 'DECRYPTION_FAILED': return '저장된 키를 열 수 없습니다. 새 키로 다시 저장하거나 연결을 제거해주세요.';
    case 'STORAGE_WRITE_FAILED': return '연결 정보를 저장하지 못했습니다. 저장 공간과 접근 권한을 확인해주세요.';
    case 'STORAGE_REMOVE_FAILED': return '연결 정보를 제거하지 못했습니다. 다시 시도해주세요.';
    case 'CONFIG_INVALID': return '모델과 연결 설정을 확인해주세요. 서버 주소가 필요하면 HTTPS 또는 로컬 HTTP 주소를 사용하세요.';
    case 'KEY_REQUIRED': return '새 연결에는 API 키가 필요합니다.';
    case 'CONFIG_BUSY': return '작업 또는 연결 확인이 끝난 뒤 설정을 변경해주세요.';
    default: return '연결 설정을 처리하지 못했습니다. 다시 시도해주세요.';
  }
}
