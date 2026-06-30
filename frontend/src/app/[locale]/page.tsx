import { LocalizedWorkspace } from '@/components/LocalizedWorkspace';
import { normalizeLocale, type Locale } from '@/lib/i18n';

export function generateStaticParams() {
  return [{ locale: 'en' }, { locale: 'zh' }];
}

export default async function LocaleHome({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale: rawLocale } = await params;
  const locale = normalizeLocale(rawLocale);
  return <LocalizedWorkspace initialLocale={locale} />;
}
