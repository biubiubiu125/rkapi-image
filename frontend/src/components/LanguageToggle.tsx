'use client';

import { Languages } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { buttonVariants } from '@/components/ui/button';
import { useI18n } from '@/components/LanguageProvider';
import { getPathForLocale, LOCALE_STORAGE_KEY, type Locale } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const localeOptions: Array<{ value: Locale; labelKey: 'language.en' | 'language.zh' }> = [
  { value: 'en', labelKey: 'language.en' },
  { value: 'zh', labelKey: 'language.zh' },
];

export function LanguageToggle({ iconOnly = false }: { iconOnly?: boolean }) {
  const { locale, setLocale, t } = useI18n();

  const selectLocale = (nextLocale: string) => {
    if (nextLocale !== 'en' && nextLocale !== 'zh') return;
    setLocale(nextLocale);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // Storage can be unavailable in hardened/private browser modes.
    }

    const nextPath = getPathForLocale(window.location.pathname, nextLocale);
    const nextUrl = `${nextPath}${window.location.search}${window.location.hash}`;
    window.location.assign(nextUrl);
  };

  const currentLabel = t(locale === 'zh' ? 'language.zh' : 'language.en');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          buttonVariants({ variant: iconOnly ? 'ghost' : 'outline', size: iconOnly ? 'icon-sm' : 'sm' }),
          iconOnly ? 'rounded-md' : 'gap-0 px-2 sm:gap-2 sm:px-3'
        )}
        title={`${t('language.label')}: ${currentLabel}`}
        aria-label={t('language.switch')}
      >
        <Languages className="size-4" />
        {!iconOnly && <span className="hidden sm:inline">{currentLabel}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup value={locale} onValueChange={selectLocale}>
          {localeOptions.map(option => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {t(option.labelKey)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
