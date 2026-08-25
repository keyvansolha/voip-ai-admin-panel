import Link from 'next/link';
import { getTranslator } from '@/lib/i18n';
import { getSettings } from '@/lib/settings';
import {
  dashboardStats,
  deliveryBreakdown,
  recentCalls,
  recentErrors,
  topTopics,
} from '@/lib/calls/queries';
import { queueStats } from '@/lib/queue';
import { workerStatus } from '@/lib/worker';
import { totalRecordingBytes } from '@/lib/storage/recordings';
import { formatLocalDisplay, offsetMinutesAt } from '@/lib/time';
import { retryAllFailedAction } from '@/app/actions/calls';
import { Alert, Badge, Card, Empty, PageHeader, Stat, formatBytes } from '@/components/ui';
import { CallStatusBadge, DirectionBadge } from '@/components/CallBadges';

export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ retried?: string }>;
}) {
  const { t } = await getTranslator();
  const { retried } = await searchParams;
  const settings = getSettings();
  const timezone = settings['ui.displayTimezone'];

  const stats = dashboardStats(offsetMinutesAt(Date.now(), timezone) * 60);
  const queue = queueStats();
  const worker = workerStatus();
  const delivery = deliveryBreakdown();
  const [storageBytes, calls, errors, topics] = await Promise.all([
    totalRecordingBytes(),
    Promise.resolve(recentCalls(8)),
    Promise.resolve(recentErrors(6)),
    Promise.resolve(topTopics(30, 6)),
  ]);

  const aiConfigured =
    !settings['ai.enabled'] ||
    (settings['ai.provider'] === 'gemini_api'
      ? settings['ai.apiKey'].length > 0
      : settings['ai.vertexProject'].length > 0);
  const panelConfigured = !settings['panel.enabled'] || settings['panel.apiToken'].length > 0;

  const workerLabel = !worker.enabled
    ? t('dashboard.worker.disabled')
    : worker.running
      ? t('dashboard.worker.running')
      : t('dashboard.worker.stopped');

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        actions={
          stats.failed > 0 ? (
            <form action={retryAllFailedAction}>
              <button type="submit" className="btn btn-sm">
                {t('dashboard.retryAll')}
              </button>
            </form>
          ) : null
        }
      />

      {retried ? (
        <div className="mb-4">
          <Alert tone="ok">{`${retried} job(s) requeued.`}</Alert>
        </div>
      ) : null}

      {(!aiConfigured || !panelConfigured) && (
        <div className="mb-6 space-y-2">
          <Alert
            tone="warn"
            title={t('dashboard.setup.title')}
            action={
              <Link href="/settings" className="btn btn-sm">
                {t('dashboard.setup.link')}
              </Link>
            }
          >
            <ul className="list-inside list-disc space-y-1">
              {!aiConfigured ? <li>{t('dashboard.setup.ai')}</li> : null}
              {!panelConfigured ? <li>{t('dashboard.setup.panel')}</li> : null}
            </ul>
          </Alert>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t('dashboard.totalCalls')} value={stats.total} hint={`${stats.today} ${t('dashboard.today').toLowerCase()}`} />
        <Stat label={t('dashboard.completed')} value={stats.completed} tone="ok" />
        <Stat
          label={t('dashboard.failed')}
          value={stats.failed}
          tone={stats.failed > 0 ? 'danger' : 'neutral'}
        />
        <Stat
          label={t('dashboard.queued')}
          value={queue.pending + queue.running}
          hint={queue.scheduled > 0 ? `${queue.scheduled} waiting on backoff` : undefined}
          tone={queue.pending + queue.running > 0 ? 'accent' : 'neutral'}
        />
        <Stat label={t('dashboard.missed')} value={stats.missed} />
        <Stat label={t('dashboard.analysed')} value={stats.analysed} />
        <Stat label={t('dashboard.storage')} value={formatBytes(storageBytes)} />
        <Stat
          label={t('dashboard.worker')}
          value={<span className="text-base">{workerLabel}</span>}
          hint={worker.inFlight > 0 ? `${worker.inFlight} in flight` : undefined}
          tone={worker.enabled && worker.running ? 'ok' : 'warn'}
        />
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card
          title={t('dashboard.recentCalls')}
          actions={
            <Link href="/calls" className="text-xs text-accent hover:underline">
              {t('nav.calls')} →
            </Link>
          }
        >
          {calls.length === 0 ? (
            <Empty>{t('calls.empty')}</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('calls.column.time')}</th>
                    <th>{t('calls.column.direction')}</th>
                    <th>{t('calls.column.phone')}</th>
                    <th>{t('calls.column.topic')}</th>
                    <th>{t('calls.column.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.map((call) => (
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
                      <td dir="ltr" className="font-mono text-xs">
                        {call.customerPhone ?? '—'}
                      </td>
                      <td dir="auto">{call.topic ?? '—'}</td>
                      <td>
                        <CallStatusBadge status={call.status} t={t} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          {delivery.length > 0 ? (
            <Card title={t('delivery.title')}>
              <ul className="divide-y divide-border">
                {delivery.map((row) => {
                  const problem =
                    row.outcome === 'call_only_transcript_pending' ||
                    row.outcome === 'failed_before_delivery';
                  return (
                    <li
                      key={row.outcome}
                      className="flex items-start justify-between gap-3 px-4 py-2 text-sm"
                    >
                      <span className={problem ? 'text-warn' : 'text-content-muted'}>
                        {t(`delivery.${row.outcome}` as 'delivery.call_and_transcript')}
                      </span>
                      <span className="shrink-0 tabular-nums">{row.count}</span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}

          <Card title={t('dashboard.recentErrors')}>
            {errors.length === 0 ? (
              <Empty>{t('dashboard.noErrors')}</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {errors.map((entry) => (
                  <li key={entry.id} className="px-4 py-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2 text-content-faint">
                      <span>{formatLocalDisplay(entry.createdAt, timezone)}</span>
                      <Badge tone="danger">{entry.stage}</Badge>
                    </div>
                    <p className="mt-1 text-content-muted" dir="auto">
                      {entry.callId ? (
                        <Link href={`/calls/${entry.callId}`} className="text-accent hover:underline">
                          #{entry.callId}
                        </Link>
                      ) : null}{' '}
                      {entry.message}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {topics.length > 0 ? (
            <Card title={`${t('call.field.topic')} · 30d`}>
              <ul className="divide-y divide-border">
                {topics.map((row) => (
                  <li
                    key={row.topic}
                    className="flex items-center justify-between px-4 py-2 text-sm"
                  >
                    <span dir="auto" className="truncate">
                      {row.topic}
                    </span>
                    <span className="tabular-nums text-content-muted">{row.count}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
