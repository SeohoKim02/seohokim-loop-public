// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ConnectionConfiguration, SaveConnectionConfiguration } from '../providers/connection-configuration.ts';

interface Props {
  configuration: ConnectionConfiguration;
  disabled: boolean;
  save(input: SaveConnectionConfiguration): Promise<boolean>;
  close(): void;
}

export function ConnectionEditor({ configuration, disabled, save, close }: Props) {
  const [baseUrl, setBaseUrl] = useState(configuration.id === 'openai-compatible' ? configuration.baseUrl : '');
  const [model, setModel] = useState(configuration.model);
  const keyInput = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !keyInput.current) return;
    // The new key stays only in the password input until this write-only IPC call.
    const pending = save({ ...(configuration.id === 'openai-compatible' ? { providerId: configuration.id, baseUrl } : { providerId: configuration.id }), model, apiKey: keyInput.current.value });
    keyInput.current.value = '';
    if (await pending) close();
  }

  return (
    <form className="connection-editor" onSubmit={(event) => void submit(event)} aria-label="AI 연결 설정" autoComplete="off">
      <fieldset disabled={disabled}>
        <legend>AI 연결 설정</legend>
        {configuration.id === 'openai-compatible' && <><label htmlFor="connection-base-url">Base URL</label>
        <input id="connection-base-url" type="url" required maxLength={2048} value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://your-provider.example/v1" />
        <p className="connection-check-note">API 키를 보낼 신뢰하는 서버 주소를 입력하세요. HTTPS 또는 로컬 HTTP 주소를 지원합니다.</p></>}
        {configuration.id === 'anthropic' && <p className="connection-check-note">Anthropic 공식 API로 연결합니다.</p>}
        <label htmlFor="connection-model">Model</label>
        <input id="connection-model" required maxLength={200} value={model} onChange={(event) => setModel(event.target.value)} placeholder="사용할 모델 ID" />
        <label htmlFor="connection-api-key">API Key</label>
        <input id="connection-api-key" ref={keyInput} type="password" autoComplete="new-password" spellCheck={false}
          maxLength={8192} required={!configuration.hasApiKey} aria-describedby="connection-key-help" />
        <p id="connection-key-help" className="connection-check-note">{configuration.hasApiKey
          ? '현재 API 키가 있습니다. 비워 두면 유지하고, 새 키를 입력하면 교체합니다.'
          : 'API 키는 Windows에서 암호화하여 저장합니다.'}</p>
        <p className="connection-check-note">저장만으로는 AI를 호출하지 않습니다. 저장 후 연결 확인을 눌러주세요.</p>
        <div className="connection-actions">
          <button className="secondary-button" type="submit">{disabled ? '저장 중…' : '저장'}</button>
          <button className="secondary-button" type="button" onClick={() => { if (keyInput.current) keyInput.current.value = ''; close(); }}>취소</button>
        </div>
      </fieldset>
    </form>
  );
}
