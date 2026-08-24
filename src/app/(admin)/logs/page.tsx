import Link from 'next/link';
import { getTranslator } from '@/lib/i18n';
import { getSettings } from '@/lib/settings';
import { queryLogs } from '@/lib/logger';
import { LOG_LEVELS, type LogLevel } from '@/lib/db/schema';
import { formatLocalDisplay } from '@/lib/time';
import { Badge, Card, Empty, PageHeader, type Tone } from '@/components/ui';

export const dynamic = 'force-dynamic';

const STAGES = ['ingest', 'parse', 'ai', 'push', 'worker', 'retention', 'auth', 'system'] as const;

const LEVEL_TONES: Record<LogLevel, Tone> = {
  debug: 'neutral',
  info: 'neutral',
  warn: 'warn',
  error: 'danger',
};

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ level?: string; stage?: string; before?: string }>;
}) {
  const { t } = await getTranslator();
  const params = await searchParams;
  const timezone = getSettings()['ui.displayTimezone'];

  const level = (LOG_LEVELS as readonly string[]).includes(params.level ?? '')
    ? (params.level as LogLevel)
    : undefined;
  const stage = (STAGES as readonly string[]).includes(params.stage ?? '')
    ? (params.stage as (typeof STAGES)[number])
    : undefined;

  const entries = queryLogs({
    level,
    stage,
    beforeId: params.before ? Number(params.before) : undefined,
    limit: 150,
  });

  const oldest = entries.at(-1);
  const nextHref = oldest
    ? `/logs?${new URLSearchParams({
        ...(level ? { level } : {}),
        ...(stage ? { stage } : {}),
        before: String(oldest.id),
      })}`
    : null;

  return (
    <>
      <PageHeader title={t('logs.title')} />

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <label>
          <span className="field-label">{t('logs.filter.level')}</span>
          <select name="level" defaultValue={level ?? ''} className="input">
            <option value="">{t('calls.filter.all')}</option>
            {LOG_LEVELS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="field-label">{t('logs.filter.stage')}</span>
          <select name="stage" defaultValue={stage ?? ''} className="input">
            <option value="">{t('calls.filter.all')}</option>
            {STAGES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <button type="submit" className="btn">
          {t('calls.filter.apply')}
        </button>
        <Link href="/logs" className="btn btn-sm">
          {t('calls.filter.reset')}
        </Link>
      </form>

      <Card>
        {entries.length === 0 ? (
          <Empty>{t('logs.empty')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('logs.column.time')}</th>
                  <th>{t('logs.column.level')}</th>
                  <th>{t('logs.column.stage')}</th>
                  <th>{t('logs.column.call')}</th>
                  <th>{t('logs.column.message')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="whitespace-nowrap tabular-nums">
                      {formatLocalDisplay(entry.createdAt, timezone)}
                    </td>
                    <td>
                      <Badge tone={LEVEL_TONES[entry.level]}>{entry.level}</Badge>
                    </td>
                    <td className="whitespace-nowrap">{entry.stage}</td>
                    <td>
                      {entry.callId ? (
                        <Link
                          href={`/calls/${entry.callId}`}
                          className="text-accent hover:underline"
                        >
                          #{entry.callId}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td dir="auto" className="max-w-[48rem]">
                      <span>{entry.message}</span>
                      {entry.meta ? (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-xs text-content-faint">
                            meta
                          </summary>
                          <pre className="mt-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap">
                            {entry.meta}
                          </pre>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {nextHref && entries.length >= 150 ? (
        <div className="mt-4">
          <Link href={nextHref} className="btn btn-sm">
            {t('common.next')}
          </Link>
        </div>
      ) : null}
    </>
  );
}
