import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Presentational building blocks shared by the admin pages. All server
 * components — nothing here needs client-side state.
 */

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          {title ? <h2 className="card-title">{title}</h2> : <span />}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'border-border-strong text-content-muted',
  ok: 'border-ok/40 bg-ok/10 text-ok',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  danger: 'border-danger/40 bg-danger/10 text-danger',
  accent: 'border-accent/40 bg-accent/10 text-accent',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${TONE_CLASSES[tone]}`}>{children}</span>;
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  const valueTone =
    tone === 'danger'
      ? 'text-danger'
      : tone === 'ok'
        ? 'text-ok'
        : tone === 'warn'
          ? 'text-warn'
          : 'text-content';

  return (
    <div className="card px-4 py-3">
      <div className="text-xs font-medium tracking-wide text-content-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${valueTone}`}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-content-faint">{hint}</div> : null}
    </div>
  );
}

/** Label/value row used throughout the call detail page. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border/60 py-2 last:border-b-0">
      <dt className="text-xs text-content-muted">{label}</dt>
      <dd className="text-sm break-words" dir="auto">
        {children}
      </dd>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-content-faint">{children}</p>;
}

export function Alert({
  tone = 'warn',
  title,
  children,
  action,
}: {
  tone?: Tone;
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  const border =
    tone === 'danger'
      ? 'border-danger/40 bg-danger/10'
      : tone === 'ok'
        ? 'border-ok/40 bg-ok/10'
        : tone === 'accent'
          ? 'border-accent/40 bg-accent/10'
          : 'border-warn/40 bg-warn/10';

  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${border}`}>
      {title ? <div className="mb-1 font-semibold">{title}</div> : null}
      <div className="text-content-muted">{children}</div>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-xs break-all ${className}`}>{children}</span>;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-content-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-sm text-accent hover:underline">
      ← {children}
    </Link>
  );
}

// --- Formatting helpers ----------------------------------------------------

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, '0')}` : `${rest}s`;
}
