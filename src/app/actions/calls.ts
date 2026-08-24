'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { reprocessCall } from '@/lib/ingest/receive';
import { retryFailedJobs } from '@/lib/queue';
import { logEvent } from '@/lib/logger';

export async function reprocessCallAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  const callId = Number(formData.get('callId'));
  if (!Number.isInteger(callId)) redirect('/calls');

  // "Re-run analysis" calls Gemini again (what you want after a prompt edit);
  // "Retry delivery" only re-attempts the downstream push.
  const redoAnalysis = formData.get('redoAnalysis') === 'on';

  const queued = reprocessCall(callId, { redoAnalysis });
  if (!queued) redirect('/calls');

  logEvent({
    callId,
    stage: 'worker',
    message: `${redoAnalysis ? 'Re-analysis' : 'Delivery retry'} requested by ${user.username}.`,
  });

  revalidatePath(`/calls/${callId}`);
  revalidatePath('/calls');
  redirect(`/calls/${callId}?queued=1`);
}

export async function retryAllFailedAction(): Promise<void> {
  const user = await requireUser();

  const count = retryFailedJobs();
  logEvent({
    stage: 'worker',
    message: `${user.username} requeued ${count} failed job(s).`,
  });

  revalidatePath('/');
  revalidatePath('/calls');
  redirect(`/?retried=${count}`);
}
