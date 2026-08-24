import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';
import { getTranslator } from '@/lib/i18n';
import { loginAction } from '@/app/actions/auth';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';

export const dynamic = 'force-dynamic';

const ERROR_KEYS = {
  invalid: 'login.error.invalid',
  throttled: 'login.error.throttled',
  required: 'login.error.required',
} as const;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getSessionUser()) redirect('/');

  const { t, locale } = await getTranslator();
  const { error } = await searchParams;
  const errorKey = error && error in ERROR_KEYS ? ERROR_KEYS[error as keyof typeof ERROR_KEYS] : null;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-lg font-semibold">{t('app.name')}</h1>
          <p className="mt-1 text-sm text-content-muted">{t('app.tagline')}</p>
        </div>

        <form action={loginAction} className="card space-y-4 p-5">
          <div>
            <h2 className="text-base font-semibold">{t('login.title')}</h2>
            <p className="text-xs text-content-faint">{t('login.subtitle')}</p>
          </div>

          {errorKey ? (
            <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {t(errorKey)}
            </p>
          ) : null}

          <label className="block">
            <span className="field-label">{t('login.username')}</span>
            <input
              name="username"
              autoComplete="username"
              autoFocus
              required
              dir="ltr"
              className="input"
            />
          </label>

          <label className="block">
            <span className="field-label">{t('login.password')}</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              dir="ltr"
              className="input"
            />
          </label>

          <button type="submit" className="btn btn-primary w-full">
            {t('login.submit')}
          </button>
        </form>

        <div className="mt-6 flex justify-center">
          <LanguageSwitcher current={locale} label={t('nav.language')} />
        </div>
      </div>
    </main>
  );
}
