import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import { db } from '../db';
import { calls } from '../db/schema';
import { env } from '../env';
import { nowSeconds } from '../time';

/**
 * Recording files on disk.
 *
 * Layout is `recordings/<YYYY>/<MM>/<ingestId><ext>` — dated directories keep
 * any single folder small, and the ingest id as the basename means a hostile or
 * duplicate upload filename can never collide with or escape anything. The
 * original filename lives in the database, not on disk.
 *
 * Paths are stored relative to RECORDINGS_DIR so the data volume can be moved
 * or remounted without rewriting rows.
 */

function extensionFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.wav';
}

/** Rejects anything that would resolve outside RECORDINGS_DIR. */
export function resolveRecordingPath(relativePath: string): string {
  const root = path.resolve(env.recordingsDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Recording path escapes the recordings directory');
  }
  return resolved;
}

export async function saveRecording(
  ingestId: string,
  originalFilename: string,
  data: Buffer,
  recordedAtEpoch: number | null,
): Promise<string> {
  const date = new Date((recordedAtEpoch ?? nowSeconds()) * 1000);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');

  const relativePath = path.join(year, month, `${ingestId}${extensionFor(originalFilename)}`);
  const absolutePath = resolveRecordingPath(relativePath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, data, { mode: 0o640 });

  return relativePath;
}

export async function readRecording(relativePath: string): Promise<Buffer> {
  return fs.readFile(resolveRecordingPath(relativePath));
}

export async function recordingExists(relativePath: string): Promise<boolean> {
  try {
    await fs.access(resolveRecordingPath(relativePath));
    return true;
  } catch {
    return false;
  }
}

export async function recordingSize(relativePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(resolveRecordingPath(relativePath));
    return stat.size;
  } catch {
    return null;
  }
}

export async function deleteRecording(relativePath: string): Promise<boolean> {
  try {
    await fs.unlink(resolveRecordingPath(relativePath));
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

export interface PruneResult {
  deleted: number;
  freedBytes: number;
  errors: number;
}

/**
 * Deletes recordings older than `days`, keeping the database row (which holds
 * the transcript and analysis) and stamping `recording_deleted_at`.
 * A value of 0 disables pruning.
 */
export async function pruneRecordings(days: number): Promise<PruneResult> {
  if (days <= 0) return { deleted: 0, freedBytes: 0, errors: 0 };

  const cutoff = nowSeconds() - days * 86_400;
  const stale = db
    .select({ id: calls.id, storedPath: calls.storedPath })
    .from(calls)
    .where(
      and(
        isNotNull(calls.storedPath),
        isNull(calls.recordingDeletedAt),
        lt(calls.createdAt, cutoff),
      ),
    )
    .limit(2000)
    .all();

  let deleted = 0;
  let freedBytes = 0;
  let errors = 0;

  for (const row of stale) {
    if (!row.storedPath) continue;
    try {
      const size = (await recordingSize(row.storedPath)) ?? 0;
      await deleteRecording(row.storedPath);
      freedBytes += size;
      deleted += 1;
    } catch {
      errors += 1;
      continue;
    }
    db.update(calls)
      .set({ recordingDeletedAt: nowSeconds(), updatedAt: nowSeconds() })
      .where(eq(calls.id, row.id))
      .run();
  }

  return { deleted, freedBytes, errors };
}

/** Removes now-empty year/month directories left behind by pruning. */
export async function cleanEmptyDirectories(): Promise<void> {
  const root = path.resolve(env.recordingsDir);
  let years: string[];
  try {
    years = await fs.readdir(root);
  } catch {
    return;
  }

  for (const year of years) {
    const yearPath = path.join(root, year);
    let months: string[];
    try {
      months = await fs.readdir(yearPath);
    } catch {
      continue;
    }

    for (const month of months) {
      const monthPath = path.join(yearPath, month);
      try {
        const entries = await fs.readdir(monthPath);
        if (entries.length === 0) await fs.rmdir(monthPath);
      } catch {
        // Directory vanished or is not empty; nothing to do.
      }
    }

    try {
      const remaining = await fs.readdir(yearPath);
      if (remaining.length === 0) await fs.rmdir(yearPath);
    } catch {
      // As above.
    }
  }
}

export async function totalRecordingBytes(): Promise<number> {
  const root = path.resolve(env.recordingsDir);
  let total = 0;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        try {
          total += (await fs.stat(full)).size;
        } catch {
          // Raced with pruning.
        }
      }
    }
  }

  await walk(root);
  return total;
}
