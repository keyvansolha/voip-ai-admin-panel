import { and, eq, lt, desc, sql, type SQL } from 'drizzle-orm';
import { db } from './db';
import { eventLogs, type LogLevel } from './db/schema';
import { nowSeconds } from './time';

/**
 * Per-call event log, written to SQLite so the admin panel can show exactly
 * what happened to a recording. Also mirrored to stdout so `docker logs` is
 * useful when the database itself is the thing that's broken.
 */

export type Stage = 'ingest' | 'parse' | 'ai' | 'push' | 'worker' | 'retention' | 'auth' | 'system';

/** Keys whose values must never reach the log table or stdout. */
const REDACT_KEYS = /(token|secret|api[-_]?key|password|private[-_]?key|authorization|credential)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redact(entry, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_KEYS.test(key) ? '[redacted]' : redact(entry, depth + 1);
  }
  return out;
}

export interface LogInput {
  callId?: number | null;
  level?: LogLevel;
  stage: Stage;
  message: string;
  meta?: Record<string, unknown>;
}

export function logEvent(input: LogInput): void {
  const level = input.level ?? 'info';
  const meta = input.meta ? JSON.stringify(redact(input.meta)) : null;

  try {
    db.insert(eventLogs)
      .values({
        callId: input.callId ?? null,
        level,
        stage: input.stage,
        message: input.message.slice(0, 4000),
        meta: meta && meta.length > 20_000 ? `${meta.slice(0, 20_000)}…` : meta,
      })
      .run();
  } catch (cause) {
    console.error('[logger] failed to persist event', cause);
  }

  const line = `[${input.stage}]${input.callId ? ` call=${input.callId}` : ''} ${input.message}`;
  if (level === 'error') console.error(line, input.meta ? redact(input.meta) : '');
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface LogQuery {
  callId?: number;
  level?: LogLevel;
  stage?: Stage;
  limit?: number;
  beforeId?: number;
}

export function queryLogs(query: LogQuery = {}) {
  const conditions: SQL[] = [];
  if (query.callId !== undefined) conditions.push(eq(eventLogs.callId, query.callId));
  if (query.level !== undefined) conditions.push(eq(eventLogs.level, query.level));
  if (query.stage !== undefined) conditions.push(eq(eventLogs.stage, query.stage));
  if (query.beforeId !== undefined) conditions.push(lt(eventLogs.id, query.beforeId));

  const base = db.select().from(eventLogs);
  const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;

  return filtered
    .orderBy(desc(eventLogs.id))
    .limit(Math.min(query.limit ?? 100, 500))
    .all();
}

/** Deletes log rows older than `days`. A value of 0 disables pruning. */
export function pruneLogs(days: number): number {
  if (days <= 0) return 0;
  const cutoff = nowSeconds() - days * 86_400;
  const result = db
    .delete(eventLogs)
    .where(lt(eventLogs.createdAt, cutoff))
    .run();
  return result.changes;
}

export function countLogsByLevel(sinceEpoch: number): Record<LogLevel, number> {
  const rows = db
    .select({ level: eventLogs.level, count: sql<number>`COUNT(*)` })
    .from(eventLogs)
    .where(sql`${eventLogs.createdAt} >= ${sinceEpoch}`)
    .groupBy(eventLogs.level)
    .all();

  const out: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const row of rows) out[row.level] = row.count;
  return out;
}
