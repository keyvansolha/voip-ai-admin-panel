import { and, desc, eq, gte, like, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { calls, eventLogs, type Call, type CallStatus } from '../db/schema';
import { nowSeconds } from '../time';

/** Read models for the admin pages. Nothing here mutates. */

export interface CallFilters {
  search?: string;
  direction?: string;
  status?: string;
  missed?: boolean;
  page?: number;
  perPage?: number;
}

export interface CallPage {
  rows: Call[];
  total: number;
  page: number;
  perPage: number;
  pageCount: number;
}

function buildConditions(filters: CallFilters): SQL[] {
  const conditions: SQL[] = [];

  const search = filters.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    const match = or(
      like(calls.filename, pattern),
      like(calls.customerPhone, pattern),
      like(calls.answeredBy, pattern),
      like(calls.productMention, pattern),
    );
    if (match) conditions.push(match);
  }

  if (filters.direction && filters.direction !== 'all') {
    conditions.push(eq(calls.direction, filters.direction));
  }
  if (filters.status && filters.status !== 'all') {
    conditions.push(eq(calls.status, filters.status as CallStatus));
  }
  if (filters.missed !== undefined) {
    conditions.push(eq(calls.missed, filters.missed));
  }

  return conditions;
}

export function listCalls(filters: CallFilters = {}): CallPage {
  const perPage = Math.min(Math.max(filters.perPage ?? 25, 1), 200);
  const page = Math.max(filters.page ?? 1, 1);
  const conditions = buildConditions(filters);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const totalRow = where
    ? db.select({ count: sql<number>`COUNT(*)` }).from(calls).where(where).all()[0]
    : db.select({ count: sql<number>`COUNT(*)` }).from(calls).all()[0];
  const total = totalRow?.count ?? 0;

  const base = db.select().from(calls);
  const filtered = where ? base.where(where) : base;

  const rows = filtered
    // Newest recording first, falling back to arrival order for unparsed names.
    .orderBy(desc(calls.recordingEpoch), desc(calls.id))
    .limit(perPage)
    .offset((page - 1) * perPage)
    .all();

  return { rows, total, page, perPage, pageCount: Math.max(1, Math.ceil(total / perPage)) };
}

export function getCall(id: number): Call | null {
  return db.select().from(calls).where(eq(calls.id, id)).limit(1).all()[0] ?? null;
}

export function getCallByIngestId(ingestId: string): Call | null {
  return db.select().from(calls).where(eq(calls.ingestId, ingestId)).limit(1).all()[0] ?? null;
}

export interface DashboardStats {
  total: number;
  today: number;
  completed: number;
  failed: number;
  processing: number;
  queued: number;
  missed: number;
  analysed: number;
  delivered: number;
}

export function dashboardStats(timezoneOffsetSeconds = 0): DashboardStats {
  const startOfTodayUtc =
    Math.floor((nowSeconds() + timezoneOffsetSeconds) / 86_400) * 86_400 - timezoneOffsetSeconds;

  const count = (where?: SQL): number => {
    const query = db.select({ count: sql<number>`COUNT(*)` }).from(calls);
    const row = where ? query.where(where).all()[0] : query.all()[0];
    return row?.count ?? 0;
  };

  return {
    total: count(),
    today: count(gte(calls.createdAt, startOfTodayUtc)),
    completed: count(eq(calls.status, 'completed')),
    failed: count(eq(calls.status, 'failed')),
    processing: count(eq(calls.status, 'processing')),
    queued: count(or(eq(calls.status, 'queued'), eq(calls.status, 'received'))!),
    missed: count(eq(calls.missed, true)),
    analysed: count(eq(calls.aiParseOk, true)),
    delivered: count(sql`${calls.remoteCallPushedAt} IS NOT NULL`),
  };
}

export function recentCalls(limit = 8): Call[] {
  return db.select().from(calls).orderBy(desc(calls.id)).limit(limit).all();
}

export function recentErrors(limit = 6) {
  return db
    .select()
    .from(eventLogs)
    .where(eq(eventLogs.level, 'error'))
    .orderBy(desc(eventLogs.id))
    .limit(limit)
    .all();
}

export const DELIVERY_OUTCOMES = [
  'call_and_transcript',
  'call_only_missed',
  'call_only_skipped',
  'call_only_transcript_pending',
  'failed_before_delivery',
  'not_delivered_yet',
] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

/**
 * What actually reached the downstream panel, bucketed by outcome.
 *
 * "The call is in the panel but the transcript isn't" has several very
 * different causes — a missed call with nothing to transcribe, an analysis that
 * never ran, a delivery that failed halfway — and the panel itself cannot tell
 * them apart. This splits them.
 */
export function deliveryBreakdown(): Array<{ outcome: DeliveryOutcome; count: number }> {
  return db
    .select({
      outcome: sql<DeliveryOutcome>`CASE
        WHEN ${calls.remoteCallPushedAt} IS NULL AND ${calls.status} = 'failed'
          THEN 'failed_before_delivery'
        WHEN ${calls.remoteCallPushedAt} IS NULL
          THEN 'not_delivered_yet'
        WHEN ${calls.remoteTranscriptPushedAt} IS NOT NULL
          THEN 'call_and_transcript'
        WHEN ${calls.missed} = 1
          THEN 'call_only_missed'
        WHEN ${calls.remoteTranscriptSkipReason} IS NOT NULL
          THEN 'call_only_skipped'
        ELSE 'call_only_transcript_pending'
      END`,
      count: sql<number>`COUNT(*)`,
    })
    .from(calls)
    .groupBy(sql`1`)
    .orderBy(sql`COUNT(*) DESC`)
    .all();
}

/** Topic distribution over the last `days`, for the dashboard summary. */
export function topTopics(days = 30, limit = 8): Array<{ topic: string; count: number }> {
  const since = nowSeconds() - days * 86_400;
  return db
    .select({ topic: sql<string>`COALESCE(${calls.topic}, 'unknown')`, count: sql<number>`COUNT(*)` })
    .from(calls)
    .where(and(gte(calls.createdAt, since), sql`${calls.topic} IS NOT NULL`))
    .groupBy(calls.topic)
    .orderBy(sql`COUNT(*) DESC`)
    .limit(limit)
    .all();
}
