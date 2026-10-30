// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { toProviderFailure } from './provider-error.ts';

const reasons = {
  configuration_required: '연결 설정을 먼저 확인해주세요.',
  authentication_failed: '인증 정보를 확인해주세요.',
  unreachable: '서버에 연결할 수 없습니다. 네트워크와 서버 주소를 확인해주세요.',
  server_error: '서버 응답에 오류가 있습니다. 서버 상태와 모델 설정을 확인해주세요.',
  unsupported_response: '지원하지 않는 응답입니다. 서버의 API 호환 여부를 확인해주세요.',
  unsupported: '이 AI는 외부 연결 확인을 지원하지 않습니다.',
  busy: '이미 연결을 확인하고 있습니다. 잠시 기다려주세요.',
  unavailable: '연결 확인을 사용할 수 없습니다. 목록을 새로고침하거나 앱을 다시 시작해주세요.',
  unknown_error: '연결 확인 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
} as const;

export type ConnectionCheckResult =
  | { ok: true; checkedAt: string }
  | { ok: false; checkedAt: string; code: keyof typeof reasons; reason: string };

// Whitelisted public result only: no remote body, model output, URL or exception text.
export function connectionCheckFailure(cause: unknown): ConnectionCheckResult {
  const failure = toProviderFailure(cause);
  let code: keyof typeof reasons;
  switch (failure.code) {
    case 'CONFIG_MISSING': case 'API_KEY_MISSING': case 'INVALID_BASE_URL':
      code = 'configuration_required'; break;
    case 'HTTP_ERROR':
      code = failure.httpStatus === 401 || failure.httpStatus === 403 ? 'authentication_failed' : 'server_error'; break;
    case 'NETWORK_ERROR': case 'TIMEOUT': code = 'unreachable'; break;
    case 'RESPONSE_PARSE_ERROR': code = 'unsupported_response'; break;
    case 'CHECK_UNSUPPORTED': code = 'unsupported'; break;
    case 'BUSY': code = 'busy'; break;
    case 'PROVIDER_NOT_FOUND': case 'INVALID_REQUEST': case 'IPC_FORBIDDEN': case 'IPC_UNAVAILABLE':
      code = 'unavailable'; break;
    default: code = 'unknown_error';
  }
  return { ok: false, checkedAt: new Date().toISOString(), code, reason: reasons[code] };
}
