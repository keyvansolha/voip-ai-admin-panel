/*
 * Why did a call reach the panel without its transcript?
 *
 * Plain CommonJS with no dependencies beyond better-sqlite3, so it runs inside
 * the production container as-is:
 *
 *   docker compose exec app node scripts/diagnose.cjs
 *
 * Read-only. Prints a delivery breakdown, the reason recorded against each
 * undelivered transcript, and the most recent push errors.
 */
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DATABASE_PATH || path.join(process.env.DATA_DIR || '/data', 'app.db');
const db = new Database(dbPath, { readonly: true });

const columns = db.prepare('PRAGMA table_info(calls)').all().map((c) => c.name);
const hasSkipReason = columns.includes('remote_transcript_skip_reason');

console.log(`database: ${dbPath}`);
console.log(
  `code version: ${hasSkipReason ? 'current (migration 0002 applied)' : 'OLD — the transcript fix is NOT deployed'}`,
);
console.log(
  `migrations: ${db.prepare('SELECT id FROM _migrations ORDER BY id').all().map((r) => r.id).join(', ')}\n`,
);

const reasonExpr = hasSkipReason ? 'remote_transcript_skip_reason' : 'NULL';

console.log('--- delivery breakdown -------------------------------------------------');
console.table(
  db
    .prepare(
      `SELECT CASE
          WHEN remote_call_pushed_at IS NULL AND status = 'failed' THEN 'failed before delivery'
          WHEN remote_call_pushed_at IS NULL                        THEN 'not delivered yet'
          WHEN remote_transcript_pushed_at IS NOT NULL              THEN 'call + transcript'
          WHEN missed = 1                                           THEN 'call only (missed)'
          WHEN ${reasonExpr} IS NOT NULL                            THEN 'call only (skipped)'
          ELSE 'call only — TRANSCRIPT MISSING'
        END AS outcome,
        COUNT(*) AS calls
      FROM calls GROUP BY outcome ORDER BY calls DESC`,
    )
    .all(),
);

console.log('--- calls delivered without a transcript (newest 15) --------------------');
const missing = db
  .prepare(
    `SELECT id, remote_call_id AS panel_id, substr(filename, 1, 38) AS file,
            missed, ai_skipped, ai_parse_ok,
            substr(COALESCE(${reasonExpr}, ai_parse_error, remote_error, error, '(no reason recorded)'), 1, 70) AS reason
       FROM calls
      WHERE remote_call_pushed_at IS NOT NULL AND remote_transcript_pushed_at IS NULL
      ORDER BY id DESC LIMIT 15`,
  )
  .all();
if (missing.length === 0) console.log('none — every delivered call has its transcript\n');
else console.table(missing);

console.log('--- recent push/AI problems (newest 12) --------------------------------');
const problems = db
  .prepare(
    `SELECT id, call_id, stage, substr(message, 1, 100) AS message
       FROM event_logs WHERE level IN ('warn','error') ORDER BY id DESC LIMIT 12`,
  )
  .all();
if (problems.length === 0) console.log('none logged');
else console.table(problems);
