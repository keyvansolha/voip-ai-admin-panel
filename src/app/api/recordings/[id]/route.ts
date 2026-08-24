import fs from 'node:fs';
import { NextResponse, type NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { getCall } from '@/lib/calls/queries';
import { resolveRecordingPath } from '@/lib/storage/recordings';
import { guessAudioMimeType } from '@/lib/audio/transcode';

/**
 * Streams a stored recording to the signed-in operator so the panel's audio
 * player can play it back.
 *
 * Range requests are honoured because browsers need them to seek in a long
 * file, and Safari will not play audio at all without a 206 reply.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const [, startRaw, endRaw] = match;

  if (startRaw === '') {
    // Suffix form: "bytes=-500" means the last 500 bytes.
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startRaw);
  const end = endRaw === '' ? size - 1 : Number(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;

  return { start, end: Math.min(end, size - 1) };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await getSessionUser())) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const { id } = await params;
  const call = getCall(Number(id));

  if (!call || !call.storedPath) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
  }

  let absolutePath: string;
  try {
    absolutePath = resolveRecordingPath(call.storedPath);
  } catch {
    return NextResponse.json({ error: 'Invalid recording path' }, { status: 400 });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return NextResponse.json(
      { error: 'The recording file is no longer on disk' },
      { status: 410 },
    );
  }

  const contentType = guessAudioMimeType(call.filename);
  const rangeHeader = request.headers.get('range');
  const range = rangeHeader ? parseRange(rangeHeader, stat.size) : null;

  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${stat.size}` },
    });
  }

  const { start, end } = range ?? { start: 0, end: stat.size - 1 };
  const stream = fs.createReadStream(absolutePath, { start, end });

  return new Response(stream as unknown as ReadableStream, {
    status: range ? 206 : 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `inline; filename="${encodeURIComponent(call.filename)}"`,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
    },
  });
}
