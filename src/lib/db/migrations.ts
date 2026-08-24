/**
 * Hand-written, append-only migrations. Each entry runs once, inside a
 * transaction, and is recorded in `_migrations`. Never edit a shipped
 * migration — add a new one.
 */
export interface Migration {
  readonly id: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    id: '0001_initial',
    sql: /* sql */ `
      CREATE TABLE users (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        username             TEXT NOT NULL UNIQUE,
        password_hash        TEXT NOT NULL,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        last_login_at        INTEGER,
        created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        user_agent TEXT,
        ip         TEXT
      );
      CREATE INDEX sessions_expires_idx ON sessions(expires_at);

      CREATE TABLE login_attempts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        key          TEXT NOT NULL,
        attempted_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX login_attempts_key_idx ON login_attempts(key, attempted_at);

      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        encrypted  INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE prompts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL,
        version     INTEGER NOT NULL,
        system_text TEXT NOT NULL,
        user_text   TEXT NOT NULL,
        active      INTEGER NOT NULL DEFAULT 0,
        note        TEXT,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        created_by  TEXT
      );
      CREATE UNIQUE INDEX prompts_key_version_idx ON prompts(key, version);
      CREATE INDEX prompts_key_active_idx ON prompts(key, active);

      CREATE TABLE calls (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,

        ingest_id                   TEXT NOT NULL UNIQUE,
        filename                    TEXT NOT NULL,
        stored_path                 TEXT,
        source_path                 TEXT,
        recording_deleted_at        INTEGER,
        source_ip                   TEXT,

        parse_ok                    INTEGER NOT NULL DEFAULT 0,
        ast_type                    TEXT,
        ast_uid                     INTEGER,
        ast_unique_seq              INTEGER,
        direction                   TEXT,
        customer_phone              TEXT,
        recording_local_iso         TEXT,
        recording_epoch             INTEGER,

        file_size_bytes             INTEGER NOT NULL DEFAULT 0,
        audio_data_bytes            INTEGER NOT NULL DEFAULT 0,
        wav_byte_rate               INTEGER NOT NULL DEFAULT 0,
        valid_wav                   INTEGER NOT NULL DEFAULT 0,
        duration_sec                INTEGER NOT NULL DEFAULT 0,
        missed                      INTEGER NOT NULL DEFAULT 0,
        missed_reason               TEXT,

        status                      TEXT NOT NULL DEFAULT 'received',
        ai_skipped                  INTEGER NOT NULL DEFAULT 0,
        error                       TEXT,

        ai_provider                 TEXT,
        ai_model                    TEXT,
        ai_prompt_key               TEXT,
        ai_prompt_version           INTEGER,
        ai_latency_ms               INTEGER,
        ai_input_tokens             INTEGER,
        ai_output_tokens            INTEGER,
        ai_raw_text                 TEXT,
        ai_parse_ok                 INTEGER,
        ai_parse_error              TEXT,
        ai_audio_bytes              INTEGER,
        ai_audio_mime               TEXT,

        transcript_text             TEXT,
        topic                       TEXT,
        gender_label                TEXT,
        emotion_label               TEXT,
        answered_by                 TEXT,
        product_mention             TEXT,

        remote_call_id              INTEGER,
        remote_call_pushed_at       INTEGER,
        remote_transcript_pushed_at INTEGER,
        remote_error                TEXT,

        created_at                  INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at                  INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX calls_status_idx          ON calls(status);
      CREATE INDEX calls_created_idx         ON calls(created_at);
      CREATE INDEX calls_recording_epoch_idx ON calls(recording_epoch);
      CREATE INDEX calls_direction_idx       ON calls(direction);
      CREATE INDEX calls_phone_idx           ON calls(customer_phone);
      CREATE INDEX calls_ast_idx             ON calls(ast_uid, ast_unique_seq);
      CREATE INDEX calls_filename_idx        ON calls(filename);

      CREATE TABLE jobs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id      INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
        type         TEXT NOT NULL DEFAULT 'process_call',
        status       TEXT NOT NULL DEFAULT 'pending',
        attempts     INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        run_at       INTEGER NOT NULL DEFAULT (unixepoch()),
        locked_at    INTEGER,
        locked_by    TEXT,
        last_error   TEXT,
        created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX jobs_claim_idx ON jobs(status, run_at);
      CREATE INDEX jobs_call_idx  ON jobs(call_id);

      CREATE TABLE event_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id    INTEGER REFERENCES calls(id) ON DELETE CASCADE,
        level      TEXT NOT NULL DEFAULT 'info',
        stage      TEXT NOT NULL,
        message    TEXT NOT NULL,
        meta       TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX event_logs_call_idx    ON event_logs(call_id, id);
      CREATE INDEX event_logs_created_idx ON event_logs(created_at);
      CREATE INDEX event_logs_level_idx   ON event_logs(level, created_at);
    `,
  },
];
