import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Local bookkeeping only. The system of record for call data is the downstream
 * panel (mytsapp.ir); this database exists so an operator can see what was
 * received, what the model returned, what was pushed, and what failed.
 */

const now = sql`(unixepoch())`;

// --- Auth ------------------------------------------------------------------

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  /** Forces a password change on next login; set when seeded from a temp password. */
  mustChangePassword: integer('must_change_password', { mode: 'boolean' })
    .notNull()
    .default(false),
  lastLoginAt: integer('last_login_at'),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
});

export const sessions = sqliteTable(
  'sessions',
  {
    /** HMAC of the cookie value — the raw token is never stored. */
    tokenHash: text('token_hash').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull().default(now),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (table) => [index('sessions_expires_idx').on(table.expiresAt)],
);

/** Backs the login throttle; one row per (username, ip) bucket. */
export const loginAttempts = sqliteTable(
  'login_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull(),
    attemptedAt: integer('attempted_at').notNull().default(now),
  },
  (table) => [index('login_attempts_key_idx').on(table.key, table.attemptedAt)],
);

// --- Settings & prompts ----------------------------------------------------

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  /** JSON-encoded. When `encrypted` is set, the JSON string is ciphertext. */
  value: text('value').notNull(),
  encrypted: integer('encrypted', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull().default(now),
});

/**
 * Prompts are versioned: editing never overwrites: it inserts a new version and
 * moves the `active` flag. Every processed call records the exact version used,
 * so a change in wording is traceable in the logs.
 */
export const prompts = sqliteTable(
  'prompts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 'inbound' | 'internal_outbound' — see PROMPT_KEYS. */
    key: text('key').notNull(),
    version: integer('version').notNull(),
    /** Sent as the model's system instruction. */
    systemText: text('system_text').notNull(),
    /** Sent as the text part alongside the audio. */
    userText: text('user_text').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(false),
    note: text('note'),
    createdAt: integer('created_at').notNull().default(now),
    createdBy: text('created_by'),
  },
  (table) => [
    uniqueIndex('prompts_key_version_idx').on(table.key, table.version),
    index('prompts_key_active_idx').on(table.key, table.active),
  ],
);

// --- Calls -----------------------------------------------------------------

