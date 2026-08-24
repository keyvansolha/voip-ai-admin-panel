/**
 * Applies migrations and seeds without starting the server.
 *
 * Opening the database runs any pending migration as a side effect, so this is
 * mostly a way to do that deliberately — in a CI step, or before a first boot.
 *
 *   npm run db:migrate
 */
import { sqlite } from '../src/lib/db';
import { seedPrompts } from '../src/lib/ai/prompts';
import { ensureIngestToken } from '../src/lib/settings';

const applied = sqlite.prepare('SELECT id, applied_at FROM _migrations ORDER BY id').all() as Array<{
  id: string;
  applied_at: number;
}>;

seedPrompts();
ensureIngestToken();

console.log(`Database ready at ${process.env.DATABASE_PATH ?? './data/app.db'}`);
console.log(`Migrations applied (${applied.length}):`);
for (const row of applied) {
  console.log(`  ${row.id}  ${new Date(row.applied_at * 1000).toISOString()}`);
}
