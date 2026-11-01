// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { initialLocale, isLocale, LANGUAGE_STORAGE_KEY, localizeError, localizeMessage, providerLabel, translate } from './messages.ts';
import type { Locale } from './messages.ts';
import type { MessageKey } from './catalog.ts';

const LanguageContext = createContext<{ locale: Locale; storageFailed: boolean; setLocale: (locale: Locale) => void }>({ locale: 'ko', storageFailed: false, setLocale: () => {} });

export function LanguageProvider({ children, initialLanguage }: { children: ReactNode; initialLanguage?: Locale }) {
  const [storageFailed, setStorageFailed] = useState(false);
  const [locale, setLocale] = useState<Locale>(() => {
    if (isLocale(initialLanguage)) return initialLanguage;
    let saved: string | null = null;
    try { saved = localStorage.getItem(LANGUAGE_STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
    return initialLocale(saved, navigator.language);
  });
  useEffect(() => {
    document.documentElement.lang = locale;
    try { localStorage.setItem(LANGUAGE_STORAGE_KEY, locale); setStorageFailed(false); }
    catch { setStorageFailed(true); }
  }, [locale]);
  return <LanguageContext.Provider value={{ locale, storageFailed, setLocale: next => { if (isLocale(next)) setLocale(next); } }}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  return { ...context, dateLocale: context.locale === 'ko' ? 'ko-KR' : 'en-US',
    providerName: (provider: { id: string; displayName: string }) => providerLabel(context.locale, provider),
    errorMessage: (value: string | undefined) => localizeError(context.locale, value),
    t: (key: MessageKey, ...values: readonly unknown[]) => translate(context.locale, key, ...values),
    message: (value: string | undefined) => localizeMessage(context.locale, value) };
}
