'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { generateToken } from '@/lib/crypto';
import { logEvent } from '@/lib/logger';
import {
  DEFAULT_SETTINGS,
  getSettings,
  updateSettings,
  type AppSettings,
  type SettingKey,
} from '@/lib/settings';

/**
 * Settings form handling.
 *
 * The form posts every field it renders. Secret fields are special-cased: an
 * empty box means "keep what is stored" rather than "set it to empty", because
 * the current value is never sent to the browser in the first place. A separate
 * `clear:<key>` checkbox is how a secret is actually removed.
 */

/** Booleans arrive only when checked, so absence is a real `false`. */
const BOOLEAN_KEYS = Object.entries(DEFAULT_SETTINGS)
  .filter(([, value]) => typeof value === 'boolean')
  .map(([key]) => key as SettingKey);

const NUMBER_KEYS = Object.entries(DEFAULT_SETTINGS)
  .filter(([, value]) => typeof value === 'number')
  .map(([key]) => key as SettingKey);

const SECRET_FIELDS: SettingKey[] = [
  'ai.apiKey',
  'ai.vertexServiceAccountJson',
  'panel.apiToken',
];

export async function saveSettingsAction(formData: FormData): Promise<void> {
  await requireUser();

  const patch: Record<string, unknown> = {};
  const submitted = new Set(
    [...formData.keys()].filter((key) => key in DEFAULT_SETTINGS),
  );

  // Only sections actually present in the submitted form are touched, so a
  // per-section save cannot blank out the rest of the page.
  const section = String(formData.get('__section') ?? '');

  for (const key of submitted) {
    const raw = formData.get(key);
    if (NUMBER_KEYS.includes(key as SettingKey)) {
      const parsed = Number(String(raw ?? '').trim());
      patch[key] = Number.isFinite(parsed) ? parsed : DEFAULT_SETTINGS[key as SettingKey];
    } else if (BOOLEAN_KEYS.includes(key as SettingKey)) {
      patch[key] = raw === 'on' || raw === 'true' || raw === '1';
    } else {
      patch[key] = String(raw ?? '');
    }
  }

  // Any boolean this section renders but did not submit is an unchecked box.
  const renderedBooleans = String(formData.get('__booleans') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const key of renderedBooleans) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    if (!submitted.has(key)) patch[key] = false;
  }

  // Secrets: blank keeps, "clear" removes.
  const stored = getSettings();
  for (const key of SECRET_FIELDS) {
    if (!(key in patch)) continue;
    const wantsClear = formData.get(`clear:${key}`) === 'on';
    const value = String(patch[key] ?? '').trim();

    if (wantsClear) patch[key] = '';
    else if (value === '') patch[key] = stored[key];
    else patch[key] = value;
  }

  const result = updateSettings(patch as Partial<AppSettings>);

  if (!result.ok) {
    const first = Object.entries(result.errors)[0];
    logEvent({
      stage: 'system',
      level: 'warn',
      message: `Rejected settings update: ${JSON.stringify(result.errors)}`,
    });
    redirect(
      `/settings?error=${encodeURIComponent(first ? `${first[0]}: ${first[1]}` : 'invalid')}${section ? `#${section}` : ''}`,
    );
  }

  logEvent({
    stage: 'system',
    message: `Settings updated (${Object.keys(patch).length} field(s)).`,
    meta: { keys: Object.keys(patch) },
  });

  revalidatePath('/settings');
  revalidatePath('/', 'layout');
  redirect(`/settings?saved=1${section ? `#${section}` : ''}`);
}

export async function rotateIngestTokenAction(): Promise<void> {
  await requireUser();

  updateSettings({ 'ingest.token': generateToken(32) });
  logEvent({
    stage: 'system',
    level: 'warn',
    message: 'Ingest token rotated — the previous token no longer works.',
  });

  revalidatePath('/settings');
  redirect('/settings?rotated=1#ingest');
}
