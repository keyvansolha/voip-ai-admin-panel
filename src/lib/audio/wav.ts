/**
 * Minimal RIFF/WAVE reader.
 *
 * Duration comes from the real chunk table rather than the usual
 * "audio starts at byte 44" shortcut, because Asterisk recordings often carry
 * LIST/JUNK chunks ahead of `data`. Byte rate lives in `fmt `, payload size in
 * `data`, and duration is simply one divided by the other.
 */

export interface WavInfo {
  validWav: boolean;
  /** Seconds, 3 decimal places. 0 when the file is not a readable WAV. */
  durationSec: number;
  /** Size of the `data` chunk payload — 0 for a header-only "missed call" file. */
  audioDataBytes: number;
  byteRate: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

const EMPTY: WavInfo = {
  validWav: false,
  durationSec: 0,
  audioDataBytes: 0,
  byteRate: 0,
  channels: 0,
  sampleRate: 0,
  bitsPerSample: 0,
};

export function readWavInfo(buffer: Buffer): WavInfo {
  if (!buffer || buffer.length < 12) return { ...EMPTY };

  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return { ...EMPTY };
  }

  let offset = 12;
  let byteRate = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioDataBytes = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;

    if (chunkDataStart > buffer.length) break;

    // A truncated upload can claim more bytes than are present; clamp so we
    // report what actually arrived instead of reading past the end.
    const availableBytes = Math.max(0, buffer.length - chunkDataStart);
    const safeChunkSize = Math.min(chunkSize, availableBytes);

    if (chunkId === 'fmt ' && safeChunkSize >= 16) {
      channels = buffer.readUInt16LE(chunkDataStart + 2);
      sampleRate = buffer.readUInt32LE(chunkDataStart + 4);
      byteRate = buffer.readUInt32LE(chunkDataStart + 8);
      bitsPerSample = buffer.readUInt16LE(chunkDataStart + 14);
    }

    if (chunkId === 'data') {
      audioDataBytes = safeChunkSize;
    }

    // RIFF chunks are word-aligned: an odd size is followed by one pad byte.
    const nextOffset = chunkDataStart + chunkSize + (chunkSize % 2);
    if (nextOffset <= offset) break; // corrupt size field — stop rather than spin
    offset = nextOffset;
  }

  const durationSec =
    byteRate > 0 && audioDataBytes > 0 ? Number((audioDataBytes / byteRate).toFixed(3)) : 0;

  return {
    validWav: true,
    durationSec,
    audioDataBytes,
    byteRate,
    channels,
    sampleRate,
    bitsPerSample,
  };
}

export interface MissedCallVerdict {
  missed: boolean;
  reason: 'zero_bytes' | 'zero_audio_data' | null;
}

/**
 * A missed call leaves either a completely empty file or a valid WAV whose
 * `data` chunk is empty.
 *
 * Deliberately not keyed on `durationSec === 0`: a file we simply failed to
 * parse also has duration 0, and misfiling that as "missed" would silently drop
 * a real conversation instead of surfacing the parse problem.
 */
export function detectMissedCall(fileSizeBytes: number, wav: WavInfo): MissedCallVerdict {
  if (fileSizeBytes === 0) return { missed: true, reason: 'zero_bytes' };
  if (wav.validWav && wav.audioDataBytes === 0) return { missed: true, reason: 'zero_audio_data' };
  return { missed: false, reason: null };
}
