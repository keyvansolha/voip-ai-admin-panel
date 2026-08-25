import { notFound } from 'next/navigation';
import { getTranslator } from '@/lib/i18n';
import { getSettings } from '@/lib/settings';
import { getCall } from '@/lib/calls/queries';
import { queryLogs } from '@/lib/logger';
import { listJobsForCall } from '@/lib/queue';
import { formatLocalDisplay } from '@/lib/time';
import { reprocessCallAction } from '@/app/actions/calls';
import {
  Alert,
  BackLink,
  Badge,
  Card,
  Empty,
  Field,
  Mono,
  PageHeader,
  formatBytes,
  formatDuration,
} from '@/components/ui';
import { CallStatusBadge, DirectionBadge } from '@/components/CallBadges';

export const dynamic = 'force-dynamic';

export default async function CallDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ queued?: string }>;
}) {
  const { t } = await getTranslator();
  const { id } = await params;
  const { queued } = await searchParams;

  const call = getCall(Number(id));
  if (!call) notFound();

  const timezone = getSettings()['ui.displayTimezone'];
  const logs = queryLogs({ callId: call.id, limit: 100 });
  const jobs = listJobsForCall(call.id);

  const recordingAvailable = call.storedPath !== null && call.recordingDeletedAt === null;

  return (
    <>
      <div className="mb-3">
        <BackLink href="/calls">{t('call.back')}</BackLink>
      </div>

      <PageHeader
        title={`${t('call.title')} #${call.id}`}
        description={
          <span className="font-mono text-xs break-all" dir="ltr">
            {call.filename}
          </span>
        }
        actions={
          <>
            <CallStatusBadge status={call.status} t={t} />
            <DirectionBadge direction={call.direction} missed={call.missed} t={t} />
          </>
        }
      />

      {queued ? (
        <div className="mb-4">
          <Alert tone="accent">{t('status.queued')}</Alert>
        </div>
      ) : null}

      {call.error ? (
        <div className="mb-4">
          <Alert tone="danger" title={t('common.error')}>
            <span dir="auto">{call.error}</span>
          </Alert>
        </div>
      ) : null}

      {!call.parseOk ? (
        <div className="mb-4">
          <Alert tone="warn">
            The filename does not match the Asterisk recording pattern, so direction and recording
            time are unknown and the call cannot be delivered to the panel.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="space-y-4">
          <Card title={t('call.section.recording')}>
            <div className="space-y-3 p-4">
              {recordingAvailable ? (
                <audio
                  controls
                  preload="none"
                  src={`/api/recordings/${call.id}`}
                  className="w-full"
                />
              ) : (
                <p className="text-sm text-content-faint">{t('call.noRecording')}</p>
              )}

              <dl>
                <Field label={t('calls.column.time')}>
                  {call.recordingLocalIso ?? formatLocalDisplay(call.createdAt, timezone)}
                </Field>
                <Field label={t('calls.column.duration')}>{formatDuration(call.durationSec)}</Field>
                <Field label={t('call.field.fileSize')}>{formatBytes(call.fileSizeBytes)}</Field>
                <Field label={t('call.field.audioBytes')}>{formatBytes(call.audioDataBytes)}</Field>
                <Field label={t('call.field.validWav')}>
                  {call.validWav ? t('common.yes') : t('common.no')}
                </Field>
                {call.missed ? (
                  <Field label={t('call.field.missedReason')}>
                    <Badge tone="warn">{call.missedReason ?? '—'}</Badge>
                  </Field>
                ) : null}
              </dl>
            </div>
          </Card>

          <Card title={t('call.section.metadata')}>
            <dl className="p-4">
              <Field label={t('calls.column.phone')}>
                <span dir="ltr" className="font-mono text-xs">
                  {call.customerPhone ?? '—'}
                </span>
              </Field>
              <Field label={t('call.field.astType')}>{call.astType ?? '—'}</Field>
              <Field label={t('call.field.astSeq')}>
                {call.astUniqueSeq !== null ? `${call.astUid}.${call.astUniqueSeq}` : '—'}
              </Field>
              <Field label={t('call.field.ingestId')}>
                <Mono>{call.ingestId}</Mono>
              </Field>
            </dl>
          </Card>

          <Card title={t('call.section.delivery')}>
            <dl className="p-4">
              <Field label={t('call.field.remoteCallId')}>{call.remoteCallId ?? '—'}</Field>
              <Field label={t('call.field.pushedAt')}>
                {call.remoteCallPushedAt
                  ? formatLocalDisplay(call.remoteCallPushedAt, timezone)
                  : '—'}
              </Field>
              <Field label={t('call.field.transcriptPushedAt')}>
                {call.remoteTranscriptPushedAt
                  ? formatLocalDisplay(call.remoteTranscriptPushedAt, timezone)
                  : '—'}
              </Field>
              {!call.remoteTranscriptPushedAt && call.remoteTranscriptSkipReason ? (
                <Field label={t('call.field.transcriptSkipped')}>
                  <span className="text-content-muted">{call.remoteTranscriptSkipReason}</span>
                </Field>
              ) : null}
              {call.remoteError ? (
                <Field label={t('common.error')}>
                  <span className="text-danger">{call.remoteError}</span>
                </Field>
              ) : null}
            </dl>

            <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
              <form action={reprocessCallAction}>
                <input type="hidden" name="callId" value={call.id} />
                <input type="hidden" name="redoAnalysis" value="on" />
                <button type="submit" className="btn btn-sm" disabled={!recordingAvailable}>
                  {t('call.reprocess')}
                </button>
              </form>
              <form action={reprocessCallAction}>
                <input type="hidden" name="callId" value={call.id} />
                <button type="submit" className="btn btn-sm">
                  {t('call.retryPush')}
                </button>
              </form>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title={t('call.section.analysis')}>
            <dl className="p-4">
              <Field label={t('call.field.topic')}>{call.topic ?? '—'}</Field>
              <Field label={t('call.field.gender')}>{call.genderLabel ?? '—'}</Field>
              <Field label={t('call.field.emotion')}>{call.emotionLabel ?? '—'}</Field>
              <Field label={t('call.field.answeredBy')}>{call.answeredBy ?? '—'}</Field>
              <Field label={t('call.field.product')}>{call.productMention ?? '—'}</Field>
              <Field label={t('call.field.model')}>{call.aiModel ?? '—'}</Field>
              <Field label={t('call.field.provider')}>{call.aiProvider ?? '—'}</Field>
              <Field label={t('call.field.prompt')}>
                {call.aiPromptKey ? `${call.aiPromptKey} v${call.aiPromptVersion}` : '—'}
              </Field>
              <Field label={t('call.field.latency')}>
                {call.aiLatencyMs !== null ? `${call.aiLatencyMs} ms` : '—'}
              </Field>
              <Field label={t('call.field.tokens')}>
                {call.aiInputTokens !== null || call.aiOutputTokens !== null
                  ? `${call.aiInputTokens ?? '?'} / ${call.aiOutputTokens ?? '?'}`
                  : '—'}
              </Field>
              <Field label={t('call.field.sentBytes')}>
                {call.aiAudioBytes !== null
                  ? `${formatBytes(call.aiAudioBytes)} (${call.aiAudioMime})`
                  : '—'}
              </Field>
            </dl>
          </Card>

          <Card title={t('call.section.transcript')}>
            {call.transcriptText ? (
              <pre
                dir="auto"
                className="max-h-[32rem] overflow-auto px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap"
              >
                {call.transcriptText}
              </pre>
            ) : (
              <Empty>{t('call.noTranscript')}</Empty>
            )}
          </Card>

          {call.aiRawText ? (
            <Card title={t('call.section.raw')}>
              <details>
                <summary className="cursor-pointer px-4 py-2 text-xs text-content-muted hover:text-accent">
                  {call.aiParseOk === false ? `⚠ ${call.aiParseError}` : 'JSON'}
                </summary>
                <pre className="max-h-96 overflow-auto px-4 py-3 font-mono text-xs whitespace-pre-wrap">
                  {call.aiRawText}
                </pre>
              </details>
            </Card>
          ) : null}

          <Card title={t('call.section.timeline')}>
            {logs.length === 0 ? (
              <Empty>{t('logs.empty')}</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {logs.map((entry) => (
                  <li key={entry.id} className="px-4 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2 text-content-faint">
                      <span>{formatLocalDisplay(entry.createdAt, timezone)}</span>
                      <Badge
                        tone={
                          entry.level === 'error'
                            ? 'danger'
                            : entry.level === 'warn'
                              ? 'warn'
                              : 'neutral'
                        }
                      >
                        {entry.stage}
                      </Badge>
                    </div>
                    <p className="mt-1 text-content-muted" dir="auto">
                      {entry.message}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {jobs.length > 0 ? (
            <Card title={t('call.section.jobs')}>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t('calls.column.status')}</th>
                      <th>Attempts</th>
                      <th>{t('common.error')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((job) => (
                      <tr key={job.id}>
                        <td className="tabular-nums">{job.id}</td>
                        <td>
                          <Badge
                            tone={
                              job.status === 'failed'
                                ? 'danger'
                                : job.status === 'completed'
                                  ? 'ok'
                                  : 'accent'
                            }
                          >
                            {job.status}
                          </Badge>
                        </td>
                        <td className="tabular-nums">
                          {job.attempts}/{job.maxAttempts}
                        </td>
                        <td className="max-w-md text-xs text-content-muted" dir="auto">
                          {job.lastError ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
