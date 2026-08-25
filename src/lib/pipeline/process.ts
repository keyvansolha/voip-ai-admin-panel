import { eq } from 'drizzle-orm';
import { db } from '../db';
import { calls, type Call } from '../db/schema';
import { getSettings } from '../settings';
import { logEvent } from '../logger';
import { nowSeconds } from '../time';
import { getActivePrompt } from '../ai/prompts';
import { promptKeyForDirection } from '../ai/default-prompts';
import { analyzeAudio, AiConfigError, AiRequestError } from '../ai/gemini';
import { normalizeAnalysis } from '../ai/normalize';
import { guessAudioMimeType, transcodeToMp3, TranscodeError } from '../audio/transcode';
import { readRecording, recordingExists, resolveRecordingPath } from '../storage/recordings';
import {
  PanelClient,
  PanelError,
  formatProcessingDate,
  formatRecordingDatetime,
  type AstType,
  type Direction,
} from '../panel/client';

/**
 * The whole per-call pipeline, in the order the old n8n workflow ran it:
 *
 *   missed?        → skip the model entirely, push a call row and stop
 *   inbound        → analyse with the customer prompt
 *   internal/out   → analyse with the coworker prompt
 *   then           → POST the call, take its id, POST the transcript
 *
 * Every stage is idempotent against what is already recorded on the row, so a
 * retry after a partial failure resumes rather than duplicating work: an
 * already-pushed call is not pushed twice, and an already-stored analysis is
 * not re-billed to Gemini.
 */

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly stage: 'parse' | 'ai' | 'push' | 'system',
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

function loadCall(callId: number): Call {
  const row = db.select().from(calls).where(eq(calls.id, callId)).limit(1).all()[0];
  if (!row) throw new PipelineError(`Call ${callId} no longer exists`, false, 'system');
  return row;
}

function patchCall(callId: number, patch: Partial<Call>): void {
  db.update(calls)
    .set({ ...patch, updatedAt: nowSeconds() })
    .where(eq(calls.id, callId))
    .run();
}

// --- Stage 1: analysis -----------------------------------------------------

async function loadAudioForModel(
  call: Call,
  settings: ReturnType<typeof getSettings>,
): Promise<{ buffer: Buffer; mimeType: string; transcoded: boolean }> {
  if (!call.storedPath) {
    throw new PipelineError('The recording file was never stored for this call', false, 'ai');
  }
  if (!(await recordingExists(call.storedPath))) {
    throw new PipelineError(
      'The recording file is gone from disk (deleted by retention?), so it cannot be re-analysed',
      false,
      'ai',
    );
  }

  const original = await readRecording(call.storedPath);
  const threshold = settings['audio.compressThresholdBytes'];
  const shouldCompress = settings['audio.compressEnabled'] && original.length >= threshold;

  if (shouldCompress) {
    try {
      const result = await transcodeToMp3(resolveRecordingPath(call.storedPath), {
        bitrateKbps: settings['audio.targetBitrateKbps'],
      });
      logEvent({
        callId: call.id,
        stage: 'ai',
        level: 'debug',
        message: `Compressed audio for upload: ${original.length} → ${result.buffer.length} bytes`,
      });
      return { buffer: result.buffer, mimeType: result.mimeType, transcoded: true };
    } catch (cause) {
      // Compression is an optimisation. If the original is small enough to send
      // as-is, carry on rather than failing the call.
      const detail = cause instanceof TranscodeError ? `${cause.message} ${cause.stderr}` : String(cause);
      if (original.length <= settings['audio.maxUploadToModelBytes']) {
        logEvent({
          callId: call.id,
          stage: 'ai',
          level: 'warn',
          message: `Audio compression failed; sending the original file instead. ${detail}`,
        });
        return {
          buffer: original,
          mimeType: guessAudioMimeType(call.filename),
          transcoded: false,
        };
      }
      throw new PipelineError(
        `Audio compression failed and the original (${original.length} bytes) is too large to send. ${detail}`,
        false,
        'ai',
      );
    }
  }

  return { buffer: original, mimeType: guessAudioMimeType(call.filename), transcoded: false };
}

