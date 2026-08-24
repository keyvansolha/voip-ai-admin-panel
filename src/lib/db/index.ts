import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { env } from '../env';
import { migrations } from './migrations';
import * as schema from './schema';

/**
 * A single SQLite connection shared by the request handlers and the background
 * worker. Next.js hot-reloads modules in dev, so the handle is cached on
 * globalThis to avoid opening a new file handle on every edit.
 */

export type AppDatabase = BetterSQLite3Database<typeof schema>;

declare global {
  // eslint-disable-next-line no-var
  var __voipDb: { db: AppDatabase; sqlite: Database.Database } | undefined;
}

/**
 * Applies pending migrations exactly once, even when several processes open the
 * database at the same moment — which `next build` does, since it collects page
 * data in parallel workers that each import this module.
 *
 * The whole check-then-apply runs inside a single BEGIN IMMEDIATE transaction,
 * so the losing process blocks on the write lock (up to `busy_timeout`) and then
 * re-reads `_migrations` and finds the work already done. A deferred
 * transaction would not do: both processes would read an empty table before
 * either took the write lock, and the second would fail with "table already
 * exists".
 */
function applyMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const run = sqlite.transaction(() => {
    const applied = new Set(
      sqlite
        .prepare('SELECT id FROM _migrations')
        .all()
        .map((row) => (row as { id: string }).id),
    );

    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      sqlite.exec(migration.sql);
      sqlite.prepare('INSERT INTO _migrations (id) VALUES (?)').run(migration.id);
    }
  });

  run.immediate();
}

function connect(): { db: AppDatabase; sqlite: Database.Database } {
  fs.mkdirSync(path.dirname(env.databasePath), { recursive: true });
  fs.mkdirSync(env.recordingsDir, { recursive: true });

  const sqlite = new Database(env.databasePath);

  // WAL lets the worker write while the panel reads. busy_timeout covers the
  // brief writer-lock contention that produces SQLITE_BUSY under concurrency.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 10000');

  applyMigrations(sqlite);

  return { db: drizzle(sqlite, { schema }), sqlite };
}

const handle = (globalThis.__voipDb ??= connect());

export const db = handle.db;
export const sqlite = handle.sqlite;
export { schema };
