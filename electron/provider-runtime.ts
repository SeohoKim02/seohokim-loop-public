// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { MockProvider } from '../src/providers/mock-provider.ts';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import { OpenAICompatibleProvider } from './providers/openai-compatible.ts';
import { AnthropicProvider } from './providers/anthropic.ts';
import { configurableProviderIds, isConfigurableProviderId } from '../src/providers/connection-configuration.ts';
import type { ConfigurableProviderId, ConnectionConfiguration } from '../src/providers/connection-configuration.ts';
import { ProviderError, toProviderFailure } from '../src/providers/provider-error.ts';
import type { ProviderErrorCode } from '../src/providers/provider-error.ts';
import { validateSettings } from './connection-store.ts';
import type { ConnectionStore } from './connection-store.ts';
import type { CodexCliProvider } from './providers/codex-cli.ts';
import type { OllamaProvider } from './providers/ollama.ts';

type Config = { baseUrl?: string; model?: string; apiKey?: string };
type Store = Pick<ConnectionStore, 'read' | 'save' | 'remove'>;
export function localManualExperimentEnabled(isPackaged: boolean, environment: NodeJS.ProcessEnv): boolean {
  return !isPackaged && environment.SEOHOKIM_LOOP_LOCAL_COLLABORATION === '1';
}
interface ConnectionState {
  store?: Store;
  environment?: Config;
  active?: Config;
  source: ConnectionConfiguration['source'];
  storageError?: ProviderErrorCode;
}

function environmentConfig(environment: NodeJS.ProcessEnv, id: ConfigurableProviderId): Config | undefined {
  const config: Config = id === 'anthropic'
    ? { apiKey: environment.SEOHOKIM_LOOP_ANTHROPIC_API_KEY, model: environment.SEOHOKIM_LOOP_ANTHROPIC_MODEL }
    : { apiKey: environment.SEOHOKIM_LOOP_OPENAI_API_KEY, baseUrl: environment.SEOHOKIM_LOOP_OPENAI_BASE_URL, model: environment.SEOHOKIM_LOOP_OPENAI_MODEL };
  return Object.values(config).some(Boolean) ? config : undefined;
}

function adapter(id: ConfigurableProviderId, config?: Config) {
  return id === 'anthropic' ? new AnthropicProvider(config)
    : new OpenAICompatibleProvider(config ? { ...config, id, displayName: 'OpenAI-compatible' } : undefined);
}

export function createProviderRegistry(environment: NodeJS.ProcessEnv): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider(), { type: 'mock', configured: true });
  for (const id of configurableProviderIds) {
    const provider = adapter(id, environmentConfig(environment, id));
    const unavailableReason = provider.configurationError;
    registry.register(provider, { type: id, configured: unavailableReason === undefined, unavailableReason });
  }
  return registry;
}

export class ProviderRuntime {
  readonly registry: ProviderRegistry;
  readonly #states: Record<ConfigurableProviderId, ConnectionState>;
  readonly local?: CodexCliProvider;
  readonly ollama?: OllamaProvider;
  private readonly experimentalManual: boolean;

