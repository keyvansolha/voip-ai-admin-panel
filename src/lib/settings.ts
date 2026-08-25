import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db';
import { settings as settingsTable } from './db/schema';
import { decryptSecret, encryptSecret, generateToken } from './crypto';
import { isValidTimeZone, nowSeconds } from './time';

/**
 * Runtime configuration, editable from the admin panel and stored in SQLite.
 * Anything an operator might reasonably want to change without a redeploy
 * belongs here; boot-time infrastructure config lives in `env.ts`.
 *
 * Values in SECRET_KEYS are AES-GCM encrypted at rest and are never returned to
 * the browser — the UI only ever sees whether they are set.
 */

export const SECRET_KEYS = [
  'ingest.token',
  'ai.apiKey',
  'ai.vertexServiceAccountJson',
  'panel.apiToken',
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

const secretKeySet = new Set<string>(SECRET_KEYS);

/**
 * How to reach the model:
 *
 *   gemini_api     — Gemini Developer API (AI Studio) key.
 *   vertex_express — Gemini Enterprise Agent Platform (formerly Vertex AI) in
 *                    express mode: an API key, no Google Cloud project. The SDK
 *                    treats project/location and apiKey as mutually exclusive,
 *                    so this mode must send the key alone.
 *   vertex         — Gemini Enterprise Agent Platform with OAuth: a
 *                    service-account key, or ambient Application Default
 *                    Credentials. This is the mode that bills a Cloud project.
 */
export const AI_PROVIDERS = ['gemini_api', 'vertex_express', 'vertex'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const DATETIME_FORMATS = ['iso_offset', 'iso_utc', 'iso_naive'] as const;
export type DatetimeFormat = (typeof DATETIME_FORMATS)[number];

export const LOCALES = ['en', 'fa'] as const;
export type Locale = (typeof LOCALES)[number];

export const settingsSchema = z.object({
  // --- Ingest -------------------------------------------------------------
  /** Shared secret the store PC sends as X-Ingest-Token. Auto-generated on first boot. */
  'ingest.token': z.string().min(16),
  /** Reject uploads whose filename does not match the Asterisk pattern. */
  'ingest.requireParsableFilename': z.boolean(),
  /** Silently accept a re-upload of an already-seen recording instead of 409. */
  'ingest.ignoreDuplicates': z.boolean(),
  /** IANA zone the Asterisk box writes filenames in. */
  'ingest.timezone': z.string().refine(isValidTimeZone, 'not a valid IANA time zone'),

  // --- AI -----------------------------------------------------------------
  'ai.enabled': z.boolean(),
  'ai.provider': z.enum(AI_PROVIDERS),
  /** Gemini Developer API key (AI Studio). Used when provider is gemini_api. */
  'ai.apiKey': z.string(),
  /** Google Cloud project for Vertex AI. */
  'ai.vertexProject': z.string(),
  'ai.vertexLocation': z.string(),
  /**
   * Service-account JSON for Vertex. Leave empty to fall back to ambient
   * Application Default Credentials (metadata server, gcloud login, or
   * GOOGLE_APPLICATION_CREDENTIALS).
   */
  'ai.vertexServiceAccountJson': z.string(),
  'ai.model': z.string().min(1),
  'ai.temperature': z.number().min(0).max(2),
  'ai.maxOutputTokens': z.number().int().min(256).max(65536),
  'ai.timeoutMs': z.number().int().min(10_000).max(1_800_000),
  /**
   * Constrain the model with responseSchema + application/json. Far more
   * reliable than asking for JSON in prose; turn off only if a model rejects it.
   */
  'ai.structuredOutput': z.boolean(),
  /** Force any topic outside the preset list to "other". */
  'ai.restrictToPresetTopics': z.boolean(),

  // --- Audio handling -----------------------------------------------------
  /** Transcode with ffmpeg before upload. Asterisk WAVs are ~1 MB/minute. */
  'audio.compressEnabled': z.boolean(),
  /** Only compress files at or above this size. 0 = always compress. */
  'audio.compressThresholdBytes': z.number().int().min(0),
  'audio.targetBitrateKbps': z.number().int().min(8).max(320),
  /** Hard cap on what may be sent inline to the model. */
  'audio.maxUploadToModelBytes': z.number().int().min(1024),

  // --- Downstream panel ---------------------------------------------------
  'panel.enabled': z.boolean(),
  'panel.baseUrl': z.string().url(),
  'panel.apiToken': z.string(),
  'panel.datetimeFormat': z.enum(DATETIME_FORMATS),
  'panel.timeoutMs': z.number().int().min(1000).max(300_000),
  /** Push missed calls too (as a call row with missed=true and no transcript). */
  'panel.pushMissedCalls': z.boolean(),

  // --- Retention ----------------------------------------------------------
  /** Delete stored WAVs older than this many days. 0 = keep forever. */
  'retention.recordingDays': z.number().int().min(0).max(3650),
  /** Delete event-log rows older than this many days. 0 = keep forever. */
  'retention.logDays': z.number().int().min(0).max(3650),
  /** Delete local call rows older than this many days. 0 = keep forever. */
  'retention.callDays': z.number().int().min(0).max(3650),

  // --- Worker -------------------------------------------------------------
  'worker.maxAttempts': z.number().int().min(1).max(20),
  'worker.pollIntervalMs': z.number().int().min(500).max(120_000),

  // --- UI -----------------------------------------------------------------
  'ui.defaultLocale': z.enum(LOCALES),
  'ui.displayTimezone': z.string().refine(isValidTimeZone, 'not a valid IANA time zone'),
});

export type AppSettings = z.infer<typeof settingsSchema>;
export type SettingKey = keyof AppSettings;

export const DEFAULT_SETTINGS: AppSettings = {
  'ingest.token': '',
  'ingest.requireParsableFilename': false,
  'ingest.ignoreDuplicates': true,
  'ingest.timezone': 'Asia/Tehran',

  'ai.enabled': true,
  'ai.provider': 'gemini_api',
  'ai.apiKey': '',
  'ai.vertexProject': '',
  'ai.vertexLocation': 'us-central1',
  'ai.vertexServiceAccountJson': '',
  'ai.model': 'gemini-2.5-flash',
  'ai.temperature': 0,
  'ai.maxOutputTokens': 8192,
  'ai.timeoutMs': 600_000,
  'ai.structuredOutput': true,
  'ai.restrictToPresetTopics': false,

  'audio.compressEnabled': true,
  'audio.compressThresholdBytes': 4 * 1024 * 1024,
  'audio.targetBitrateKbps': 32,
  'audio.maxUploadToModelBytes': 18 * 1024 * 1024,

  'panel.enabled': true,
  'panel.baseUrl': 'https://mytsapp.ir',
  'panel.apiToken': '',
  'panel.datetimeFormat': 'iso_offset',
  // Iran-to-Europe links are slow enough that 30s produced false timeouts on
  // writes the panel had in fact accepted.
  'panel.timeoutMs': 60_000,
  'panel.pushMissedCalls': true,

  'retention.recordingDays': 30,
  'retention.logDays': 180,
  'retention.callDays': 0,

  'worker.maxAttempts': 5,
  'worker.pollIntervalMs': 3000,

  'ui.defaultLocale': 'en',
  'ui.displayTimezone': 'Asia/Tehran',
};

function readRawSettings(): Map<string, unknown> {
  const rows = db.select().from(settingsTable).all();
  const out = new Map<string, unknown>();

  for (const row of rows) {
    let raw = row.value;
    if (row.encrypted) {
      try {
        raw = decryptSecret(raw);
      } catch {
        // APP_SECRET changed or the row was tampered with. Treat as unset so
        // the panel shows "not configured" rather than crashing every request.
        continue;
      }
    }
    try {
      out.set(row.key, JSON.parse(raw));
    } catch {
      // Ignore unparsable rows; the schema default takes over.
    }
  }

  return out;
}

/**
 * Full settings with defaults filled in. Invalid stored values fall back to
 * their default rather than throwing, so a bad row can always be fixed from the
 * UI instead of bricking the app.
 */
export function getSettings(): AppSettings {
  const stored = readRawSettings();
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };

  for (const [key, value] of stored) {
    if (key in DEFAULT_SETTINGS) merged[key] = value;
  }

  const parsed = settingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;

  // Repair field-by-field so one bad value cannot discard the rest.
  const repaired: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const [key, value] of stored) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    const single = settingsSchema.shape[key as SettingKey];
    if (single.safeParse(value).success) repaired[key] = value;
  }
  return repaired as AppSettings;
}

