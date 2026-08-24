import { NextResponse, type NextRequest } from 'next/server';
import { safeEqual } from '@/lib/crypto';
import { env } from '@/lib/env';
import { logEvent } from '@/lib/logger';
import { ensureIngestToken } from '@/lib/settings';
import { receiveRecording } from '@/lib/ingest/receive';

/**
 * The webhook that replaces the n8n entry point.
 *
 * The store's hangup script posts the recording here as multipart form-data
 * with a shared secret in a header. The response is deliberately quick: the
 * file is saved, a row is created, a job is queued, and the request returns —
 * transcription happens on the worker so the Asterisk box is never left holding
 * a connection open for the length of a Gemini call.
 *
 *   curl -X POST https://host/api/ingest \
 *     -H "X-Ingest-Token: <token>" \
 *     -F "file=@q-5001-9891...-20260816-163959-1786882183.3683.wav"
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Accepted names for the file part, in priority order. */
const FILE_FIELDS = ['file', 'data', 'recording', 'audio'] as const;

function unauthorized(): NextResponse {
  return NextResponse.json(
    { success: false, error: 'Invalid or missing ingest token' },
    { status: 401 },
  );
}

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * Reads the token from any of the headers a shell script might plausibly use.
 * The query string is not accepted — it would end up in access logs.
 */
function presentedToken(request: NextRequest): string | null {
  const direct =
    request.headers.get('x-ingest-token') ??
    request.headers.get('x-api-key') ??
    request.headers.get('x-webhook-token');
  if (direct) return direct.trim();

  const authorization = request.headers.get('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim();

  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const expected = ensureIngestToken();
  const presented = presentedToken(request);

  if (!presented || !safeEqual(presented, expected)) {
    logEvent({
      stage: 'ingest',
      level: 'warn',
      message: `Rejected an upload with a bad token from ${clientIp(request)}`,
    });
    return unauthorized();
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return NextResponse.json(
      {
        success: false,
        error: 'Send the recording as multipart/form-data with the audio in a "file" field.',
      },
      { status: 415 },
    );
  }

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > env.maxUploadBytes) {
    return NextResponse.json(
      { success: false, error: `Upload exceeds the ${env.maxUploadBytes} byte limit` },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (cause) {
    return NextResponse.json(
      {
        success: false,
        error: `Could not read the multipart body: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
      { status: 400 },
    );
  }

  let filePart: File | null = null;
  for (const field of FILE_FIELDS) {
    const value = form.get(field);
    if (value instanceof File) {
      filePart = value;
      break;
    }
  }

  if (!filePart) {
    // Fall back to the first file-ish part, so an unexpected field name is a
    // warning in the log rather than a silent failure at 3am.
    for (const [, value] of form.entries()) {
      if (value instanceof File) {
        filePart = value;
        break;
      }
    }
  }

  if (!filePart) {
    return NextResponse.json(
      { success: false, error: 'No file part found. Expected a "file" field.' },
      { status: 400 },
    );
  }

  const rawFilename =
    (form.get('filename') as string | null)?.trim() || filePart.name || 'unknown.wav';

  const buffer = Buffer.from(await filePart.arrayBuffer());

  if (buffer.length > env.maxUploadBytes) {
    return NextResponse.json(
      { success: false, error: `Upload exceeds the ${env.maxUploadBytes} byte limit` },
      { status: 413 },
    );
  }

  try {
    const outcome = await receiveRecording({
      filename: rawFilename,
      data: buffer,
      sourcePath: (form.get('path') as string | null) ?? (form.get('file_path') as string | null),
      sourceIp: clientIp(request),
    });

    if (outcome.status === 'rejected') {
      return NextResponse.json({ success: false, error: outcome.reason }, { status: 422 });
    }

    // A duplicate is answered 200/duplicate rather than an error, so a retrying
    // script sees success and stops retrying.
    return NextResponse.json(
      {
        success: true,
        duplicate: outcome.status === 'duplicate',
        ingest_id: outcome.ingestId,
        call_id: outcome.call.id,
        filename: outcome.call.filename,
        direction: outcome.call.direction,
        missed: outcome.call.missed,
        duration_sec: outcome.call.durationSec,
        file_size_bytes: outcome.call.fileSizeBytes,
        recording_datetime: outcome.call.recordingLocalIso,
        status: outcome.call.status,
      },
      { status: outcome.status === 'duplicate' ? 200 : 202 },
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    logEvent({ stage: 'ingest', level: 'error', message: `Ingest failed: ${message}` });
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

/** Lets the store PC verify connectivity and its token without sending a file. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const expected = ensureIngestToken();
  const presented = presentedToken(request);

  if (!presented || !safeEqual(presented, expected)) return unauthorized();

  return NextResponse.json({ success: true, message: 'Ingest endpoint is reachable and the token is valid.' });
}
