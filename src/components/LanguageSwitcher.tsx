import { setLocaleAction } from '@/app/actions/locale';
import { LOCALES, type Locale } from '@/lib/i18n';

const LABELS: Record<Locale, string> = {
  en: 'English',
  fa: 'فارسی',
};

/**
 * Two small submit buttons rather than a <select>, so switching works without
 * any client-side JavaScript.
 */
export function LanguageSwitcher({ current, label }: { current: Locale; label?: string }) {
  return (
    <form action={setLocaleAction} className="flex items-center gap-1">
      {label ? <span className="me-1 text-xs text-content-faint">{label}</span> : null}
      {LOCALES.map((locale) => (
        <button
          key={locale}
          type="submit"
          name="locale"
          value={locale}
          aria-current={locale === current}
          className={`rounded px-2 py-1 text-xs transition-colors ${
            locale === current
              ? 'bg-accent/15 text-accent'
              : 'text-content-faint hover:text-content'
          }`}
        >
          {LABELS[locale]}
        </button>
      ))}
    </form>
  );
}