export const CALL_STATUSES = [
  'received',
  'queued',
  'processing',
  'completed',
  'failed',
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const calls = sqliteTable(
  'calls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    // -- Ingest
    /** Opaque id handed back to the uploader; also the stored-file basename. */
    ingestId: text('ingest_id').notNull().unique(),
    filename: text('filename').notNull(),
    /** Where we saved it, relative to RECORDINGS_DIR. */
    storedPath: text('stored_path'),
    /** Original path on the Asterisk box, if the uploader sent one. */
    sourcePath: text('source_path'),
    recordingDeletedAt: integer('recording_deleted_at'),
    sourceIp: text('source_ip'),

    // -- Parsed from the Asterisk filename
    parseOk: integer('parse_ok', { mode: 'boolean' }).notNull().default(false),
    astType: text('ast_type'),
    astUid: integer('ast_uid'),
    astUniqueSeq: integer('ast_unique_seq'),
    direction: text('direction'),
    customerPhone: text('customer_phone'),
    /** Tehran wall-clock, ISO 8601 with no zone suffix: 2026-08-16T16:39:59 */
    recordingLocalIso: text('recording_local_iso'),
    /** Same instant as a real UTC epoch (seconds), for sorting and filtering. */
    recordingEpoch: integer('recording_epoch'),

    // -- Audio facts
    fileSizeBytes: integer('file_size_bytes').notNull().default(0),
    audioDataBytes: integer('audio_data_bytes').notNull().default(0),
    wavByteRate: integer('wav_byte_rate').notNull().default(0),
    validWav: integer('valid_wav', { mode: 'boolean' }).notNull().default(false),
    durationSec: integer('duration_sec').notNull().default(0),
    missed: integer('missed', { mode: 'boolean' }).notNull().default(false),
    missedReason: text('missed_reason'),

    // -- Pipeline state
    status: text('status').$type<CallStatus>().notNull().default('received'),
    /** True when AI was deliberately skipped (missed call), not when it failed. */
    aiSkipped: integer('ai_skipped', { mode: 'boolean' }).notNull().default(false),
    error: text('error'),

    // -- AI
    aiProvider: text('ai_provider'),
    aiModel: text('ai_model'),
    aiPromptKey: text('ai_prompt_key'),
    aiPromptVersion: integer('ai_prompt_version'),
    aiLatencyMs: integer('ai_latency_ms'),
    aiInputTokens: integer('ai_input_tokens'),
    aiOutputTokens: integer('ai_output_tokens'),
    /** Verbatim model text, kept so a parse failure can be diagnosed. */
    aiRawText: text('ai_raw_text'),
    aiParseOk: integer('ai_parse_ok', { mode: 'boolean' }),
    aiParseError: text('ai_parse_error'),
    /** Bytes actually sent to the model after optional ffmpeg compression. */
    aiAudioBytes: integer('ai_audio_bytes'),
    aiAudioMime: text('ai_audio_mime'),

    // -- Normalised analysis
    transcriptText: text('transcript_text'),
    topic: text('topic'),
    genderLabel: text('gender_label'),
    emotionLabel: text('emotion_label'),
    answeredBy: text('answered_by'),
    productMention: text('product_mention'),

    // -- Downstream panel
    remoteCallId: integer('remote_call_id'),
    remoteCallPushedAt: integer('remote_call_pushed_at'),
    remoteTranscriptPushedAt: integer('remote_transcript_pushed_at'),
    /**
     * Why this call was delivered without a transcript. Null means either "a
     * transcript was delivered" or "delivery has not been attempted" — the
     * pushed-at timestamps distinguish those.
     */
    remoteTranscriptSkipReason: text('remote_transcript_skip_reason'),
    remoteError: text('remote_error'),

    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (table) => [
    index('calls_status_idx').on(table.status),
    index('calls_created_idx').on(table.createdAt),
    index('calls_recording_epoch_idx').on(table.recordingEpoch),
    index('calls_direction_idx').on(table.direction),
    index('calls_phone_idx').on(table.customerPhone),
    // Asterisk's uid.seq pair is unique per recording; used to reject re-uploads.
    index('calls_ast_idx').on(table.astUid, table.astUniqueSeq),
    index('calls_filename_idx').on(table.filename),
  ],
);

// --- Job queue -------------------------------------------------------------

export const JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * A tiny SQLite-backed queue. Enough for one store's call volume and it keeps
 * the deployment to a single container — no Redis, no separate broker.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    callId: integer('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    /** 'process_call' today; the column leaves room for future job types. */
    type: text('type').notNull().default('process_call'),
    status: text('status').$type<JobStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    /** Epoch seconds; a job is invisible to workers until now >= runAt. */
    runAt: integer('run_at').notNull().default(now),
    lockedAt: integer('locked_at'),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (table) => [
    index('jobs_claim_idx').on(table.status, table.runAt),
    index('jobs_call_idx').on(table.callId),
  ],
);

// --- Event log -------------------------------------------------------------

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const eventLogs = sqliteTable(
  'event_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    callId: integer('call_id').references(() => calls.id, { onDelete: 'cascade' }),
    level: text('level').$type<LogLevel>().notNull().default('info'),
    /** Coarse pipeline stage: ingest | parse | ai | push | retention | auth | worker */
    stage: text('stage').notNull(),
    message: text('message').notNull(),
    /** JSON blob; secrets are redacted before they get here. */
    meta: text('meta'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (table) => [
    index('event_logs_call_idx').on(table.callId, table.id),
    index('event_logs_created_idx').on(table.createdAt),
    index('event_logs_level_idx').on(table.level, table.createdAt),
  ],
);

export type User = typeof users.$inferSelect;
export type Call = typeof calls.$inferSelect;
export type NewCall = typeof calls.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type Prompt = typeof prompts.$inferSelect;
export type EventLog = typeof eventLogs.$inferSelect;
