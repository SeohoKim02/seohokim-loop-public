// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { english } from './catalog.ts';
import type { MessageKey } from './catalog.ts';
import { ProviderError, toProviderFailure } from '../providers/provider-error.ts';
import type { ProviderErrorCode } from '../providers/provider-error.ts';

export type Locale = 'ko' | 'en';
export const LANGUAGE_STORAGE_KEY = 'seohokim-loop.language';
export function isLocale(value: unknown): value is Locale { return value === 'ko' || value === 'en'; }

export function initialLocale(saved: unknown, browserLanguage: string): Locale {
  return isLocale(saved) ? saved : /^ko(?:-|$)/i.test(browserLanguage) ? 'ko' : 'en';
}

export function translate(locale: Locale, key: MessageKey, ...values: readonly unknown[]): string {
  // Unknown runtime keys never expose internal identifiers or crash the screen.
  if (!Object.hasOwn(english, key)) return locale === 'en' ? 'Information unavailable.' : '정보를 표시할 수 없습니다.';
  let template: string = locale === 'en' ? english[key] : key;
  if (locale === 'en' && (values[0] === 1 || values[0] === '1') && ['정확히 {0}자', '최소 {0}자', '최대 {0}자', '최소 기준보다 {0}자 부족합니다.', '최대 기준보다 {0}자 초과합니다.'].includes(key)) {
    template = template.replace('characters', 'character');
  }
  if (locale === 'en' && key === '“{0}” 단계의 예시 처리를 마쳤습니다.\n요청: {1}\n앞선 {2}개 단계의 결과를 전달받았습니다.' && (values[2] === 1 || values[2] === '1')) {
    template = template.replace('previous steps', 'previous step');
  }
  // Function substitution preserves literal dollar signs, braces and user text.
  return template.replace(/\{(\d+)\}/g, (token, index: string) => Number(index) < values.length ? String(values[Number(index)]) : token);
}

const reverse = new Map<string, MessageKey>(Object.entries(english).map(([ko, en]) => [en, ko as MessageKey]));
const patterns = Object.keys(english).filter(key => /\{\d+\}/.test(key) && key !== '{0} {1} 단계에서 작업을 완료하지 못했습니다. {2}').map(key => {
  const pieces = key.split(/\{\d+\}/);
  const pattern = pieces.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([\\s\\S]*?)');
  return { key: key as MessageKey, pattern: new RegExp(`^${pattern}$`) };
});

/** Display adapter for legacy application-owned labels/errors. Never use on user/model content. */
export function localizeMessage(locale: Locale, value: string | undefined, depth = 0): string {
  if (!value) return value ?? '';
  if (Object.hasOwn(english, value)) return translate(locale, value as MessageKey);
  const original = reverse.get(value);
  if (original) return translate(locale, original);
  if (locale === 'ko' || depth > 4 || value.length > 20_000) return value;
  // Keep the safe error code and HTTP status intact. Raw adapter exceptions are
  // still sanitized by the existing ProviderError boundary before reaching here.
  const error = /^(\[[A-Z_]+\] )(.+?)( \(HTTP \d{3}\))?$/.exec(value);
  if (error) return error[1] + localizeMessage(locale, error[2], depth + 1) + (error[3] ?? '');
  for (const { key, pattern } of patterns) {
    const match = pattern.exec(value);
    if (match) return translate(locale, key, ...match.slice(1).map(part => localizeMessage(locale, part, depth + 1)));
  }
  return value;
}

/** Use structured step metadata: provider and step names can both contain spaces. */
export function localizeStepError(locale: Locale, error: string | undefined, provider: string, title: string,
  displayTitle = localizeMessage(locale, title), displayProvider = provider): string {
  const prefix = `${provider} ${title} 단계에서 작업을 완료하지 못했습니다. `;
  return error?.startsWith(prefix)
    ? translate(locale, '{0} {1} 단계에서 작업을 완료하지 못했습니다. {2}',
      displayProvider, displayTitle, localizeError(locale, error.slice(prefix.length)))
    : localizeError(locale, error);
}

/** Error text is not user content: never render an unknown exception or stack. */
export function localizeError(locale: Locale, value: string | undefined): string {
  if (!value) return '';
  const coded = /^\[([A-Z_]+)\] .*?(?: \(HTTP (\d{3})\))?$/.exec(value);
  if (coded) return localizeMessage(locale, toProviderFailure(new ProviderError(coded[1] as ProviderErrorCode, coded[2] ? Number(coded[2]) : undefined)).message);
  if (Object.hasOwn(english, value) || reverse.has(value)) return localizeMessage(locale, value);
  return localizeMessage(locale, new ProviderError('EXECUTION_FAILED').message);
}

/** Only this built-in label is localized. User-supplied names are opaque data. */
export function providerLabel(locale: Locale, provider: { id: string; displayName: string }): string {
  return provider.id === 'ollama-local' && provider.displayName === '로컬 AI (Ollama)'
    ? localizeMessage(locale, provider.displayName) : provider.displayName;
}
