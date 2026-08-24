import { requireUser } from '@/lib/auth/session';
import { getTranslator } from '@/lib/i18n';
import { changePasswordAction } from '@/app/actions/auth';
import { Alert, Card, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

const ERROR_KEYS = {
  mismatch: 'password.mismatch',
  tooShort: 'password.tooShort',
  wrongCurrent: 'password.wrongCurrent',
} as const;

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; first?: string }>;
}) {
  const user = await requireUser();
  const { t } = await getTranslator();
  const { error, saved, first } = await searchParams;

  const errorKey =
    error && error in ERROR_KEYS ? ERROR_KEYS[error as keyof typeof ERROR_KEYS] : null;

  return (
    <>
      <PageHeader title={t('password.title')} description={user.username} />

      <div className="max-w-md space-y-4">
        {first || user.mustChangePassword ? (
          <Alert tone="warn">{t('password.mustChange')}</Alert>
        ) : null}
        {saved ? <Alert tone="ok">{t('password.updated')}</Alert> : null}
        {errorKey ? <Alert tone="danger">{t(errorKey)}</Alert> : null}

        <Card>
          <form action={changePasswordAction} className="space-y-4 p-4">
            <label className="block">
              <span className="field-label">{t('password.current')}</span>
              <input
                name="current"
                type="password"
                autoComplete="current-password"
                required
                dir="ltr"
                className="input"
              />
            </label>

            <label className="block">
              <span className="field-label">{t('password.new')}</span>
              <input
                name="next"
                type="password"
                autoComplete="new-password"
                minLength={10}
                required
                dir="ltr"
                className="input"
              />
            </label>

            <label className="block">
              <span className="field-label">{t('password.confirm')}</span>
              <input
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={10}
                required
                dir="ltr"
                className="input"
              />
            </label>

            <button type="submit" className="btn btn-primary">
              {t('password.submit')}
            </button>
          </form>
        </Card>
      </div>
    </>
  );
}