async function runAnalysis(call: Call, settings: ReturnType<typeof getSettings>): Promise<void> {
  const promptKey = promptKeyForDirection(call.direction);
  const prompt = getActivePrompt(promptKey);

  const audio = await loadAudioForModel(call, settings);

  if (audio.buffer.length > settings['audio.maxUploadToModelBytes']) {
    throw new PipelineError(
      `Audio is ${audio.buffer.length} bytes, over the ${settings['audio.maxUploadToModelBytes']} byte ` +
        'limit for a single request. Lower the target bitrate or raise the limit in Settings.',
      false,
      'ai',
    );
  }

  let result;
  try {
    result = await analyzeAudio(settings, {
      systemText: prompt.systemText,
      userText: prompt.userText,
      audio: audio.buffer,
      audioMimeType: audio.mimeType,
    });
  } catch (cause) {
    if (cause instanceof AiConfigError) throw new PipelineError(cause.message, false, 'ai');
    if (cause instanceof AiRequestError) {
      throw new PipelineError(cause.message, cause.retryable, 'ai');
    }
    throw new PipelineError(
      `Unexpected error calling Gemini: ${cause instanceof Error ? cause.message : String(cause)}`,
      true,
      'ai',
    );
  }

  const normalized = normalizeAnalysis(result.text, {
    restrictToPresetTopics: settings['ai.restrictToPresetTopics'],
  });

  patchCall(call.id, {
    aiProvider: result.provider,
    aiModel: result.model,
    aiPromptKey: promptKey,
    aiPromptVersion: prompt.version,
    aiLatencyMs: result.latencyMs,
    aiInputTokens: result.inputTokens,
    aiOutputTokens: result.outputTokens,
    aiRawText: result.text.slice(0, 200_000),
    aiParseOk: normalized.ok,
    aiParseError: normalized.error,
    aiAudioBytes: audio.buffer.length,
    aiAudioMime: audio.mimeType,
    transcriptText: normalized.analysis.transcriptText,
    topic: normalized.analysis.topic,
    genderLabel: normalized.analysis.genderLabel,
    emotionLabel: normalized.analysis.emotionLabel,
    answeredBy: normalized.analysis.answeredBy,
    productMention: normalized.analysis.productMention,
  });

  logEvent({
    callId: call.id,
    stage: 'ai',
    level: normalized.ok ? 'info' : 'warn',
    message: normalized.ok
      ? `Analysed with ${result.model} in ${result.latencyMs}ms (topic: ${normalized.analysis.topic})`
      : `Model replied but the JSON could not be parsed: ${normalized.error}`,
    meta: {
      promptKey,
      promptVersion: prompt.version,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      audioBytes: audio.buffer.length,
      transcoded: audio.transcoded,
    },
  });

  // A well-formed request that produced unparseable text will produce the same
  // unparseable text on retry, so this is terminal rather than retryable.
  if (!normalized.ok) {
    throw new PipelineError(
      `Could not parse the model's response as JSON: ${normalized.error}. The raw reply is kept on the call for inspection.`,
      false,
      'ai',
    );
  }
}

// --- Stage 2: push downstream ----------------------------------------------

