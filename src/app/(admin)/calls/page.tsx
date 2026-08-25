import Link from 'next/link';
import { getTranslator } from '@/lib/i18n';
import { getSettings } from '@/lib/settings';
import { listCalls } from '@/lib/calls/queries';
import { formatLocalDisplay } from '@/lib/time';
import { Card, Empty, PageHeader, formatDuration } from '@/components/ui';
import { CallStatusBadge, DeliveryBadge, DirectionBadge } from '@/components/CallBadges';

export const dynamic = 'force-dynamic';

const DIRECTIONS = ['all', 'inbound', 'outbound', 'internal'] as const;
const STATUSES = ['all', 'received', 'queued', 'processing', 'completed', 'failed'] as const;

interface SearchParams {
  q?: string;
  direction?: string;
  status?: string;
  page?: string;
}

function buildHref(params: SearchParams, overrides: Partial<SearchParams>): string {
  const merged = { ...params, ...overrides };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value && value !== 'all') query.set(key, value);
  }
  const search = query.toString();
  return search ? `/calls?${search}` : '/calls';
}

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { t } = await getTranslator();
  const params = await searchParams;
  const timezone = getSettings()['ui.displayTimezone'];

  const result = listCalls({
    search: params.q,
    direction: params.direction,
    status: params.status,
    page: Number(params.page) || 1,
    perPage: 25,
  });

  return (
    <>
      <PageHeader
        title={t('calls.title')}
        description={`${result.total} ${t('calls.title').toLowerCase()}`}
      />

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <label className="min-w-[16rem] flex-1">
          <span className="field-label">{t('calls.search')}</span>
          <input name="q" defaultValue={params.q ?? ''} className="input" dir="auto" />
        </label>

        <label>
          <span className="field-label">{t('calls.filter.direction')}</span>
          <select name="direction" defaultValue={params.direction ?? 'all'} className="input">
            {DIRECTIONS.map((value) => (
              <option key={value} value={value}>
                {value === 'all'
                  ? t('calls.filter.all')
                  : t(`direction.${value}` as 'direction.inbound')}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="field-label">{t('calls.filter.status')}</span>
          <select name="status" defaultValue={params.status ?? 'all'} className="input">
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value === 'all' ? t('calls.filter.all') : t(`status.${value}` as 'status.queued')}
              </option>
            ))}
          </select>
        </label>

        <button type="submit" className="btn">
          {t('calls.filter.apply')}
        </button>
        <Link href="/calls" className="btn btn-sm">
          {t('calls.filter.reset')}
        </Link>
      </form>

      <Card>
        {result.rows.length === 0 ? (
          <Empty>{t('calls.empty')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('calls.column.time')}</th>
                  <th>{t('calls.column.direction')}</th>
                  <th>{t('calls.column.phone')}</th>
                  <th>{t('calls.column.duration')}</th>
                  <th>{t('calls.column.topic')}</th>
                  <th>{t('calls.column.status')}</th>
                  <th>{t('calls.column.pushed')}</th>
                  <th>{t('calls.column.filename')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((call) => (
                  <tr key={call.id}>
                    <td className="whitespace-nowrap">
                      <Link href={`/calls/${call.id}`} className="text-accent hover:underline">
                        {call.recordingEpoch
                          ? formatLocalDisplay(call.recordingEpoch, timezone)
                          : formatLocalDisplay(call.createdAt, timezone)}
                      </Link>
                    </td>
                    <td>
                      <DirectionBadge direction={call.direction} missed={call.missed} t={t} />
                    </td>
                    <td dir="ltr" className="font-mono text-xs whitespace-nowrap">
                      {call.customerPhone ?? '—'}
                    </td>
                    <td className="tabular-nums whitespace-nowrap">
                      {formatDuration(call.durationSec)}
                    </td>
                    <td dir="auto" className="max-w-[12rem] truncate">
                      {call.topic ?? '—'}
                    </td>
                    <td>
                      <CallStatusBadge status={call.status} t={t} />
                    </td>
                    <td>
                      <DeliveryBadge
                        callPushedAt={call.remoteCallPushedAt}
                        transcriptPushedAt={call.remoteTranscriptPushedAt}
                        skipReason={call.remoteTranscriptSkipReason}
                      />
                    </td>
                    <td className="max-w-[18rem] truncate font-mono text-xs" dir="ltr">
                      {call.filename}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {result.pageCount > 1 ? (
        <nav className="mt-4 flex items-center justify-between text-sm">
          <span className="text-content-muted">
            {t('common.page')} {result.page} {t('common.of')} {result.pageCount}
          </span>
          <div className="flex gap-2">
            {result.page > 1 ? (
              <Link href={buildHref(params, { page: String(result.page - 1) })} className="btn btn-sm">
                {t('common.previous')}
              </Link>
            ) : null}
            {result.page < result.pageCount ? (
              <Link href={buildHref(params, { page: String(result.page + 1) })} className="btn btn-sm">
                {t('common.next')}
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </>
  );
}
