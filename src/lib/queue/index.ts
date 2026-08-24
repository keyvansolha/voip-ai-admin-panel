import { and, eq, inArray, lte, sql, desc } from 'drizzle-orm';
import { db, sqlite } from '../db';
import { calls, jobs, type Job } from '../db/schema';
import { nowSeconds } from '../time';

/**
 * A SQLite-backed work queue.
 *
 * One store's call volume does not justify Redis or a separate broker, and
 * keeping the queue in the same file as the data means the whole deployment is
 * one container plus one volume. Claiming is done with a single conditional
 * UPDATE so two workers (or a worker and a manual retry) cannot take the same
 * job.
 */

/** Exponential backoff with a ceiling: 30s, 2m, 8m, 32m, then 1h. */
export function backoffSeconds(attempt: number): number {
  return Math.min(30 * 4 ** Math.max(0, attempt - 1), 3600);
}

export function enqueueCall(callId: number, options: { maxAttempts?: number; delaySeconds?: number } = {}): number {
  const inserted = db
    .insert(jobs)
    .values({
      callId,
      type: 'process_call',
      status: 'pending',
      maxAttempts: options.maxAttempts ?? 5,
      runAt: nowSeconds() + (options.delaySeconds ?? 0),
    })
    .returning({ id: jobs.id })
    .all();

  db.update(calls)
    .set({ status: 'queued', updatedAt: nowSeconds() })
    .where(eq(calls.id, callId))
    .run();

  return inserted[0]!.id;
}

/**
 * Atomically claims the oldest due job.
 *
 * `UPDATE … WHERE id = (SELECT …) AND status = 'pending'` is the whole locking
 * story: SQLite serialises writers, so exactly one caller can flip a given row
 * to 'running'.
 */
export function claimNextJob(workerId: string): Job | null {
  const claimed = sqlite
    .prepare(
      `UPDATE jobs
          SET status     = 'running',
              attempts   = attempts + 1,
              locked_at  = unixepoch(),
              locked_by  = ?,
              updated_at = unixepoch()
        WHERE id = (
              SELECT id FROM jobs
               WHERE status = 'pending' AND run_at <= unixepoch()
               ORDER BY run_at ASC, id ASC
               LIMIT 1
        )
          AND status = 'pending'
      RETURNING *`,
    )
    .get(workerId) as Record<string, unknown> | undefined;

  if (!claimed) return null;

  return db.select().from(jobs).where(eq(jobs.id, Number(claimed.id))).limit(1).all()[0] ?? null;
}

export function completeJob(jobId: number): void {
  db.update(jobs)
    .set({ status: 'completed', lastError: null, lockedAt: null, lockedBy: null, updatedAt: nowSeconds() })
    .where(eq(jobs.id, jobId))
    .run();
}

export interface FailJobOptions {
  retryable: boolean;
  error: string;
}

/** Returns true when the job was rescheduled, false when it is permanently failed. */
export function failJob(job: Job, options: FailJobOptions): boolean {
  const willRetry = options.retryable && job.attempts < job.maxAttempts;
  const message = options.error.slice(0, 4000);

  if (willRetry) {
    db.update(jobs)
      .set({
        status: 'pending',
        runAt: nowSeconds() + backoffSeconds(job.attempts),
        lastError: message,
        lockedAt: null,
        lockedBy: null,
        updatedAt: nowSeconds(),
      })
      .where(eq(jobs.id, job.id))
      .run();
    return true;
  }

  db.update(jobs)
    .set({
      status: 'failed',
      lastError: message,
      lockedAt: null,
      lockedBy: null,
      updatedAt: nowSeconds(),
    })
    .where(eq(jobs.id, job.id))
    .run();

  db.update(calls)
    .set({ status: 'failed', error: message, updatedAt: nowSeconds() })
    .where(eq(calls.id, job.callId))
    .run();

  return false;
}

/**
 * Releases jobs whose worker died mid-run.
 *
 * A 'running' row with an old lock means the process was killed (a redeploy, an
 * OOM) rather than that the job is slow, so it goes back on the queue.
 */
export function requeueStaleJobs(staleAfterSeconds: number): number {
  const cutoff = nowSeconds() - staleAfterSeconds;
  const result = sqlite
    .prepare(
      `UPDATE jobs
          SET status     = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
              run_at     = unixepoch(),
              locked_at  = NULL,
              locked_by  = NULL,
              last_error = COALESCE(last_error, 'worker stopped before the job finished'),
              updated_at = unixepoch()
        WHERE status = 'running' AND locked_at IS NOT NULL AND locked_at < ?`,
    )
    .run(cutoff);
  return result.changes;
}

export function cancelJobsForCall(callId: number): number {
  const result = db
    .update(jobs)
    .set({ status: 'cancelled', updatedAt: nowSeconds() })
    .where(and(eq(jobs.callId, callId), inArray(jobs.status, ['pending', 'running'])))
    .run();
  return result.changes;
}

export function listJobsForCall(callId: number): Job[] {
  return db.select().from(jobs).where(eq(jobs.callId, callId)).orderBy(desc(jobs.id)).all();
}

export interface QueueStats {
  pending: number;
  running: number;
  failed: number;
  completed: number;
  /** Pending jobs whose runAt is in the future (waiting out a backoff). */
  scheduled: number;
}

export function queueStats(): QueueStats {
  const rows = db
    .select({ status: jobs.status, count: sql<number>`COUNT(*)` })
    .from(jobs)
    .groupBy(jobs.status)
    .all();

  const stats: QueueStats = { pending: 0, running: 0, failed: 0, completed: 0, scheduled: 0 };
  for (const row of rows) {
    if (row.status in stats) stats[row.status as keyof QueueStats] = row.count;
  }

  const scheduled = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(jobs)
    .where(and(eq(jobs.status, 'pending'), sql`${jobs.runAt} > unixepoch()`))
    .all()[0];

  stats.scheduled = scheduled?.count ?? 0;
  return stats;
}

/** Puts every permanently-failed job back on the queue. Used by the panel's "Retry all". */
export function retryFailedJobs(): number {
  const failed = db
    .select({ id: jobs.id, callId: jobs.callId })
    .from(jobs)
    .where(eq(jobs.status, 'failed'))
    .all();

  if (failed.length === 0) return 0;

  db.transaction(() => {
    for (const job of failed) {
      db.update(jobs)
        .set({ status: 'pending', attempts: 0, runAt: nowSeconds(), updatedAt: nowSeconds() })
        .where(eq(jobs.id, job.id))
        .run();
      db.update(calls)
        .set({ status: 'queued', error: null, updatedAt: nowSeconds() })
        .where(eq(calls.id, job.callId))
        .run();
    }
  });

  return failed.length;
}

/** Trims completed job rows so the table does not grow without bound. */
export function pruneJobs(days: number): number {
  if (days <= 0) return 0;
  const cutoff = nowSeconds() - days * 86_400;
  const result = db
    .delete(jobs)
    .where(and(eq(jobs.status, 'completed'), lte(jobs.updatedAt, cutoff)))
    .run();
  return result.changes;
}
