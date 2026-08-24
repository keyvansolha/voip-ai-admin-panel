import { randomUUID } from 'node:crypto';
import { env } from '../env';
import { logEvent } from '../logger';
import { getSettings } from '../settings';
import { processCall, PipelineError } from '../pipeline/process';
import { claimNextJob, completeJob, failJob, pruneJobs, requeueStaleJobs } from '../queue';
import { pruneLogs } from '../logger';
import { cleanEmptyDirectories, pruneRecordings } from '../storage/recordings';
import { nowSeconds } from '../time';

/**
 * In-process background worker.
 *
 * It runs inside the Next.js server (started from `instrumentation.ts`) rather
 * than as a second container, which keeps the deployment to one image. Set
 * WORKER_ENABLED=false to run a UI-only replica.
 *
 * A job that is claimed but never finished — because the process was killed
 * mid-call — is released by the stale-lock sweep on the next boot.
 */

const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;
/** A single Gemini call can legitimately take minutes; only reclaim well past that. */
const STALE_LOCK_SECONDS = 45 * 60;
const MAINTENANCE_INTERVAL_SECONDS = 3600;

interface WorkerState {
  running: boolean;
  stopping: boolean;
  inFlight: number;
  lastMaintenanceAt: number;
  timer: NodeJS.Timeout | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __voipWorker: WorkerState | undefined;
}

const state: WorkerState = (globalThis.__voipWorker ??= {
  running: false,
  stopping: false,
  inFlight: 0,
  lastMaintenanceAt: 0,
  timer: null,
});

async function runOneJob(): Promise<boolean> {
  const job = claimNextJob(WORKER_ID);
  if (!job) return false;

  state.inFlight += 1;
  try {
    await processCall(job.callId);
    completeJob(job.id);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const stage = cause instanceof PipelineError ? cause.stage : 'system';
    // An unrecognised error is assumed transient, but any error that states its
    // own retryability — PipelineError, PanelError, AiRequestError — is trusted,
    // so a misconfiguration is not retried five times for nothing.
    const declared = (cause as { retryable?: unknown } | null)?.retryable;
    const retryable = typeof declared === 'boolean' ? declared : true;

    const rescheduled = failJob(job, { retryable, error: message });

    logEvent({
      callId: job.callId,
      stage: stage === 'system' ? 'worker' : stage,
      level: rescheduled ? 'warn' : 'error',
      message: rescheduled
        ? `Attempt ${job.attempts}/${job.maxAttempts} failed, will retry: ${message}`
        : `Giving up after ${job.attempts} attempt(s): ${message}`,
    });
  } finally {
    state.inFlight -= 1;
  }

  return true;
}

async function runMaintenance(): Promise<void> {
  const settings = getSettings();

  const requeued = requeueStaleJobs(STALE_LOCK_SECONDS);
  if (requeued > 0) {
    logEvent({
      stage: 'worker',
      level: 'warn',
      message: `Released ${requeued} job(s) whose worker stopped mid-run.`,
    });
  }

  try {
    const pruned = await pruneRecordings(settings['retention.recordingDays']);
    if (pruned.deleted > 0) {
      await cleanEmptyDirectories();
      logEvent({
        stage: 'retention',
        message: `Deleted ${pruned.deleted} recording(s) older than ${settings['retention.recordingDays']} days, freeing ${Math.round(pruned.freedBytes / 1024 / 1024)} MB.`,
        meta: { errors: pruned.errors },
      });
    }
  } catch (cause) {
    logEvent({
      stage: 'retention',
      level: 'error',
      message: `Recording retention failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  const prunedJobs = pruneJobs(14);
  const prunedLogs = pruneLogs(settings['retention.logDays']);
  if (prunedJobs > 0 || prunedLogs > 0) {
    logEvent({
      stage: 'retention',
      level: 'debug',
      message: `Pruned ${prunedJobs} completed job row(s) and ${prunedLogs} log row(s).`,
    });
  }

  state.lastMaintenanceAt = nowSeconds();
}

async function tick(): Promise<void> {
  if (state.stopping) return;

  try {
    if (nowSeconds() - state.lastMaintenanceAt >= MAINTENANCE_INTERVAL_SECONDS) {
      await runMaintenance();
    }

    // Fill up to the concurrency limit, then let the loop breathe.
    const slots = Math.max(0, env.workerConcurrency - state.inFlight);
    const running: Promise<boolean>[] = [];
    for (let i = 0; i < slots; i += 1) running.push(runOneJob());

    const results = await Promise.all(running);
    const didWork = results.some(Boolean);

    if (didWork && !state.stopping) {
      // More work is likely queued; come back immediately instead of sleeping.
      queueMicrotask(() => void tick());
      return;
    }
  } catch (cause) {
    logEvent({
      stage: 'worker',
      level: 'error',
      message: `Worker loop error: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  if (state.stopping) return;
  const interval = getSettings()['worker.pollIntervalMs'];
  state.timer = setTimeout(() => void tick(), interval);
  state.timer.unref?.();
}

export function startWorker(): void {
  if (state.running) return;
  if (!env.workerEnabled) {
    console.log('[worker] disabled by WORKER_ENABLED=false');
    return;
  }

  state.running = true;
  state.stopping = false;

  logEvent({
    stage: 'worker',
    message: `Worker ${WORKER_ID} started (concurrency ${env.workerConcurrency}).`,
  });

  // Anything left 'running' from a previous process is stranded; free it now.
  const released = requeueStaleJobs(0);
  if (released > 0) {
    logEvent({
      stage: 'worker',
      level: 'warn',
      message: `Requeued ${released} job(s) left running by a previous process.`,
    });
  }

  void tick();
}

export function stopWorker(): void {
  state.stopping = true;
  state.running = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

export function workerStatus(): { enabled: boolean; running: boolean; inFlight: number; id: string } {
  return {
    enabled: env.workerEnabled,
    running: state.running,
    inFlight: state.inFlight,
    id: WORKER_ID,
  };
}
