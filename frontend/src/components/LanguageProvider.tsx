'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  getLocaleFromPathname,
  localeToHtmlLang,
  normalizeLocale,
  translate,
  type I18nKey,
  type Locale,
} from '@/lib/i18n';

interface LanguageContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: I18nKey, values?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({
  initialLocale = DEFAULT_LOCALE,
  children,
}: {
  initialLocale?: Locale;
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => normalizeLocale(initialLocale));

  useEffect(() => {
    try {
      const urlLocale = getLocaleFromPathname(window.location.pathname);
      if (urlLocale) {
        setLocaleState(urlLocale);
        localStorage.setItem(LOCALE_STORAGE_KEY, urlLocale);
        document.documentElement.lang = localeToHtmlLang(urlLocale);
        return;
      }

      const stored = normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
      setLocaleState(stored);
      document.documentElement.lang = localeToHtmlLang(stored);
    } catch {
      setLocaleState(DEFAULT_LOCALE);
      document.documentElement.lang = localeToHtmlLang(DEFAULT_LOCALE);
    }
  }, []);

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // Storage can be unavailable in hardened/private browser modes.
    }
    document.documentElement.lang = localeToHtmlLang(nextLocale);
  }, []);

  const value = useMemo<LanguageContextValue>(() => ({
    locale,
    setLocale,
    t: (key, values) => translate(locale, key, values),
  }), [locale, setLocale]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useI18n(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) {
    throw new Error('useI18n must be used within LanguageProvider');
  }
  return value;
}