export function isSecretKey(key: string): key is SecretKey {
  return secretKeySet.has(key);
}

function writeSetting(key: string, value: unknown): void {
  const json = JSON.stringify(value);
  const encrypted = isSecretKey(key);
  const stored = encrypted ? encryptSecret(json) : json;

  db.insert(settingsTable)
    .values({ key, value: stored, encrypted, updatedAt: nowSeconds() })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { value: stored, encrypted, updatedAt: nowSeconds() },
    })
    .run();
}

/**
 * Applies a partial update. Every key is validated against its own schema
 * entry; the whole patch is rejected if any key fails, so the UI can report
 * exactly which field was wrong without half-applying the form.
 */
export function updateSettings(patch: Partial<AppSettings>): { ok: true } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) {
      errors[key] = 'unknown setting';
      continue;
    }
    const result = settingsSchema.shape[key as SettingKey].safeParse(value);
    if (!result.success) {
      errors[key] = result.error.issues[0]?.message ?? 'invalid value';
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) writeSetting(key, value);
  });

  return { ok: true };
}

export function clearSettings(keys: readonly string[]): void {
  if (keys.length === 0) return;
  db.delete(settingsTable).where(inArray(settingsTable.key, [...keys])).run();
}

export function deleteSetting(key: string): void {
  db.delete(settingsTable).where(eq(settingsTable.key, key)).run();
}

/**
 * Creates the ingest token on first boot so a fresh install has a working
 * webhook immediately. Returns the token either way.
 */
export function ensureIngestToken(): string {
  const current = getSettings()['ingest.token'];
  if (current && current.length >= 16) return current;

  const token = generateToken(32);
  writeSetting('ingest.token', token);
  return token;
}

/**
 * Settings shaped for the browser: secrets replaced by a boolean "is it set".
 * Never send the raw object to a client component.
 */
export function getPublicSettings(): Omit<AppSettings, SecretKey> & {
  secrets: Record<SecretKey, boolean>;
} {
  const all = getSettings();
  const visible = { ...all } as Record<string, unknown>;
  const secrets = {} as Record<SecretKey, boolean>;

  for (const key of SECRET_KEYS) {
    secrets[key] = typeof all[key] === 'string' && all[key].length > 0;
    delete visible[key];
  }

  return { ...(visible as Omit<AppSettings, SecretKey>), secrets };
}
