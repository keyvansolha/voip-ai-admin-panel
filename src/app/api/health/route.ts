import { NextResponse } from 'next/server';
import { sqlite } from '@/lib/db';
import { queueStats } from '@/lib/queue';
import { workerStatus } from '@/lib/worker';

/**
 * Unauthenticated liveness probe for Docker and uptime monitoring.
 *
 * It reports whether the database answers and how deep the queue is, but no
 * configuration, no counts that reveal business volume beyond the queue, and
 * never any credentials.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  try {
    sqlite.prepare('SELECT 1').get();
  } catch (cause) {
    return NextResponse.json(
      { ok: false, error: cause instanceof Error ? cause.message : String(cause) },
      { status: 503 },
    );
  }

  const queue = queueStats();
  const worker = workerStatus();

  return NextResponse.json({
    ok: true,
    database: 'up',
    worker: { enabled: worker.enabled, running: worker.running, inFlight: worker.inFlight },
    queue: { pending: queue.pending, running: queue.running, failed: queue.failed },
  });
}
