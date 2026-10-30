// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { ProviderRequest, ProviderResponse } from './ai-provider.ts';
import type { AttachmentBridge } from '../application/attachment-ipc.ts';
import type { ProviderConnection } from './provider-registry.ts';
import type { ProviderFailure } from './provider-error.ts';
import type { ConnectionCheckResult } from './connection-check.ts';
import type { ConnectionConfiguration, SaveConnectionConfiguration } from './connection-configuration.ts';
import type { ResultExportBridge } from '../application/result-export.ts';
import type { HistoryBridge } from '../application/history-ipc.ts';
import type { OllamaBridge } from './ollama.ts';

export type ProviderReply<T> = { ok: true; value: T } | { ok: false; error: ProviderFailure };

export interface ProviderExecution {
  executionId?: string;
  providerId: string;
  request: ProviderRequest;
}

export interface ProviderBridge {
  listProviders(): Promise<ProviderReply<ProviderConnection[]>>;
  executeProvider(input: ProviderExecution): Promise<ProviderReply<ProviderResponse>>;
  cancelExecution(executionId: string): Promise<ProviderReply<{ cancelled: boolean }>>;
  testConnection(providerId: string): Promise<ConnectionCheckResult>;
  getConfiguration(providerId: string): Promise<ProviderReply<ConnectionConfiguration>>;
  saveConfiguration(input: SaveConnectionConfiguration): Promise<ProviderReply<ConnectionConfiguration>>;
  removeConfiguration(providerId: string): Promise<ProviderReply<ConnectionConfiguration>>;
}

declare global {
  interface Window {
    readonly seohoKimLoop?: ProviderBridge & ResultExportBridge & HistoryBridge & AttachmentBridge & OllamaBridge;
  }
}
