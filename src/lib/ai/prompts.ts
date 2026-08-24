import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { prompts as promptsTable, type Prompt } from '../db/schema';
import { DEFAULT_PROMPTS, PROMPT_KEYS, type PromptKey } from './default-prompts';

/**
 * Prompt storage with immutable versions.
 *
 * Saving an edit inserts a new version and moves the `active` flag rather than
 * overwriting, so every processed call can point at the exact prompt text that
 * produced it and a bad edit is one click from being rolled back.
 */

export function seedPrompts(): void {
  db.transaction(() => {
    for (const template of DEFAULT_PROMPTS) {
      const existing = db
        .select({ id: promptsTable.id })
        .from(promptsTable)
        .where(eq(promptsTable.key, template.key))
        .limit(1)
        .all();

      if (existing.length > 0) continue;

      db.insert(promptsTable)
        .values({
          key: template.key,
          version: 1,
          systemText: template.systemText,
          userText: template.userText,
          active: true,
          note: 'Imported from the original n8n workflow',
          createdBy: 'system',
        })
        .run();
    }
  });
}

export function getActivePrompt(key: PromptKey): Prompt {
  const found = db
    .select()
    .from(promptsTable)
    .where(and(eq(promptsTable.key, key), eq(promptsTable.active, true)))
    .limit(1)
    .all();

  if (found[0]) return found[0];

  // The active flag can only go missing if a row was edited by hand; fall back
  // to the newest version rather than failing the whole call.
  const latest = db
    .select()
    .from(promptsTable)
    .where(eq(promptsTable.key, key))
    .orderBy(desc(promptsTable.version))
    .limit(1)
    .all();

  if (latest[0]) return latest[0];

  seedPrompts();
  const seeded = db
    .select()
    .from(promptsTable)
    .where(eq(promptsTable.key, key))
    .orderBy(desc(promptsTable.version))
    .limit(1)
    .all();

  if (!seeded[0]) throw new Error(`No prompt configured for key "${key}"`);
  return seeded[0];
}

export function listPromptVersions(key: PromptKey): Prompt[] {
  return db
    .select()
    .from(promptsTable)
    .where(eq(promptsTable.key, key))
    .orderBy(desc(promptsTable.version))
    .all();
}

export function getPromptVersion(key: PromptKey, version: number): Prompt | null {
  return (
    db
      .select()
      .from(promptsTable)
      .where(and(eq(promptsTable.key, key), eq(promptsTable.version, version)))
      .limit(1)
      .all()[0] ?? null
  );
}

export interface SavePromptInput {
  key: PromptKey;
  systemText: string;
  userText: string;
  note?: string | null;
  createdBy?: string | null;
}

/** Inserts the next version for a key and makes it the active one. */
export function savePromptVersion(input: SavePromptInput): Prompt {
  return db.transaction(() => {
    const maxRow = db
      .select({ max: sql<number>`COALESCE(MAX(${promptsTable.version}), 0)` })
      .from(promptsTable)
      .where(eq(promptsTable.key, input.key))
      .all()[0];

    const nextVersion = (maxRow?.max ?? 0) + 1;

    db.update(promptsTable)
      .set({ active: false })
      .where(eq(promptsTable.key, input.key))
      .run();

    const inserted = db
      .insert(promptsTable)
      .values({
        key: input.key,
        version: nextVersion,
        systemText: input.systemText,
        userText: input.userText,
        active: true,
        note: input.note ?? null,
        createdBy: input.createdBy ?? null,
      })
      .returning()
      .all();

    return inserted[0]!;
  });
}

/** Points `active` at an older version without creating a new one. */
export function activatePromptVersion(key: PromptKey, version: number): boolean {
  const target = getPromptVersion(key, version);
  if (!target) return false;

  db.transaction(() => {
    db.update(promptsTable).set({ active: false }).where(eq(promptsTable.key, key)).run();
    db.update(promptsTable)
      .set({ active: true })
      .where(and(eq(promptsTable.key, key), eq(promptsTable.version, version)))
      .run();
  });

  return true;
}

export function isPromptKey(value: string): value is PromptKey {
  return (PROMPT_KEYS as readonly string[]).includes(value);
}

export { PROMPT_KEYS, DEFAULT_PROMPTS };
export type { PromptKey };
