/**
 * Resets (or creates) an admin password from the command line — the way back in
 * if the bootstrap password scrolled out of the container log.
 *
 *   npm run admin:set-password -- <username> <password>
 *   npm run admin:set-password -- admin              # generates one
 */
import { eq } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { sessions } from '../src/lib/db/schema';
import { generateToken } from '../src/lib/crypto';
import {
  createUser,
  findUserByUsername,
  MIN_PASSWORD_LENGTH,
  setPassword,
} from '../src/lib/auth/users';

const [usernameArg, passwordArg] = process.argv.slice(2);
const username = (usernameArg ?? 'admin').trim().toLowerCase();

if (passwordArg && passwordArg.length < MIN_PASSWORD_LENGTH) {
  console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  process.exit(1);
}

const password = passwordArg ?? generateToken(12);
const existing = findUserByUsername(username);

if (existing) {
  setPassword(existing.id, password);
  // A password reset is usually a lockout or a suspected leak, so drop every
  // signed-in browser too.
  db.delete(sessions).where(eq(sessions.userId, existing.id)).run();
  console.log(`Password updated for "${username}" and all sessions were signed out.`);
} else {
  createUser(username, password);
  console.log(`Created user "${username}".`);
}

if (!passwordArg) console.log(`Generated password: ${password}`);
