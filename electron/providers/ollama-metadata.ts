// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { TechnicalModel } from '../../src/providers/model-capability.ts';
import { ProviderError } from '../../src/providers/provider-error.ts';

function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) throw new ProviderError('RESPONSE_PARSE_ERROR');
  return value;
}

// Caller has checked local membership, digest, GGUF and completion support.
// Never forward raw model_info, templates, system prompts, paths or license text.
export function ollamaMetadata(providerId: string, modelId: string, digest: string, runtimeVersion: string,
  show: { details: Record<string, unknown>; model_info: Record<string, unknown>; capabilities: unknown[]; license?: unknown }): TechnicalModel {
  if (show.capabilities.length > 32 || show.capabilities.some((value) => typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,49}$/.test(value))) throw new ProviderError('RESPONSE_PARSE_ERROR');
  const context = Object.entries(show.model_info).filter(([key]) => key.endsWith('.context_length'));
  if (context.length > 1 || context.some(([, value]) => typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) throw new ProviderError('RESPONSE_PARSE_ERROR');
  if (show.license !== undefined && typeof show.license !== 'string') throw new ProviderError('RESPONSE_PARSE_ERROR');
  return { identity: { providerId, modelId, digest: digest.replace(/^sha256:/, ''), runtimeVersion }, local: true,
    capabilities: [...new Set(show.capabilities as string[])].sort(), format: optionalText(show.details.format)!,
    parameterSize: optionalText(show.details.parameter_size), quantization: optionalText(show.details.quantization_level),
    advertisedContextLength: context[0]?.[1] as number | undefined,
    licensePresent: typeof show.license === 'string' && !!show.license.trim() };
}
