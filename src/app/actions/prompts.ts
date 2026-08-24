'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { logEvent } from '@/lib/logger';
import { activatePromptVersion, isPromptKey, savePromptVersion } from '@/lib/ai/prompts';
import { DEFAULT_PROMPTS } from '@/lib/ai/default-prompts';

export async function savePromptAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  const key = String(formData.get('key') ?? '');
  if (!isPromptKey(key)) redirect('/prompts?error=unknown');

  const systemText = String(formData.get('systemText') ?? '').trim();
  const userText = String(formData.get('userText') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim() || null;

  if (!systemText || !userText) redirect(`/prompts?error=empty&key=${key}`);

  const saved = savePromptVersion({
    key,
    systemText,
    userText,
    note,
    createdBy: user.username,
  });

  logEvent({
    stage: 'system',
    message: `Prompt "${key}" saved as version ${saved.version} by ${user.username}.`,
  });

  revalidatePath('/prompts');
  redirect(`/prompts?saved=${saved.version}&key=${key}`);
}

export async function restorePromptAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  const key = String(formData.get('key') ?? '');
  const version = Number(formData.get('version'));

  if (!isPromptKey(key) || !Number.isInteger(version)) redirect('/prompts?error=unknown');

  const restored = activatePromptVersion(key, version);
  if (!restored) redirect(`/prompts?error=unknown&key=${key}`);

  logEvent({
    stage: 'system',
    message: `Prompt "${key}" rolled back to version ${version} by ${user.username}.`,
  });

  revalidatePath('/prompts');
  redirect(`/prompts?restored=${version}&key=${key}`);
}

/** Saves the shipped n8n text as a new version — history is never rewritten. */
export async function resetPromptAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  const key = String(formData.get('key') ?? '');
  if (!isPromptKey(key)) redirect('/prompts?error=unknown');

  const template = DEFAULT_PROMPTS.find((candidate) => candidate.key === key);
  if (!template) redirect('/prompts?error=unknown');

  const saved = savePromptVersion({
    key,
    systemText: template.systemText,
    userText: template.userText,
    note: 'Reset to the original n8n prompt',
    createdBy: user.username,
  });

  logEvent({ stage: 'system', message: `Prompt "${key}" reset to the shipped default.` });

  revalidatePath('/prompts');
  redirect(`/prompts?saved=${saved.version}&key=${key}`);
}
