import { spawn } from 'node:child_process';
import { env } from '../env';

/**
 * Shrinks recordings before they are sent to the model.
 *
 * Asterisk writes 8 kHz 16-bit mono PCM — about 1 MB per minute — so a
 * twenty-minute call comfortably exceeds the inline request limit. Re-encoding
 * to a low-bitrate mono MP3 cuts that by roughly 30x with no meaningful loss
 * for speech, and MP3 is on Gemini's supported audio list.
 *
 * ffmpeg reads the file from disk and writes to stdout: piping *in* as well
 * risks a deadlock if the child blocks on stdout while we are still writing.
 */

export interface TranscodeResult {
  buffer: Buffer;
  mimeType: string;
  /** False when the original was returned untouched. */
  transcoded: boolean;
}

export class TranscodeError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'TranscodeError';
  }
}

export interface TranscodeOptions {
  bitrateKbps: number;
  /** Hard ceiling on the child's runtime. */
  timeoutMs?: number;
}

export function transcodeToMp3(
  inputPath: string,
  options: TranscodeOptions,
): Promise<TranscodeResult> {
  const { bitrateKbps, timeoutMs = 300_000 } = options;

  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      // 16 kHz keeps every speech formant that matters and halves the data of
      // the usual 44.1 kHz default.
      '-ar',
      '16000',
      '-b:a',
      `${bitrateKbps}k`,
      '-f',
      'mp3',
      'pipe:1',
    ];

    const child = spawn(env.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new TranscodeError(`ffmpeg timed out after ${timeoutMs}ms`, ''));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.on('error', (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new TranscodeError(
          `Could not run ffmpeg at "${env.ffmpegPath}": ${cause.message}. ` +
            'Install ffmpeg or set FFMPEG_PATH, or turn off audio compression in Settings.',
          '',
        ),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const errorText = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(new TranscodeError(`ffmpeg exited with code ${code}`, errorText));
        return;
      }

      const buffer = Buffer.concat(stdout);
      if (buffer.length === 0) {
        reject(new TranscodeError('ffmpeg produced no output', errorText));
        return;
      }

      resolve({ buffer, mimeType: 'audio/mp3', transcoded: true });
    });
  });
}

/** Best-effort MIME guess from the extension, for audio sent to the model as-is. */
export function guessAudioMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mp3';
    case 'ogg':
    case 'opus':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    case 'aac':
    case 'm4a':
      return 'audio/aac';
    case 'aiff':
    case 'aif':
      return 'audio/aiff';
    case 'gsm':
    case 'sln':
    case 'ulaw':
    case 'alaw':
      // Asterisk's raw codec dumps are not WAV; ffmpeg still reads them.
      return 'audio/wav';
    default:
      return 'audio/wav';
  }
}
