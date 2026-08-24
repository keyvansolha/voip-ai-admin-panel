import path from 'node:path';

/**
 * Process-level configuration. Everything here is fixed at boot and comes from
 * the environment; anything an operator should be able to change at runtime
 * lives in the `settings` table instead (see `src/lib/settings.ts`).
 */

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');

export const env = {
  /**
   * Master key used to encrypt secrets at rest (Gemini API key, service-account
   * JSON, downstream panel token) and to sign session cookies. Rotating it
   * invalidates every stored secret and logs everyone out.
   *
   * Generate with: openssl rand -base64 48
   */
  appSecret: required('APP_SECRET', process.env.APP_SECRET),

  dataDir,
  databasePath: process.env.DATABASE_PATH ?? path.join(dataDir, 'app.db'),
  recordingsDir: process.env.RECORDINGS_DIR ?? path.join(dataDir, 'recordings'),

  /** Set to 'false' on a replica that should serve the UI but not process jobs. */
  workerEnabled: (process.env.WORKER_ENABLED ?? 'true') !== 'false',

  /** How many recordings may be analysed concurrently. */
  workerConcurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 2)),

  /** Hard ceiling on an uploaded recording, in bytes. Rejected with 413 above this. */
  maxUploadBytes: Math.max(1, Number(process.env.MAX_UPLOAD_BYTES ?? 200 * 1024 * 1024)),

  /** Path to the ffmpeg binary used to shrink WAVs before sending them to Gemini. */
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',

  isProduction: process.env.NODE_ENV === 'production',

  /**
   * Set to 'true' only when the app sits behind a TLS-terminating proxy on a
   * plain-HTTP port, so the session cookie still gets the Secure flag.
   */
  trustProxy: (process.env.TRUST_PROXY ?? 'false') === 'true',
} as const;

export type Env = typeof env;
