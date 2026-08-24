import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db';
import { loginAttempts, users, type User } from '../db/schema';
import { generateToken, hashPassword, verifyPassword } from '../crypto';
import { logEvent } from '../logger';
import { nowSeconds } from '../time';

/**
 * Single-operator authentication. There is no signup: the first admin is
 * created at boot with a random password that is printed once to the container
 * log, and passwords are changed from the panel or the CLI script.
 */

export const MIN_PASSWORD_LENGTH = 10;

/** Throttle window: this many failures in this many seconds blocks further tries. */
const MAX_ATTEMPTS = 8;
const WINDOW_SECONDS = 900;

export function countUsers(): number {
  return db.select({ count: sql<number>`COUNT(*)` }).from(users).all()[0]?.count ?? 0;
}

export function findUserByUsername(username: string): User | null {
  return (
    db
      .select()
      .from(users)
      .where(eq(users.username, username.trim().toLowerCase()))
      .limit(1)
      .all()[0] ?? null
  );
}

export function findUserById(id: number): User | null {
  return db.select().from(users).where(eq(users.id, id)).limit(1).all()[0] ?? null;
}

export function createUser(username: string, password: string, mustChangePassword = false): User {
  const inserted = db
    .insert(users)
    .values({
      username: username.trim().toLowerCase(),
      passwordHash: hashPassword(password),
      mustChangePassword,
    })
    .returning()
    .all();
  return inserted[0]!;
}

export function setPassword(userId: number, password: string): void {
  db.update(users)
    .set({
      passwordHash: hashPassword(password),
      mustChangePassword: false,
      updatedAt: nowSeconds(),
    })
    .where(eq(users.id, userId))
    .run();
}

/**
 * Creates the initial admin if the users table is empty and returns the
 * generated password so the caller can surface it exactly once.
 */
export function ensureBootstrapAdmin(): { created: boolean; username: string; password?: string } {
  if (countUsers() > 0) return { created: false, username: 'admin' };

  const username = (process.env.ADMIN_USERNAME ?? 'admin').trim().toLowerCase();
  const fromEnv = process.env.ADMIN_PASSWORD?.trim();
  const password = fromEnv && fromEnv.length >= MIN_PASSWORD_LENGTH ? fromEnv : generateToken(12);

  createUser(username, password, !fromEnv);

  return { created: true, username, password };
}

// --- Login throttle --------------------------------------------------------

function throttleKey(username: string, ip: string): string {
  return `${username.trim().toLowerCase()}|${ip}`;
}

export function isThrottled(username: string, ip: string): boolean {
  const since = nowSeconds() - WINDOW_SECONDS;
  const row = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(loginAttempts)
    .where(
      and(eq(loginAttempts.key, throttleKey(username, ip)), gte(loginAttempts.attemptedAt, since)),
    )
    .all()[0];
  return (row?.count ?? 0) >= MAX_ATTEMPTS;
}

function recordFailedAttempt(username: string, ip: string): void {
  db.insert(loginAttempts).values({ key: throttleKey(username, ip) }).run();

  // Opportunistic cleanup so the table does not grow unbounded.
  db.delete(loginAttempts)
    .where(sql`${loginAttempts.attemptedAt} < ${nowSeconds() - WINDOW_SECONDS * 4}`)
    .run();
}

function clearAttempts(username: string, ip: string): void {
  db.delete(loginAttempts).where(eq(loginAttempts.key, throttleKey(username, ip))).run();
}

export type AuthResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'invalid' | 'throttled' };

export function authenticate(username: string, password: string, ip: string): AuthResult {
  if (isThrottled(username, ip)) {
    logEvent({
      stage: 'auth',
      level: 'warn',
      message: `Login throttled for "${username}" from ${ip}`,
    });
    return { ok: false, reason: 'throttled' };
  }

  const user = findUserByUsername(username);

  // Hash even when the user does not exist so a missing account and a wrong
  // password take the same amount of time.
  const stored = user?.passwordHash ?? hashPassword(generateToken(16));
  const valid = verifyPassword(password, stored);

  if (!user || !valid) {
    recordFailedAttempt(username, ip);
    logEvent({ stage: 'auth', level: 'warn', message: `Failed login for "${username}" from ${ip}` });
    return { ok: false, reason: 'invalid' };
  }

  clearAttempts(username, ip);
  db.update(users).set({ lastLoginAt: nowSeconds() }).where(eq(users.id, user.id)).run();
  logEvent({ stage: 'auth', message: `Login for "${user.username}" from ${ip}` });

  return { ok: true, user };
}
