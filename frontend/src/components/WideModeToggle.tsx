'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/components/LanguageProvider';

interface WideModeToggleProps {
  enabled: boolean;
  onToggle: () => void;
}

export function WideModeToggle({ enabled, onToggle }: WideModeToggleProps) {
  const { t } = useI18n();
  const Icon = enabled ? PanelLeftClose : PanelLeftOpen;
  const label = enabled ? t('toolbar.exitWideMode') : t('toolbar.wideMode');

  return (
    <Button
      type="button"
      variant={enabled ? 'secondary' : 'outline'}
      size="sm"
      onClick={onToggle}
      className="hidden gap-2 xl:inline-flex"
      aria-pressed={enabled}
      title={label}
    >
      <Icon className="w-4 h-4" />
      <span className="hidden lg:inline">{label}</span>
    </Button>
  );
}