async function pushToPanel(call: Call, settings: ReturnType<typeof getSettings>): Promise<void> {
  if (!settings['panel.enabled']) {
    logEvent({
      callId: call.id,
      stage: 'push',
      level: 'info',
      message: 'Panel push is disabled in Settings; the analysis is kept locally only.',
    });
    return;
  }

  if (call.missed && !settings['panel.pushMissedCalls']) {
    logEvent({
      callId: call.id,
      stage: 'push',
      level: 'info',
      message: 'Missed call not pushed (disabled in Settings).',
    });
    return;
  }

  if (!call.direction || call.recordingEpoch === null) {
    throw new PipelineError(
      'The filename could not be parsed, so direction and recording time are unknown and the panel would reject the call.',
      false,
      'push',
    );
  }

  // Constructed inside the pipeline's error handling: a missing token throws
  // here, and it is a configuration fault that would fail identically on every
  // retry, so it must not be classified as transient.
  let client: PanelClient;
  try {
    client = new PanelClient(settings);
  } catch (cause) {
    throw new PipelineError(
      cause instanceof Error ? cause.message : String(cause),
      cause instanceof PanelError ? cause.retryable : false,
      'push',
    );
  }

  const timezone = settings['ingest.timezone'];

  // -- The call row
  let remoteCallId = call.remoteCallId;
  if (remoteCallId === null) {
    const wallClock = call.recordingLocalIso ? parseLocalIso(call.recordingLocalIso) : null;

    try {
      const created = await client.createCall({
        filename: call.filename.slice(0, 255),
        direction: call.direction as Direction,
        recording_datetime: formatRecordingDatetime(
          call.recordingEpoch,
          wallClock,
          timezone,
          settings['panel.datetimeFormat'],
        ),
        customer_phone: call.customerPhone?.slice(0, 32) ?? null,
        duration_sec: Math.round(call.durationSec),
        file_size_bytes: call.fileSizeBytes,
        file_path: (call.sourcePath ?? call.storedPath)?.slice(0, 500) ?? null,
        missed: call.missed,
        ast_type: (call.astType as AstType | null) ?? null,
        ast_unique_seq: call.astUniqueSeq,
      });

      remoteCallId = created.id;
      patchCall(call.id, { remoteCallId, remoteCallPushedAt: nowSeconds(), remoteError: null });

      logEvent({
        callId: call.id,
        stage: 'push',
        message: created.deduplicated
          ? `Call already existed downstream; reusing id ${created.id}`
          : `Created downstream call ${created.id}`,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      patchCall(call.id, { remoteError: message.slice(0, 2000) });
      throw new PipelineError(message, cause instanceof PanelError ? cause.retryable : true, 'push');
    }
  }

  // -- The transcript
  if (call.remoteTranscriptPushedAt !== null) return;

  /*
   * A transcript is owed whenever the model actually ran, even if it returned no
   * transcript text.
   *
   * The previous rule ("only when transcriptText is set") silently threw away
   * the topic, emotion, gender and product fields for any call the model
   * summarised without a verbatim transcript — and said nothing about it, which
   * is exactly the "the call is in the panel but the transcript is missing"
   * symptom. `transcript_text` is nullable downstream, so send what we have.
   */
  const analysisRan = !call.aiSkipped && call.aiParseOk === true;

  if (!analysisRan) {
    // Say why, out loud. This is a normal outcome for a missed call and a
    // problem worth seeing for anything else.
    const reason = call.missed
      ? `missed call (${call.missedReason ?? 'no audio'}) — nothing to transcribe`
      : call.aiSkipped
        ? 'AI analysis was skipped for this call'
        : 'the model produced no usable analysis';

    patchCall(call.id, { remoteTranscriptSkipReason: reason });
    logEvent({
      callId: call.id,
      stage: 'push',
      level: call.missed ? 'info' : 'warn',
      message: `Call ${remoteCallId} delivered without a transcript: ${reason}.`,
    });
    return;
  }

  try {
    const result = await client.createTranscript({
      call_id: remoteCallId,
      recording_filename: call.filename.slice(0, 255),
      // The panel's column is named `topics` (plural) but holds one value.
      topics: (call.topic ?? 'unknown').slice(0, 100),
      answered_by: (call.answeredBy ?? 'unknown').slice(0, 100),
      processing_date: formatProcessingDate(nowSeconds(), timezone),
      transcript_text: call.transcriptText,
      product_mention: call.productMention,
      // These two columns are NOT nullable downstream — they are choice fields
      // with a default, so an explicit null is rejected with a 400 while an
      // absent key is fine. Fall back to the shared "unknown" member.
      gender_label: call.genderLabel ?? 'unknown',
      emotion_label: call.emotionLabel ?? 'unknown',
    });

    patchCall(call.id, {
      remoteTranscriptPushedAt: nowSeconds(),
      remoteError: null,
      remoteTranscriptSkipReason: null,
    });
    logEvent({
      callId: call.id,
      stage: 'push',
      message: result.created
        ? `Pushed transcript for downstream call ${remoteCallId}` +
          (call.transcriptText === null ? ' (analysis only — the model returned no transcript text)' : '')
        : `Transcript already existed downstream for call ${remoteCallId}`,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    patchCall(call.id, { remoteError: message.slice(0, 2000) });
    throw new PipelineError(message, cause instanceof PanelError ? cause.retryable : true, 'push');
  }
}

/** Reads back `2026-08-16T16:39:59` into its components. */
function parseLocalIso(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
  };
}

// --- Entry point -----------------------------------------------------------

export async function processCall(callId: number): Promise<void> {
  const settings = getSettings();
  let call = loadCall(callId);

  patchCall(callId, { status: 'processing', error: null });
  call = loadCall(callId);

  // Missed calls have no audio worth sending; the old workflow branched here
  // and so does this one.
  if (call.missed) {
    if (!call.aiSkipped) patchCall(callId, { aiSkipped: true });
    call = loadCall(callId);

    logEvent({
      callId,
      stage: 'ai',
      message: `Missed call (${call.missedReason ?? 'no audio'}); skipping analysis.`,
    });

    await pushToPanel(call, settings);
    patchCall(callId, { status: 'completed', error: null });
    return;
  }

  /*
   * A stored analysis is worth delivering whatever the current settings say.
   *
   * Keyed on aiParseOk alone, not on transcriptText: the model can return a
   * valid analysis (topic, emotion, speaker) with no verbatim transcript, and
   * requiring the text here would both re-bill that call to Gemini on every
   * retry and drop the fields it did produce.
   */
  const alreadyAnalysed = call.aiParseOk === true;

  // Turning AI off must not retro-actively discard work that is already done,
  // so the shortcut only applies to calls that were never analysed.
  if (!settings['ai.enabled'] && !alreadyAnalysed) {
    if (!call.aiSkipped) patchCall(callId, { aiSkipped: true });
    call = loadCall(callId);

    logEvent({
      callId,
      stage: 'ai',
      level: 'warn',
      message: 'AI analysis is turned off in Settings; pushing call metadata only.',
    });

    await pushToPanel(call, settings);
    patchCall(callId, { status: 'completed', error: null });
    return;
  }

  if (!alreadyAnalysed) {
    await runAnalysis(call, settings);
    call = loadCall(callId);
  } else {
    logEvent({
      callId,
      stage: 'ai',
      level: 'debug',
      message: 'Reusing the analysis from a previous attempt; not calling Gemini again.',
    });
  }

  await pushToPanel(call, settings);
  patchCall(callId, { status: 'completed', error: null });
}
