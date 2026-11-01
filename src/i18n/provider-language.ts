// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { Locale } from './messages.ts';

// UI language selects deterministic Mock examples only. It is not an AI
// response-language preference and must never reach a real provider request.
export function mockExampleLocale(providerType: string, uiLocale?: Locale): Locale | undefined {
  return providerType === 'mock' ? uiLocale : undefined;
}
