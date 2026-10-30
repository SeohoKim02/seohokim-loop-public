// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { ProviderReply } from './provider-ipc.ts';
import type { TechnicalModel } from './model-capability.ts';

export interface OllamaStatus {
  state: 'not_installed' | 'stopped' | 'no_models' | 'select_model' | 'ready' | 'failed';
  installed: boolean;
  version?: string;
  models: string[];
  selectedModel?: string;
  checkedAt?: string;
  modelMetadata?: TechnicalModel[];
}

export interface OllamaBridge {
  selectOllamaModel(model: string): Promise<ProviderReply<OllamaStatus>>;
}

// Names are server-provided data, never URLs, paths, CLI arguments or downloads.
export function validOllamaModel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9._-]+)?$/.test(value)
    && !value.includes('..') && !value.includes('//') && !/(?:^|[:/-])cloud(?:$|[-:])/i.test(value)
    && !/https?:/i.test(value);
}
