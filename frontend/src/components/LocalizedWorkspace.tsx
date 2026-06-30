'use client';

import { LanguageProvider } from '@/components/LanguageProvider';
import { WorkspaceShell } from '@/components/workspace/WorkspaceShell';
import type { Locale } from '@/lib/i18n';

export function LocalizedWorkspace({ initialLocale }: { initialLocale: Locale }) {
  return (
    <LanguageProvider initialLocale={initialLocale}>
      <WorkspaceShell />
    </LanguageProvider>
  );
}

