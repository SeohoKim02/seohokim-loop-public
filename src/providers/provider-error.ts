// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

const messages = {
  OLLAMA_NOT_INSTALLED: 'Ollama 설치 또는 로컬 서버를 찾지 못했습니다. 공식 Windows 설치 방법을 확인해주세요.',
  OLLAMA_STOPPED: 'Ollama 로컬 서버가 응답하지 않습니다. Ollama를 실행한 뒤 다시 확인해주세요.',
  OLLAMA_NO_MODELS: '사용 가능한 로컬 텍스트 모델이 없습니다. Cloud 모델은 지원하지 않습니다.',
  OLLAMA_MODEL_REQUIRED: '조회된 로컬 모델 중 사용할 모델을 선택해주세요. 삭제되거나 변경된 모델은 다시 확인해야 합니다.',
  OLLAMA_OUTPUT_LIMIT: 'Ollama 응답 크기 제한을 초과했습니다. 잘린 결과는 사용하지 않습니다.',
  CLI_DISABLED: 'Codex CLI는 개인 로컬 개발용으로만 활성화할 수 있습니다.',
  CLI_NOT_INSTALLED: '지원하는 공식 Codex CLI 설치를 찾지 못했습니다.',
  CLI_UNTRUSTED: 'Codex CLI 파일 또는 공식 서명을 확인하지 못했습니다.',
  CLI_UNSUPPORTED: '지원하지 않는 Codex CLI 버전 또는 실행 옵션입니다.',
  CLI_CONFIG_INVALID: 'Codex 설정을 확인할 수 없습니다.',
  CLI_OPTIONS_INVALID: '현재 Codex CLI에서 실행 옵션을 사용할 수 없습니다.',
  CLI_LOGIN_REQUIRED: '공식 Codex CLI에서 ChatGPT 로그인이 필요합니다.',
  CLI_AUTH_FAILED: 'Codex ChatGPT 인증 상태를 확인하지 못했습니다.',
  CLI_API_AUTH: '이 연결은 ChatGPT 로그인만 지원합니다. API 키 로그인은 사용할 수 없습니다.',
  CLI_USAGE_LIMIT: 'Codex 사용량 한도에 도달했습니다. 다른 과금 방식으로 전환하지 않습니다.',
  CLI_MODEL_UNAVAILABLE: '현재 Codex 계정에서 모델을 사용할 수 없습니다.',
  CLI_OUTPUT_INVALID: 'Codex의 완전한 최종 텍스트와 정상 완료 이벤트를 확인하지 못했습니다.',
  CLI_OUTPUT_LIMIT: 'Codex 출력 크기 제한을 초과했습니다. 잘린 결과는 사용하지 않습니다.',
  CLI_TERMINATION_FAILED: 'Codex 프로세스 종료를 확인하지 못했습니다. 앱을 종료한 뒤 확인해주세요.',
  PROVIDER_NOT_FOUND: '등록된 Provider를 찾을 수 없습니다.',
  CONFIG_MISSING: 'Provider 설정이 없습니다. main process의 base URL과 model 설정을 확인해주세요.',
  API_KEY_MISSING: 'API Key가 없습니다. main process의 환경 변수를 확인해주세요.',
  INVALID_BASE_URL: 'Base URL이 올바르지 않습니다. HTTPS 또는 로컬 HTTP API 주소를 확인해주세요.',
  NETWORK_ERROR: 'Provider에 연결하지 못했습니다. 네트워크와 서버 주소를 확인해주세요.',
  TIMEOUT: 'Provider 응답 대기 시간이 초과되었습니다.',
  CANCELLED: '작업이 중지되었습니다.',
  HTTP_ERROR: 'Provider가 HTTP 오류를 반환했습니다. 인증·모델·사용 한도를 확인해주세요.',
  RESPONSE_PARSE_ERROR: 'Provider 응답을 읽을 수 없습니다. 지원하는 텍스트 응답인지 확인해주세요.',
  EXECUTION_FAILED: 'Provider 작업 실행에 실패했습니다.',
  FALLBACK_UNAVAILABLE: '다른 사용 가능한 AI가 없어 작업을 완료하지 못했습니다.',
  CHECK_UNSUPPORTED: '이 Provider는 외부 연결 확인을 지원하지 않습니다.',
  INVALID_REQUEST: 'Provider 요청 형식 또는 크기가 올바르지 않습니다.',
  BUSY: 'Provider가 작업 중입니다. 완료 후 다시 시도해주세요.',
  IPC_UNAVAILABLE: '데스크톱 Provider 연결을 사용할 수 없습니다. 앱을 다시 시작해주세요.',
  IPC_FORBIDDEN: '허용되지 않은 화면에서 보낸 요청입니다.',
  ENCRYPTION_UNAVAILABLE: '안전한 API 키 저장을 사용할 수 없습니다.',
  ENCRYPTION_FAILED: 'API 키 암호화에 실패했습니다.',
  DECRYPTION_FAILED: '저장된 API 키를 복호화하지 못했습니다.',
  STORAGE_READ_FAILED: '저장된 연결을 읽지 못했습니다.',
  STORAGE_CORRUPT: '저장된 연결 정보가 손상되었습니다.',
  STORAGE_WRITE_FAILED: '연결 정보를 저장하지 못했습니다.',
  STORAGE_REMOVE_FAILED: '연결 정보를 제거하지 못했습니다.',
  CONFIG_INVALID: '서버 주소와 모델 설정을 확인해주세요.',
  KEY_REQUIRED: '새 연결에는 API 키가 필요합니다.',
  CONFIG_BUSY: '작업 또는 연결 확인이 끝난 뒤 설정을 변경해주세요.',
} as const;

export type ProviderErrorCode = keyof typeof messages;
export interface ProviderFailure {
  code: ProviderErrorCode;
  message: string;
  httpStatus?: number;
}

// Only application-owned text can cross the main/renderer boundary.
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly httpStatus?: number;

  constructor(code: ProviderErrorCode, httpStatus?: number) {
    const status = Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599
      ? httpStatus : undefined;
    super(`[${code}] ${messages[code]}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'ProviderError';
    this.code = code;
    this.httpStatus = status;
  }
}

export function toProviderFailure(cause: unknown): ProviderFailure {
  const safe = cause instanceof ProviderError && Object.hasOwn(messages, cause.code)
    ? new ProviderError(cause.code, cause.httpStatus) : new ProviderError('EXECUTION_FAILED');
  return { code: safe.code, message: safe.message, ...(safe.httpStatus ? { httpStatus: safe.httpStatus } : {}) };
}
