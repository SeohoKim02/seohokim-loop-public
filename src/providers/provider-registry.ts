// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { AIProvider } from './ai-provider.ts';
import { ProviderError } from './provider-error.ts';
import type { ProviderErrorCode } from './provider-error.ts';
import type { LocalCliStatus } from './local-cli.ts';
import type { OllamaStatus } from './ollama.ts';
import { copyModelPolicy, copyTechnicalModel } from './model-capability.ts';
import type { ModelAutoPolicy } from './model-capability.ts';

// Public connection summary: credentials, URLs and adapter instances are excluded.
export interface ProviderConnection {
  readonly id: string;
  readonly displayName: string;
  readonly type: string;
  readonly configured: boolean;
  readonly supportsConnectionCheck: boolean;
  readonly unavailableReason?: ProviderErrorCode;
  readonly singleOnly?: boolean;
  readonly experimentalManual?: boolean;
  readonly localCli?: LocalCliStatus;
  readonly ollama?: OllamaStatus;
  readonly modelPolicy?: ModelAutoPolicy;
}

export class ProviderRegistry {
  private readonly entries = new Map<string, { provider: AIProvider; connection: ProviderConnection }>();

  register(provider: AIProvider, state: Omit<ProviderConnection, 'id' | 'displayName' | 'supportsConnectionCheck'>): void {
    if (!provider.id.trim() || this.entries.has(provider.id)) {
      throw new Error('Provider id는 비어 있거나 중복될 수 없습니다.');
    }
    this.set(provider, state);
  }

  private set(provider: AIProvider, state: Omit<ProviderConnection, 'id' | 'displayName' | 'supportsConnectionCheck'>): void {
    this.entries.set(provider.id, {
      provider,
      connection: {
        id: provider.id, displayName: provider.displayName, type: state.type,
        configured: state.configured, unavailableReason: state.unavailableReason,
        supportsConnectionCheck: typeof provider.testConnection === 'function',
        ...(state.singleOnly ? { singleOnly: true } : {}),
        ...(state.experimentalManual === true ? { experimentalManual: true } : {}),
        ...(state.modelPolicy !== undefined ? { modelPolicy: copyModelPolicy(state.modelPolicy) } : {}),
        ...(state.ollama ? { ollama: { state: state.ollama.state, installed: state.ollama.installed,
          version: state.ollama.version, models: [...state.ollama.models], selectedModel: state.ollama.selectedModel,
          checkedAt: state.ollama.checkedAt, modelMetadata: state.ollama.modelMetadata?.map(copyTechnicalModel) } } : {}),
        ...(state.localCli ? { localCli: { state: state.localCli.state, version: state.localCli.version,
          checkedAt: state.localCli.checkedAt, lastExecution: state.localCli.lastExecution } } : {}),
      },
    });
  }

  get(id: string): AIProvider {
    const entry = this.entries.get(id);
    if (!entry) throw new ProviderError('PROVIDER_NOT_FOUND');
    if (!entry.connection.configured) throw new ProviderError(entry.connection.unavailableReason ?? 'CONFIG_MISSING');
    return entry.provider;
  }

  replace(provider: AIProvider, state: Omit<ProviderConnection, 'id' | 'displayName' | 'supportsConnectionCheck'>): void {
    if (!this.entries.has(provider.id)) throw new ProviderError('PROVIDER_NOT_FOUND');
    this.set(provider, state);
  }

  list(): ProviderConnection[] {
    return [...this.entries.values()].map(({ connection }) => ({ ...connection, ...(connection.localCli ? { localCli: { ...connection.localCli } } : {}),
      ...(connection.modelPolicy ? { modelPolicy: copyModelPolicy(connection.modelPolicy) } : {}),
      ...(connection.ollama ? { ollama: { ...connection.ollama, models: [...connection.ollama.models], modelMetadata: connection.ollama.modelMetadata?.map(copyTechnicalModel) } } : {}) }));
  }
}
