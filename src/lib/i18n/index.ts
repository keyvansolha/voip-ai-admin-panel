import { cookies } from 'next/headers';
import { dictionaries, type TranslationKey } from './dictionaries';
import { getSettings, LOCALES, type Locale } from '../settings';

/**
 * Locale resolution: an explicit cookie set by the language switcher wins,
 * otherwise the default configured in Settings. Persian renders right-to-left.
 */

export const LOCALE_COOKIE = 'voip_locale';

export type { Locale, TranslationKey };
export { LOCALES };

export function isLocale(value: string | undefined | null): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function direction(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'fa' ? 'rtl' : 'ltr';
}

export async function getLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;

  try {
    return getSettings()['ui.defaultLocale'];
  } catch {
    return 'en';
  }
}

export type Translator = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** `{name}` placeholders are substituted; unknown keys fall back to English. */
export function createTranslator(locale: Locale): Translator {
  const dictionary = dictionaries[locale] ?? dictionaries.en;

  return (key, vars) => {
    const template = dictionary[key] ?? dictionaries.en[key] ?? key;
    if (!vars) return template;

    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in vars ? String(vars[name]) : match,
    );
  };
}

export async function getTranslator(): Promise<{ locale: Locale; t: Translator; dir: 'rtl' | 'ltr' }> {
  const locale = await getLocale();
  return { locale, t: createTranslator(locale), dir: direction(locale) };
}
