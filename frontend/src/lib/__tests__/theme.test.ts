import { describe, expect, it } from 'vitest';
import { applyTheme, isTheme, normalizeTheme } from '@/lib/theme';

describe('theme helpers', () => {
  it('accepts only supported theme values', () => {
    expect(isTheme('system')).toBe(true);
    expect(isTheme('light')).toBe(true);
    expect(isTheme('dark')).toBe(true);
    expect(isTheme('auto')).toBe(false);
  });

  it('normalizes invalid values to system', () => {
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('nope')).toBe('system');
    expect(normalizeTheme(null)).toBe('system');
  });

  it('applies explicit themes and clears system theme', () => {
    const root = document.createElement('html');
    applyTheme('dark', root);
    expect(root.getAttribute('data-theme')).toBe('dark');
    applyTheme('system', root);
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});

