'use client';

import { useState, useEffect } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/components/LanguageProvider';
import { applyTheme, isTheme, type Theme } from '@/lib/theme';

const themeOptions: { value: Theme; labelKey: 'theme.light' | 'theme.dark' | 'theme.system'; icon: typeof Sun }[] = [
  { value: 'system', labelKey: 'theme.system', icon: Monitor },
  { value: 'light', labelKey: 'theme.light', icon: Sun },
  { value: 'dark', labelKey: 'theme.dark', icon: Moon },
];

export function ThemeToggle({ iconOnly = false }: { iconOnly?: boolean }) {
  const { t } = useI18n();
  const [theme, setTheme] = useState<Theme>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;

      setMounted(true);
      try {
        const stored = localStorage.getItem('theme');
        const nextTheme = isTheme(stored) ? stored : 'system';
        setTheme(nextTheme);
        applyTheme(nextTheme);
      } catch {
        applyTheme('system');
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const selectTheme = (newTheme: string) => {
    if (!isTheme(newTheme)) return;
    setTheme(newTheme);
    try {
      localStorage.setItem('theme', newTheme);
    } catch {
      // Storage can be unavailable in hardened/private browser modes.
    }
    applyTheme(newTheme);
  };

  if (!mounted) {
    return (
      <Button variant={iconOnly ? 'ghost' : 'outline'} size={iconOnly ? 'icon-sm' : 'icon'} aria-label={t('theme.switch')}>
        <div className="w-5 h-5" />
      </Button>
    );
  }

  const currentOption = themeOptions.find(o => o.value === theme)!;
  const CurrentIcon = currentOption.icon;
  const currentLabel = t(currentOption.labelKey);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          buttonVariants({ variant: iconOnly ? 'ghost' : 'outline', size: iconOnly ? 'icon-sm' : 'sm' }),
          iconOnly ? 'rounded-md' : 'gap-0 px-2 sm:gap-2 sm:px-3'
        )}
        title={`${t('theme.label')}: ${currentLabel}`}
        aria-label={t('theme.switch')}
      >
        <CurrentIcon className="size-4" />
        {!iconOnly && <span className="hidden sm:inline">{currentLabel}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuRadioGroup value={theme} onValueChange={selectTheme}>
          {themeOptions.map((option) => {
            const Icon = option.icon;
            return (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                <Icon className="size-4" />
                {t(option.labelKey)}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
