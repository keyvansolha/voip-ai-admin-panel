/**
 * Seed prompts, carried over verbatim from the original n8n workflow.
 *
 * These are only the *initial* version 1 of each prompt. Once the app has run,
 * prompts are edited in the admin panel and stored in the `prompts` table, so
 * changing this file has no effect on an existing install.
 *
 * Which prompt a call gets is decided by direction:
 *   inbound            → a customer is on the line (مشتری / فروشنده roles)
 *   internal, outbound → coworkers, couriers, vendors (no customer role)
 * Missed calls are never sent to the model at all.
 */

export const PROMPT_KEYS = ['inbound', 'internal_outbound'] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];

export interface PromptTemplate {
  key: PromptKey;
  /** Shown in the panel; not sent to the model. */
  label: string;
  description: string;
  systemText: string;
  userText: string;
}

const SHARED_TOPIC_LIST = `pricing_inquiry
availability_check
product_advice
technical_issue
warranty
return_request
complaint
store_hours
store_location
compatibility
setup_help
accessory_request
installment_plan
exchange_policy
bulk_purchase
corporate_sales
other`;

const SHARED_OUTPUT_SCHEMA = `Output JSON (ONLY this object):
{
  "transcript_text": "string|null",
  "topic": "snake_case_slug",
  "gender_label": "male|female|unknown",
  "emotion_label": "angry|sad|neutral|happy|frustrated|unknown",
  "answered_by": "string",
  "product_mention": "string|null"
}`;

export const DEFAULT_PROMPTS: readonly PromptTemplate[] = [
  {
    key: 'inbound',
    label: 'Inbound (customer calls)',
    description:
      'Used for direction=inbound (Asterisk types "in" and "q"). Transcribes with مشتری / فروشنده speaker roles.',
    systemText: 'You are an information extractor. Return ONLY valid JSON. No explanations.',
    userText: `If audio is provided, first transcribe Persian verbatim INTO "transcript_text" as TURN-BY-TURN lines WITH ROLES.
Each line MUST start with exactly one of these labels (Persian, followed by a colon and a space):
"مشتری: " or "فروشنده: "
Example:
"مشتری: ...
فروشنده: ...
مشتری: ..."

Then analyze and extract fields.

Rules:
- topic: ONE snake_case slug (string). Choose ONLY from the preset list below. If none match clearly, use "other".
- gender_label ∈ {"male","female","unknown"} (dominant caller voice).
- emotion_label ∈ {"angry","sad","neutral","happy","frustrated","unknown"}.
- answered_by: if a real name or extension is explicitly present, return that exact value (e.g., "zahra","101"); otherwise return "unknown".
- product_mention: full English product name (Brand + Series + Model/Number) or null. Convert Persian mentions to English (e.g., "فلیپ ۷" → "JBL Flip 7"). Trim to ≤255 chars.
- Do NOT return any extra arrays or fields (e.g., no speaker_roles). Only the fields in the schema below.

Preset topics (single-select):
${SHARED_TOPIC_LIST}

${SHARED_OUTPUT_SCHEMA}`,
  },
  {
    key: 'internal_outbound',
    label: 'Internal / outbound calls',
    description:
      'Used for direction=internal (Asterisk type "exten") and direction=outbound (type "out"). No customer role; speakers are named, role-labelled, or numbered.',
    systemText:
      'You are an information extractor for internal and outbound calls. Return ONLY valid JSON. No explanations.',
    userText: `If audio is provided, first transcribe Persian verbatim INTO "transcript_text" as TURN-BY-TURN lines WITH ROLES.
This prompt is ONLY for internal and outbound calls (coworker-to-coworker, calls to couriers, vendors, etc.), where there is NO "مشتری" role.

Speaker labeling rules (VERY IMPORTANT):
- For each distinct voice, choose ONE stable label and use it for ALL of that speaker's lines.
- Do NOT use "مشتری" or "فروشنده" here.

Label selection priority:

1) If the speaker clearly introduces themselves by a personal name (e.g., "من زهرا هستم", "رضا از انبار"):
   - Use that exact Persian first name as the label, followed by a colon and a space.
   - Examples:
     "زهرا: ..."
     "رضا: ..."

2) If no clear personal name is given, but the role is obvious (e.g., courier, warehouse, accounting, support):
   - You MAY use a short Persian role label, followed by a colon and a space.
   - Examples:
     "پیک: ..."
     "انبار: ..."
     "حسابداری: ..."

3) If neither name nor role is clearly stated:
   - Assign generic numbered speaker labels in Persian, starting from:
     "گوینده ۱: "
     "گوینده ۲: "
     "گوینده ۳: "
   - Use the same "گوینده N" for the same voice throughout the call.

Examples:
"رضا: ...
پیک: ...
رضا: ..."

or

"گوینده ۱: ...
گوینده ۲: ...
گوینده ۱: ..."

Then analyze and extract fields.

Rules for fields:
- topic: ONE snake_case slug (string). Choose ONLY from the preset list below. If none match clearly, use "other".
- gender_label ∈ {"male","female","unknown"} (dominant or primary caller voice).
- emotion_label ∈ {"angry","sad","neutral","happy","frustrated","unknown"}.
- answered_by: if a real name or extension is explicitly present (e.g., coworker's name, "zahra", "ramin", or numbers such as "101"), return that exact value; otherwise return "unknown".
- product_mention: full English product name (Brand + Series + Model/Number) or null. Convert Persian mentions to English (e.g., "فلیپ ۷" → "JBL Flip 7"). Trim to ≤255 chars.
- Do NOT return any extra arrays or fields (e.g., no speaker_roles). Only the fields in the schema below.

Preset topics (single-select):
${SHARED_TOPIC_LIST}

${SHARED_OUTPUT_SCHEMA}`,
  },
];

/** Maps a parsed call direction onto the prompt that should analyse it. */
export function promptKeyForDirection(direction: string | null): PromptKey {
  return direction === 'inbound' ? 'inbound' : 'internal_outbound';
}
