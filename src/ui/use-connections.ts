// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderConnection } from '../providers/provider-registry.ts';
import { connectionCheckFailure } from '../providers/connection-check.ts';
import type { ConnectionCheckResult } from '../providers/connection-check.ts';
import { ProviderError } from '../providers/provider-error.ts';
import { configurableProviderIds, configurationErrorMessage } from '../providers/connection-configuration.ts';
import type { ConnectionConfiguration, SaveConnectionConfiguration } from '../providers/connection-configuration.ts';

export interface ConnectionCheckState {
  checking: boolean;
  result?: ConnectionCheckResult;
}

export function useConnections() {
  const [providers, setProviders] = useState<ProviderConnection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const requestVersion = useRef(0);
  const [checks, setChecks] = useState<Record<string, ConnectionCheckState>>({});
  const checking = useRef(new Set<string>());
  const checkVersion = useRef(0);
  const [configurations, setConfigurations] = useState<Record<string, ConnectionConfiguration>>({});
  const [configurationErrors, setConfigurationErrors] = useState<Record<string, string | undefined>>({});
  const [isSaving, setIsSaving] = useState(false);
  const changing = useRef(false);

  // Explicit action only. The ref closes the gap before React renders disabled buttons.
  const testConnection = useCallback(async (providerId: string): Promise<void> => {
    if (checking.current.has(providerId) || changing.current) return;
    const version = checkVersion.current;
    checking.current.add(providerId);
    setChecks((current) => ({ ...current, [providerId]: { checking: true } }));
    let result: ConnectionCheckResult;
    try {
      if (!window.seohoKimLoop) throw new Error();
      result = await window.seohoKimLoop.testConnection(providerId);
    } catch {
      result = connectionCheckFailure(new ProviderError('IPC_UNAVAILABLE'));
    } finally {
      checking.current.delete(providerId);
    }
    if (version === checkVersion.current) setChecks((current) => ({ ...current, [providerId]: { checking: false, result } }));
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const version = ++requestVersion.current;
    setIsLoading(true);
    setError(undefined);
    try {
      if (!window.seohoKimLoop) throw new Error();
      const [listed, ...settings] = await Promise.allSettled([
        window.seohoKimLoop.listProviders(), ...configurableProviderIds.map((id) => window.seohoKimLoop!.getConfiguration(id)),
      ]);
      if (version === requestVersion.current) {
        const configurations: Record<string, ConnectionConfiguration> = {};
        const errors: Record<string, string | undefined> = {};
        settings.forEach((setting, index) => {
          const id = configurableProviderIds[index]!;
          if (setting.status === 'fulfilled' && setting.value.ok) configurations[id] = setting.value.value as ConnectionConfiguration;
          else errors[id] = configurationErrorMessage();
        });
        setConfigurations(configurations);
        setConfigurationErrors(errors);
      }
      if (listed.status !== 'fulfilled') throw new Error();
      const reply = listed.value;
      if (!reply.ok) throw new Error();
      if (version === requestVersion.current) setProviders(reply.value);
    } catch {
      if (version === requestVersion.current) {
        // Do not advertise a stale connection as usable after a failed lookup.
        setProviders([]);
        setError('AI 연결 상태를 불러오지 못했습니다. 새로고침으로 다시 확인해주세요.');
      }
    } finally {
      if (version === requestVersion.current) setIsLoading(false);
    }
  }, []);

  async function changeConfiguration(providerId: string, input?: SaveConnectionConfiguration): Promise<boolean> {
    if (changing.current || checking.current.size) return false;
    changing.current = true;
    setIsSaving(true);
    const setError = (message?: string) => setConfigurationErrors((current) => ({ ...current, [providerId]: message }));
    setError();
    try {
      if (!window.seohoKimLoop) throw new Error();
      const reply = input ? await window.seohoKimLoop.saveConfiguration(input)
        : await window.seohoKimLoop.removeConfiguration(providerId);
      if (!reply.ok) { setError(configurationErrorMessage(reply.error.code)); return false; }
      setConfigurations((current) => ({ ...current, [providerId]: reply.value }));
      checkVersion.current += 1;
      setChecks((current) => { const next = { ...current }; delete next[providerId]; return next; });
      await refresh();
      return true;
    } catch {
      setError(configurationErrorMessage());
      return false;
    } finally {
      changing.current = false;
      setIsSaving(false);
    }
  }

  useEffect(() => {
    void refresh();
    return () => { requestVersion.current += 1; };
  }, [refresh]);

  return { providers, isLoading, error, refresh, checks, testConnection, configurations, configurationErrors, isSaving,
    saveConfiguration: (input: SaveConnectionConfiguration) => changeConfiguration(input.providerId, input),
    removeConfiguration: (providerId: string) => changeConfiguration(providerId) };
}
