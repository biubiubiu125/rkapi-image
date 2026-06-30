'use client';

export type Theme = 'light' | 'dark' | 'system';

export const DEFAULT_THEME: Theme = 'system';

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function normalizeTheme(value: unknown): Theme {
  return isTheme(value) ? value : DEFAULT_THEME;
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

