import { Badge, type Tone } from './ui';
import type { Translator } from '@/lib/i18n';
import type { CallStatus } from '@/lib/db/schema';

/**
 * Status and direction chips. The translator is passed in rather than resolved
 * here so these stay synchronous and usable inside table rows.
 */

const STATUS_TONES: Record<CallStatus, Tone> = {
  received: 'neutral',
  queued: 'accent',
  processing: 'accent',
  completed: 'ok',
  failed: 'danger',
};

const STATUS_KEYS = {
  received: 'status.received',
  queued: 'status.queued',
  processing: 'status.processing',
  completed: 'status.completed',
  failed: 'status.failed',
} as const;

export function CallStatusBadge({ status, t }: { status: CallStatus; t: Translator }) {
  return <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{t(STATUS_KEYS[status])}</Badge>;
}

const DIRECTION_KEYS = {
  inbound: 'direction.inbound',
  outbound: 'direction.outbound',
  internal: 'direction.internal',
} as const;

export function DirectionBadge({
  direction,
  missed,
  t,
}: {
  direction: string | null;
  missed?: boolean;
  t: Translator;
}) {
  const key = direction && direction in DIRECTION_KEYS
    ? DIRECTION_KEYS[direction as keyof typeof DIRECTION_KEYS]
    : 'direction.unknown';

  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge tone={direction ? 'neutral' : 'warn'}>{t(key)}</Badge>
      {missed ? <Badge tone="warn">{t('common.missed')}</Badge> : null}
    </span>
  );
}

/** Two ticks: was the call row delivered, was the transcript delivered. */
export function DeliveryBadge({
  callPushedAt,
  transcriptPushedAt,
  hasTranscript,
}: {
  callPushedAt: number | null;
  transcriptPushedAt: number | null;
  hasTranscript: boolean;
}) {
  if (!callPushedAt) return <Badge tone="neutral">—</Badge>;
  if (!hasTranscript) return <Badge tone="ok">call</Badge>;
  return transcriptPushedAt ? (
    <Badge tone="ok">call + transcript</Badge>
  ) : (
    <Badge tone="warn">call only</Badge>
  );
}