  constructor(environment: NodeJS.ProcessEnv, openaiStore: Store, anthropicStore?: Store, local?: CodexCliProvider, ollama?: OllamaProvider,
    experimentalManual = false) {
    this.experimentalManual = experimentalManual;
    this.registry = createProviderRegistry(environment);
    this.local = local;
    this.ollama = ollama;
    if (ollama) this.registry.register(ollama, { type: 'local-ollama', configured: false, singleOnly: true, ollama: ollama.status, modelPolicy: ollama.modelPolicy, unavailableReason: ollama.unavailableReason });
    if (local) this.registry.register(local, { type: 'local-cli', configured: false, singleOnly: true, localCli: local.status, unavailableReason: local.unavailableReason });
    this.#states = {
      'openai-compatible': { store: openaiStore, environment: environmentConfig(environment, 'openai-compatible'), source: 'none' },
      anthropic: { store: anthropicStore, environment: environmentConfig(environment, 'anthropic'), source: 'none' },
    };
  }

  async initialize(): Promise<void> {
    for (const id of configurableProviderIds) {
      const state = this.#states[id];
      try {
        const saved = await state.store?.read();
        this.apply(id, saved ?? state.environment, saved ? 'saved' : state.environment ? 'environment' : 'none');
      } catch (cause) {
        // A damaged connection disables only that provider; never silently switch credentials.
        this.apply(id, undefined, 'unavailable', toProviderFailure(cause).code);
      }
    }
    await this.refreshConnections();
  }

  async refreshConnections(): Promise<void> {
    await Promise.all([this.local?.refresh(), this.ollama?.refresh()]);
    if (this.local) this.registry.replace(this.local, { type: 'local-cli', configured: this.local.configured, singleOnly: true, experimentalManual: this.experimentalManual,
      unavailableReason: this.local.unavailableReason, localCli: this.local.status });
    this.updateOllama();
  }

  private updateOllama(): void {
    if (this.ollama) this.registry.replace(this.ollama, { type: 'local-ollama', configured: this.ollama.configured, singleOnly: true, experimentalManual: this.experimentalManual,
      unavailableReason: this.ollama.unavailableReason, ollama: this.ollama.status, modelPolicy: this.ollama.modelPolicy });
  }
  async selectOllamaModel(model: unknown) {
    if (!this.ollama) throw new ProviderError('PROVIDER_NOT_FOUND');
    try { return await this.ollama.selectModel(model); }
    finally { this.updateOllama(); }
  }

  private apply(id: ConfigurableProviderId, config: Config | undefined, source: ConnectionConfiguration['source'], error?: ProviderErrorCode): void {
    const provider = adapter(id, config);
    const unavailableReason = error ?? provider.configurationError;
    this.registry.replace(provider, { type: id, configured: unavailableReason === undefined, unavailableReason });
    Object.assign(this.#states[id], { active: config, source, storageError: error });
  }

  private requireId(id: unknown): ConfigurableProviderId {
    if (!isConfigurableProviderId(id)) throw new ProviderError('INVALID_REQUEST');
    return id;
  }

  getConfiguration(providerId: unknown): ConnectionConfiguration {
    const id = this.requireId(providerId);
    const state = this.#states[id];
    let baseUrl = '';
    let model = '';
    try {
      const valid = validateSettings({ ...state.active, model: state.active?.model ?? '', apiKey: state.active?.apiKey ?? '' }, id);
      this.rejectCredentialMetadata(valid.baseUrl ?? '', valid.model);
      baseUrl = valid.baseUrl ?? '';
      model = valid.model;
    } catch { /* Never echo invalid environment metadata. */ }
    const summary = { model, hasApiKey: !!state.active?.apiKey?.trim(), source: state.source,
      hasSavedConfiguration: state.source === 'saved' || state.source === 'unavailable',
      ...(state.storageError ? { storageError: state.storageError } : {}) };
    return id === 'anthropic' ? { id, ...summary } : { id, baseUrl, ...summary };
  }

  private rejectCredentialMetadata(baseUrl: string, model: string): void {
    for (const state of Object.values(this.#states)) {
      for (const key of [state.active?.apiKey?.trim(), state.environment?.apiKey?.trim()]) {
        if (key && (baseUrl.includes(key) || decodeURIComponent(baseUrl).includes(key) || model.includes(key))) {
          throw new ProviderError('CONFIG_INVALID');
        }
      }
    }
  }

  async saveConfiguration(value: unknown): Promise<ConnectionConfiguration> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('INVALID_REQUEST');
    const input = value as Record<string, unknown>;
    const id = this.requireId(input.providerId);
    const allowed = id === 'anthropic' ? ['providerId', 'model', 'apiKey'] : ['providerId', 'baseUrl', 'model', 'apiKey'];
    if (Object.keys(input).some((key) => !allowed.includes(key)) || typeof input.model !== 'string'
      || (id === 'openai-compatible' && typeof input.baseUrl !== 'string')
      || (input.apiKey !== undefined && typeof input.apiKey !== 'string')) throw new ProviderError('INVALID_REQUEST');
    const state = this.#states[id];
    const settings = validateSettings({ ...(id === 'openai-compatible' ? { baseUrl: input.baseUrl as string } : {}),
      model: input.model, apiKey: (input.apiKey as string | undefined)?.trim() || state.active?.apiKey || '' }, id);
    this.rejectCredentialMetadata(settings.baseUrl ?? '', settings.model);
    if (!state.store) throw new ProviderError('IPC_UNAVAILABLE');
    await state.store.save(settings);
    this.apply(id, settings, 'saved');
    return this.getConfiguration(id);
  }

  async removeConfiguration(providerId: unknown): Promise<ConnectionConfiguration> {
    const id = this.requireId(providerId);
    const state = this.#states[id];
    if (!state.store) throw new ProviderError('IPC_UNAVAILABLE');
    await state.store.remove();
    this.apply(id, state.environment, state.environment ? 'environment' : 'none');
    return this.getConfiguration(id);
  }
}
