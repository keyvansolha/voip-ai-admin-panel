import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { calls, type Call } from '../db/schema';
import { getSettings } from '../settings';
import { logEvent } from '../logger';
import { parseAsteriskFilename, sanitizeFilename } from '../asterisk/filename';
import { detectMissedCall, readWavInfo } from '../audio/wav';
import { saveRecording } from '../storage/recordings';
import { enqueueCall } from '../queue';
import { nowSeconds } from '../time';

/**
 * Everything that happens between "a recording arrived" and "a job is queued".
 *
 * Kept out of the route handler so the same path can be exercised by tests and
 * by a future bulk-import tool without going through HTTP.
 */

export interface ReceiveInput {
  filename: string;
  data: Buffer;
  /** Original path on the Asterisk box, if the uploader sent one. */
  sourcePath?: string | null;
  sourceIp?: string | null;
}

export type ReceiveOutcome =
  | { status: 'accepted'; call: Call; ingestId: string }
  | { status: 'duplicate'; call: Call; ingestId: string }
  | { status: 'rejected'; reason: string };

/**
 * Asterisk's `uid.seq` pair identifies a recording uniquely, so a re-upload of
 * the same call (a retrying `.sh`, a replayed backlog) is recognised even
 * though the ingest id differs.
 */
function findExistingCall(astUid: number, astUniqueSeq: number): Call | null {
  return (
    db
      .select()
      .from(calls)
      .where(and(eq(calls.astUid, astUid), eq(calls.astUniqueSeq, astUniqueSeq)))
      .orderBy(desc(calls.id))
      .limit(1)
      .all()[0] ?? null
  );
}

export async function receiveRecording(input: ReceiveInput): Promise<ReceiveOutcome> {
  const settings = getSettings();
  const filename = sanitizeFilename(input.filename);

  if (!filename) return { status: 'rejected', reason: 'A filename is required' };

  const parsed = parseAsteriskFilename(filename, settings['ingest.timezone']);

  if (!parsed.ok && settings['ingest.requireParsableFilename']) {
    logEvent({
      stage: 'ingest',
      level: 'warn',
      message: `Rejected "${filename}": ${parsed.reason}`,
    });
    return { status: 'rejected', reason: parsed.reason };
  }

  if (parsed.ok) {
    const existing = findExistingCall(parsed.astUid, parsed.astUniqueSeq);
    if (existing) {
      logEvent({
        callId: existing.id,
        stage: 'ingest',
        level: 'info',
        message: `Duplicate upload of "${filename}" (already received as call ${existing.id}).`,
      });
      return { status: 'duplicate', call: existing, ingestId: existing.ingestId };
    }
  }

  const wav = readWavInfo(input.data);
  const missed = detectMissedCall(input.data.length, wav);
  const ingestId = randomUUID();

  const storedPath = await saveRecording(
    ingestId,
    filename,
    input.data,
    parsed.ok ? parsed.epochSeconds : null,
  );

  const inserted = db
    .insert(calls)
    .values({
      ingestId,
      filename,
      storedPath,
      sourcePath: input.sourcePath?.slice(0, 500) ?? null,
      sourceIp: input.sourceIp ?? null,

      parseOk: parsed.ok,
      astType: parsed.ok ? parsed.astType : null,
      astUid: parsed.ok ? parsed.astUid : null,
      astUniqueSeq: parsed.ok ? parsed.astUniqueSeq : null,
      direction: parsed.ok ? parsed.direction : null,
      customerPhone: parsed.ok ? parsed.customerPhone : null,
      recordingLocalIso: parsed.ok ? parsed.localIso : null,
      recordingEpoch: parsed.ok ? parsed.epochSeconds : null,

      fileSizeBytes: input.data.length,
      audioDataBytes: wav.audioDataBytes,
      wavByteRate: wav.byteRate,
      validWav: wav.validWav,
      durationSec: Math.round(wav.durationSec),
      missed: missed.missed,
      missedReason: missed.reason,

      status: 'received',
      aiSkipped: missed.missed,
    })
    .returning()
    .all();

  const call = inserted[0]!;

  logEvent({
    callId: call.id,
    stage: 'ingest',
    message: parsed.ok
      ? `Received "${filename}" — ${parsed.direction}, ${Math.round(wav.durationSec)}s, ${input.data.length} bytes${missed.missed ? ` (missed: ${missed.reason})` : ''}`
      : `Received "${filename}" but the name could not be parsed: ${parsed.reason}`,
    level: parsed.ok ? 'info' : 'warn',
    meta: {
      bytes: input.data.length,
      validWav: wav.validWav,
      durationSec: wav.durationSec,
      audioDataBytes: wav.audioDataBytes,
    },
  });

  enqueueCall(call.id, { maxAttempts: settings['worker.maxAttempts'] });

  return { status: 'accepted', call, ingestId };
}

/**
 * Re-runs a call through the pipeline.
 *
 * `redoAnalysis` clears the stored model output so Gemini is called again —
 * that is what you want after editing a prompt. Without it, only the
 * downstream push is retried, which is what you want after a panel outage.
 */
export function reprocessCall(callId: number, options: { redoAnalysis: boolean }): boolean {
  const call = db.select().from(calls).where(eq(calls.id, callId)).limit(1).all()[0];
  if (!call) return false;

  const settings = getSettings();

  db.update(calls)
    .set({
      status: 'queued',
      error: null,
      remoteError: null,
      ...(options.redoAnalysis
        ? {
            aiParseOk: null,
            aiParseError: null,
            aiRawText: null,
            transcriptText: null,
            topic: null,
            genderLabel: null,
            emotionLabel: null,
            answeredBy: null,
            productMention: null,
            // A transcript that was never pushed can be re-pushed; one that was
            // already accepted downstream cannot be replaced (the panel allows
            // only one per call), so the flag is left alone deliberately.
          }
        : {}),
      updatedAt: nowSeconds(),
    })
    .where(eq(calls.id, callId))
    .run();

  enqueueCall(callId, { maxAttempts: settings['worker.maxAttempts'] });

  logEvent({
    callId,
    stage: 'worker',
    message: options.redoAnalysis
      ? 'Queued for re-analysis (previous model output cleared).'
      : 'Queued for another push attempt.',
  });

  return true;
}
