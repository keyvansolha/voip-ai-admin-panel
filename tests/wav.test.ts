import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectMissedCall, readWavInfo } from '../src/lib/audio/wav';

/** Builds a RIFF/WAVE buffer, optionally with junk chunks before `data`. */
function buildWav(options: {
  audioBytes: number;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  extraChunksBeforeData?: Array<{ id: string; size: number }>;
  /** Claim a larger data chunk than is actually present. */
  truncateBy?: number;
}): Buffer {
  const {
    audioBytes,
    sampleRate = 8000,
    channels = 1,
    bitsPerSample = 16,
    extraChunksBeforeData = [],
    truncateBy = 0,
  } = options;

  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  const fmt = Buffer.alloc(8 + 16);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(byteRate, 16);
  fmt.writeUInt16LE(blockAlign, 20);
  fmt.writeUInt16LE(bitsPerSample, 22);

  const extras = extraChunksBeforeData.map((chunk) => {
    const buffer = Buffer.alloc(8 + chunk.size + (chunk.size % 2));
    buffer.write(chunk.id.padEnd(4, ' ').slice(0, 4), 0, 'ascii');
    buffer.writeUInt32LE(chunk.size, 4);
    return buffer;
  });

  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(audioBytes, 4);
  const dataBody = Buffer.alloc(Math.max(0, audioBytes - truncateBy));

  const body = Buffer.concat([fmt, ...extras, dataHeader, dataBody]);

  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WAVE', 8, 'ascii');

  return Buffer.concat([header, body]);
}

describe('readWavInfo', () => {
  it('computes duration from the data chunk and byte rate', () => {
    // 8 kHz mono 16-bit is 16000 bytes per second; 32000 bytes is 2 seconds.
    const info = readWavInfo(buildWav({ audioBytes: 32000 }));

    assert.equal(info.validWav, true);
    assert.equal(info.byteRate, 16000);
    assert.equal(info.audioDataBytes, 32000);
    assert.equal(info.durationSec, 2);
    assert.equal(info.sampleRate, 8000);
    assert.equal(info.channels, 1);
  });

  it('finds the data chunk past LIST and JUNK chunks', () => {
    // The naive "audio starts at byte 44" assumption breaks on these files.
    const info = readWavInfo(
      buildWav({
        audioBytes: 16000,
        extraChunksBeforeData: [
          { id: 'LIST', size: 26 },
          { id: 'JUNK', size: 13 }, // odd size — exercises word alignment
        ],
      }),
    );

    assert.equal(info.audioDataBytes, 16000);
    assert.equal(info.durationSec, 1);
  });

  it('clamps a data chunk that claims more bytes than the file holds', () => {
    const info = readWavInfo(buildWav({ audioBytes: 32000, truncateBy: 16000 }));

    assert.equal(info.validWav, true);
    assert.equal(info.audioDataBytes, 16000);
    assert.equal(info.durationSec, 1);
  });

  it('reports a non-WAV buffer as invalid rather than throwing', () => {
    assert.equal(readWavInfo(Buffer.from('not audio at all')).validWav, false);
    assert.equal(readWavInfo(Buffer.alloc(0)).validWav, false);
    assert.equal(readWavInfo(Buffer.alloc(4)).validWav, false);
  });
});

describe('detectMissedCall', () => {
  it('flags a zero-byte file', () => {
    const verdict = detectMissedCall(0, readWavInfo(Buffer.alloc(0)));
    assert.deepEqual(verdict, { missed: true, reason: 'zero_bytes' });
  });

  it('flags a header-only WAV with an empty data chunk', () => {
    const wav = buildWav({ audioBytes: 0 });
    const verdict = detectMissedCall(wav.length, readWavInfo(wav));
    assert.deepEqual(verdict, { missed: true, reason: 'zero_audio_data' });
  });

  it('does not flag a real recording', () => {
    const wav = buildWav({ audioBytes: 16000 });
    const verdict = detectMissedCall(wav.length, readWavInfo(wav));
    assert.deepEqual(verdict, { missed: false, reason: null });
  });

  it('does not flag an unparseable file just because its duration is zero', () => {
    // Misfiling this as "missed" would silently discard a real conversation.
    const garbage = Buffer.from('this is not a wav file but it is not empty either');
    const verdict = detectMissedCall(garbage.length, readWavInfo(garbage));
    assert.equal(verdict.missed, false);
  });
});
