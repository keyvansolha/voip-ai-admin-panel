import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from '../db';
import { sessions, users, type User } from '../db/schema';
import { generateToken, hashToken } from '../crypto';
import { env } from '../env';
import { nowSeconds } from '../time';

/**
 * Cookie sessions backed by a `sessions` table.
 *
 * Server-side rather than a self-contained signed cookie so that logging out —
 * or rotating everything after a suspected leak — actually revokes access
 * instead of waiting for an expiry.
 */

export const SESSION_COOKIE = 'voip_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

export interface SessionUser {
  id: number;
  username: string;
  mustChangePassword: boolean;
}

function toSessionUser(user: User): SessionUser {
  return {
    id: user.id,
    username: user.username,
    mustChangePassword: user.mustChangePassword,
  };
}

/** Best-effort client IP; only ever used for logging and login throttling. */
export async function clientIp(): Promise<string> {
  const headerList = await headers();
  const forwarded = headerList.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return headerList.get('x-real-ip')?.trim() || 'unknown';
}

export async function createSession(userId: number): Promise<void> {
  const token = generateToken(32);
  const headerList = await headers();

  db.insert(sessions)
    .values({
      tokenHash: hashToken(token),
      userId,
      expiresAt: nowSeconds() + SESSION_TTL_SECONDS,
      userAgent: headerList.get('user-agent')?.slice(0, 300) ?? null,
      ip: await clientIp(),
    })
    .run();

  // Housekeeping: drop anything already expired.
  db.delete(sessions).where(lt(sessions.expiresAt, nowSeconds())).run();

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction || env.trustProxy,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).run();
  }
  cookieStore.delete(SESSION_COOKIE);
}

/** Invalidates every session for a user — used after a password change. */
export function destroyAllSessionsFor(userId: number): void {
  db.delete(sessions).where(eq(sessions.userId, userId)).run();
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const row = db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, nowSeconds())))
    .limit(1)
    .all()[0];

  return row ? toSessionUser(row.user) : null;
}

/** Use at the top of every admin page and server action. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  return user;
}
