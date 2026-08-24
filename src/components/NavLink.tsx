'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Sidebar link that highlights itself when the current route matches. */
export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`block rounded-md px-3 py-2 text-sm transition-colors ${
        active
          ? 'bg-accent/12 font-medium text-accent'
          : 'text-content-muted hover:bg-surface-sunken hover:text-content'
      }`}
    >
      {children}
    </Link>
  );
}
