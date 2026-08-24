import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { getTranslator } from '@/lib/i18n';
import { logoutAction } from '@/app/actions/auth';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { NavLink } from '@/components/NavLink';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const { t, locale } = await getTranslator();

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1400px] flex-col lg:flex-row">
      <aside className="flex flex-col border-b border-border lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:shrink-0 lg:border-e lg:border-b-0">
        <div className="flex items-center justify-between gap-2 px-4 py-4">
          <Link href="/" className="text-sm font-semibold">
            {t('app.name')}
          </Link>
        </div>

        <nav className="flex flex-wrap gap-1 px-2 pb-3 lg:flex-col lg:pb-0">
          <NavLink href="/">{t('nav.dashboard')}</NavLink>
          <NavLink href="/calls">{t('nav.calls')}</NavLink>
          <NavLink href="/prompts">{t('nav.prompts')}</NavLink>
          <NavLink href="/logs">{t('nav.logs')}</NavLink>
          <NavLink href="/settings">{t('nav.settings')}</NavLink>
        </nav>

        <div className="mt-auto space-y-3 px-4 py-4">
          <LanguageSwitcher current={locale} />
          <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
            <Link
              href="/account"
              className="truncate text-xs text-content-muted hover:text-accent"
              title={user.username}
            >
              {user.username}
            </Link>
            <form action={logoutAction}>
              <button type="submit" className="text-xs text-content-faint hover:text-danger">
                {t('nav.logout')}
              </button>
            </form>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 lg:px-8">{children}</main>
    </div>
  );
}
