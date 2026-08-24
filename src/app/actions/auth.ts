'use server';

import { redirect } from 'next/navigation';
import { verifyPassword } from '@/lib/crypto';
import {
  authenticate,
  findUserById,
  MIN_PASSWORD_LENGTH,
  setPassword,
} from '@/lib/auth/users';
import {
  clientIp,
  createSession,
  destroyAllSessionsFor,
  destroySession,
  requireUser,
} from '@/lib/auth/session';
import { logEvent } from '@/lib/logger';

export async function loginAction(formData: FormData): Promise<void> {
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (!username || !password) redirect('/login?error=required');

  const result = authenticate(username, password, await clientIp());

  if (!result.ok) redirect(`/login?error=${result.reason}`);

  await createSession(result.user.id);
  redirect(result.user.mustChangePassword ? '/account?first=1' : '/');
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect('/login');
}

export async function changePasswordAction(formData: FormData): Promise<void> {
  const session = await requireUser();

  const current = String(formData.get('current') ?? '');
  const next = String(formData.get('next') ?? '');
  const confirm = String(formData.get('confirm') ?? '');

  if (next !== confirm) redirect('/account?error=mismatch');
  if (next.length < MIN_PASSWORD_LENGTH) redirect('/account?error=tooShort');

  const user = findUserById(session.id);
  if (!user) redirect('/login');

  if (!verifyPassword(current, user.passwordHash)) redirect('/account?error=wrongCurrent');

  setPassword(user.id, next);

  // Everything else that held this account is invalidated, including the
  // session that just changed the password — then a fresh one is issued.
  destroyAllSessionsFor(user.id);
  await createSession(user.id);

  logEvent({ stage: 'auth', message: `Password changed for "${user.username}"` });
  redirect('/account?saved=1');
}
