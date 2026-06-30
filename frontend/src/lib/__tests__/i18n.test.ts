import { describe, expect, it } from 'vitest';
import {
  getLocaleFromPathname,
  getPathForLocale,
  normalizeLocale,
  translate,
} from '@/lib/i18n';

describe('i18n helpers', () => {
  it('parses supported locales from pathnames', () => {
    expect(getLocaleFromPathname('/')).toBeNull();
    expect(getLocaleFromPathname('/en/')).toBe('en');
    expect(getLocaleFromPathname('/zh/')).toBe('zh');
    expect(getLocaleFromPathname('/fr/')).toBeNull();
  });

  it('normalizes unsupported locales to English', () => {
    expect(normalizeLocale('zh')).toBe('zh');
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('fr')).toBe('en');
    expect(normalizeLocale(undefined)).toBe('en');
  });

  it('translates keys and interpolates values', () => {
    expect(translate('en', 'theme.system')).toBe('System');
    expect(translate('zh', 'theme.system')).toBe('跟随系统');
    expect(translate('en', 'queue.queuedMax', { count: 2, max: 10 })).toBe('Queued 2 (max 10)');
  });

  it('builds locale paths while preserving nested paths', () => {
    expect(getPathForLocale('/', 'zh')).toBe('/zh/');
    expect(getPathForLocale('/en/', 'zh')).toBe('/zh/');
    expect(getPathForLocale('/zh/assets/', 'en')).toBe('/en/assets/');
    expect(getPathForLocale('/settings/', 'zh')).toBe('/zh/settings/');
  });
});

