// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { ProviderConnection } from '../providers/provider-registry.ts';
import { connectionStatus } from './connection-status.ts';
import type { ConnectionCheckState } from './use-connections.ts';
import { useState } from 'react';
import { ConnectionEditor } from './ConnectionEditor.tsx';
import { isConfigurableProviderId, configurationErrorMessage } from '../providers/connection-configuration.ts';
import type { ConnectionConfiguration, SaveConnectionConfiguration } from '../providers/connection-configuration.ts';
import { LocalCliConnection } from './LocalCliConnection.tsx';
import { OllamaConnection } from './OllamaConnection.tsx';

interface ConnectionsProps {
  providers: readonly ProviderConnection[];
  isLoading: boolean;
  error?: string;
  refresh(): Promise<void>;
  checks: Readonly<Record<string, ConnectionCheckState>>;
  testConnection(providerId: string): Promise<void>;
  configurations: Readonly<Record<string, ConnectionConfiguration>>;
  configurationErrors: Readonly<Record<string, string | undefined>>;
  isSaving: boolean;
  isLoopRunning: boolean;
  saveConfiguration(input: SaveConnectionConfiguration): Promise<boolean>;
  removeConfiguration(providerId: string): Promise<boolean>;
}

export function Connections({ providers, isLoading, error, refresh, checks, testConnection,
  configurations, configurationErrors, isSaving, isLoopRunning, saveConfiguration, removeConfiguration }: ConnectionsProps) {
  const [editingId, setEditingId] = useState<string>();
  const isChecking = Object.values(checks).some((check) => check.checking);
  return (
    <section aria-labelledby="connections-title">
      <div className="intro">
        <p className="eyebrow">CONNECTIONS</p>
        <h1 id="connections-title">AI 연결</h1>
        <p>SeohoKim Loop에서 사용할 AI를 확인하세요.</p>
      </div>
      <div className="connections-toolbar">
        <p>새로고침은 설정 상태만 조회하며 외부 AI를 호출하지 않습니다.</p>
        <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={isLoading || isSaving}>
          {isLoading ? '확인 중…' : '새로고침'}
        </button>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      {isLoading && <p className="connection-loading" role="status">AI 연결 상태를 불러오고 있습니다.</p>}
      <div className="connections-grid" aria-busy={isLoading}>
        {providers.map((provider) => {
          if (provider.type === 'local-cli') return <LocalCliConnection key={provider.id} provider={provider} />;
          if (provider.type === 'local-ollama') return <OllamaConnection key={provider.id} provider={provider}
            disabled={isLoading || isSaving || isLoopRunning || isChecking} refresh={refresh} />;
          const configuration = configurations[provider.id];
          const configurationError = configurationErrors[provider.id];
          const editing = editingId === provider.id;
          const status = connectionStatus(provider);
          const isMock = provider.type === 'mock';
          const check = checks[provider.id];
          const result = check?.result;
          const checkStatus = check?.checking ? 'checking' : !result ? 'not_checked' : result.ok ? 'success' : 'failed';
          return (
            <article className="card connection-card" key={provider.id} aria-label={provider.displayName}
              data-testid="connection-card" data-provider-id={provider.id} data-state={status.state}>
              <div className="connection-heading">
                <div>
                  <p className="connection-kind">{isMock ? '테스트용 AI' : '외부 AI 서비스'}</p>
                  <h2>{provider.displayName}</h2>
                </div>
                <span className={`connection-status connection-${status.state}`}>{status.label}</span>
              </div>
              <p className="connection-description">{isMock
                ? '개발·테스트를 위한 예시 결과를 만듭니다. 실제 AI를 호출하지 않습니다.'
                : '설정한 AI 서비스로 작업을 보내고 생성된 결과를 받습니다.'}</p>
              <p className="connection-detail">{status.detail}</p>
              {!provider.configured && <p className="connection-unavailable">지금은 Loop에서 선택할 수 없습니다.</p>}
              {isConfigurableProviderId(provider.id) && (
                <div className="connection-settings">
                  {configurationError && <p className="error-message" role="alert">{configurationError}</p>}
                  {configuration?.storageError && <p className="error-message" role="alert">{configurationErrorMessage(configuration.storageError)}</p>}
                  {configuration?.model && <p className="connection-check-note">Model: {configuration.model}</p>}
                  <p className="connection-check-note">{configuration?.source === 'saved' ? '앱에 저장한 연결을 사용합니다.'
                    : configuration?.source === 'environment' ? '개발 환경의 연결을 사용합니다. 앱에 저장하면 저장된 설정이 우선합니다.'
                      : provider.id === 'anthropic' ? '연결 설정에서 모델과 API 키를 입력하세요.' : '연결 설정에서 서버 주소, 모델, API 키를 입력하세요.'}</p>
                  {editing && configuration ? <ConnectionEditor configuration={configuration}
                    disabled={isSaving || isLoopRunning || isChecking} save={saveConfiguration} close={() => setEditingId(undefined)} /> : (
                    <div className="connection-actions">
                      <button className="secondary-button" type="button" disabled={!configuration || isLoading || isSaving || isLoopRunning || isChecking}
                        onClick={() => setEditingId(provider.id)}>{provider.configured ? '연결 수정' : '연결 설정'}</button>
                      {configuration?.hasSavedConfiguration && <button className="secondary-button" type="button"
                        disabled={isLoading || isSaving || isLoopRunning || isChecking} onClick={() => void removeConfiguration(provider.id)}>연결 제거</button>}
                    </div>
                  )}
                  {configuration?.hasSavedConfiguration && <p className="connection-check-note">제거하면 저장된 키도 삭제됩니다. 개발 환경 설정이 있으면 해당 연결로 돌아갑니다.</p>}
                </div>
              )}
              {provider.supportsConnectionCheck && (
                <div className="connection-check" data-check-status={checkStatus}>
                  <div className="connection-check-heading">
                    <h3>연결 확인</h3>
                    <span className={`status status-${checkStatus === 'success' ? 'completed' : checkStatus === 'checking' ? 'running' : checkStatus === 'failed' ? 'failed' : 'pending'}`} role="status">
                      {checkStatus === 'checking' ? '확인 중…' : checkStatus === 'success' ? '연결 성공' : checkStatus === 'failed' ? '연결 실패' : '확인 전'}
                    </span>
                  </div>
                  {result && !result.ok && <p className="connection-check-error" role="alert">{result.reason}</p>}
                  {result && <p className="connection-checked-at">마지막 확인: <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString('ko-KR')}</time></p>}
                  {!provider.configured && <p className="connection-check-note">연결 설정을 저장한 뒤 확인할 수 있습니다.</p>}
                  <button className="secondary-button" type="button" disabled={isLoading || isSaving || editing || !provider.configured || check?.checking}
                    onClick={() => void testConnection(provider.id)}>
                    {check?.checking ? '확인 중…' : '연결 확인'}
                  </button>
                  <p className="connection-check-note">버튼을 누르면 짧은 요청을 한 번 보내며 API 사용 요금이 발생할 수 있습니다.</p>
                </div>
              )}
              {!isMock && (
                <div className="connection-help">
                  <p>앱에서 저장한 연결은 즉시 반영됩니다. 환경 변수 연결도 계속 지원합니다.</p>
                  <p>설정 방법은 README를 참고하세요. 변경한 환경 변수는 앱을 다시 시작해야 반영됩니다.</p>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {!isLoading && !error && providers.length === 0 && (
        <p className="connection-loading">등록된 AI 연결이 없습니다.</p>
      )}
    </section>
  );
}
