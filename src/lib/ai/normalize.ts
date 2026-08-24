/**
 * Turns whatever the model returned into the fixed field set the downstream
 * panel accepts. Port of the original n8n "ai-response-analyser" code node.
 *
 * The model is asked for bare JSON but in practice also emits fenced blocks,
 * leading prose, or double-escaped strings, so parsing is deliberately
 * forgiving — and when it still fails, the raw text is preserved on the call
 * row instead of being thrown away.
 */

export const EMOTIONS = ['angry', 'sad', 'neutral', 'happy', 'frustrated', 'unknown'] as const;
export const GENDERS = ['male', 'female', 'unknown'] as const;

export type Emotion = (typeof EMOTIONS)[number];
export type Gender = (typeof GENDERS)[number];

/** The topic slugs the prompts are allowed to choose from. */
export const PRESET_TOPICS = [
  'pricing_inquiry',
  'availability_check',
  'product_advice',
  'technical_issue',
  'warranty',
  'return_request',
  'order_tracking',
  'complaint',
  'store_hours',
  'store_location',
  'compatibility',
  'setup_help',
  'accessory_request',
  'installment_plan',
  'exchange_policy',
  'bulk_purchase',
  'corporate_sales',
  'other',
] as const;

const presetTopicSet = new Set<string>(PRESET_TOPICS);

/**
 * The panel's emotion aliasing, mirrored locally so the value stored here
 * matches the value the panel will store. Anything unrecognised → unknown.
 */
const EMOTION_ALIASES: Record<string, Emotion> = {
  positive: 'happy',
  joy: 'happy',
  joyful: 'happy',
  negative: 'sad',
  anger: 'angry',
  angry: 'angry',
  mad: 'angry',
  upset: 'frustrated',
  frustration: 'frustrated',
  calm: 'neutral',
  normal: 'neutral',
};

export interface NormalizedAnalysis {
  transcriptText: string | null;
  topic: string;
  genderLabel: Gender;
  emotionLabel: Emotion;
  answeredBy: string;
  productMention: string | null;
}

export interface NormalizeResult {
  ok: boolean;
  /** Always present — falls back to safe "unknown" values when parsing fails. */
  analysis: NormalizedAnalysis;
  error: string | null;
}

export function toSnakeCase(input: unknown): string {
  return String(input ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s\-/]+/gu, ' ')
    .trim()
    .replace(/[A-Z]+/g, (match) => match.toLowerCase())
    .replace(/[\s/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const normalized = String(value ?? '').trim().toLowerCase();
  return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : fallback;
}

function clamp(value: string | null, max: number): string | null {
  if (value == null) return null;
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * Pulls a JSON object out of model text: unwraps a ```json fence if present,
 * then takes the widest brace-delimited span.
 */
export function extractJsonString(text: string | null | undefined): string | null {
  if (text == null) return null;
  let source = String(text);

  const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) source = fence[1];

  source = source.replace(/^[\s\r\n"']+/, '').replace(/[\s\r\n"']+$/, '');

  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) return source.slice(first, last + 1);

  return null;
}

export function safeParseJson(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object') return input as Record<string, unknown>;

  const raw = extractJsonString(typeof input === 'string' ? input : null);
  if (!raw) throw new Error('No JSON object found in model output');

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Some responses arrive double-escaped (a JSON string containing JSON).
    const repaired = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return JSON.parse(repaired) as Record<string, unknown>;
  }
}

const FALLBACK: NormalizedAnalysis = {
  transcriptText: null,
  topic: 'unknown',
  genderLabel: 'unknown',
  emotionLabel: 'unknown',
  answeredBy: 'unknown',
  productMention: null,
};

export interface NormalizeOptions {
  /** Force any topic outside PRESET_TOPICS to "other". */
  restrictToPresetTopics?: boolean;
}

export function normalizeAnalysis(
  modelOutput: unknown,
  options: NormalizeOptions = {},
): NormalizeResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = safeParseJson(modelOutput);
  } catch (cause) {
    return {
      ok: false,
      analysis: { ...FALLBACK },
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  const transcriptRaw = parsed.transcript_text;
  const transcriptText =
    typeof transcriptRaw === 'string' && transcriptRaw.trim() !== '' ? transcriptRaw : null;

  // Accept both `topic` and a `topics` array; only the first is kept.
  let rawTopic: unknown = null;
  if (Array.isArray(parsed.topics) && parsed.topics.length > 0) {
    rawTopic = parsed.topics[0];
  } else if (parsed.topic != null) {
    rawTopic = parsed.topic;
  } else if (typeof parsed.topics === 'string') {
    rawTopic = parsed.topics;
  }

  let topic = toSnakeCase(rawTopic) || 'unknown';
  if (options.restrictToPresetTopics && !presetTopicSet.has(topic)) topic = 'other';

  const emotionRaw = String(parsed.emotion_label ?? '').trim().toLowerCase();
  const emotionLabel: Emotion =
    (EMOTIONS as readonly string[]).includes(emotionRaw)
      ? (emotionRaw as Emotion)
      : (EMOTION_ALIASES[emotionRaw] ?? 'unknown');

  const answeredByRaw =
    parsed.answered_by != null ? String(parsed.answered_by).trim() : '';
  const answeredBy = clamp(answeredByRaw || 'unknown', 100)!;

  const productRaw = parsed.product_mention;
  const productMention =
    productRaw == null || String(productRaw).trim() === ''
      ? null
      : clamp(String(productRaw).trim(), 255);

  return {
    ok: true,
    error: null,
    analysis: {
      transcriptText,
      // The panel's `topics` column is 100 chars.
      topic: clamp(topic, 100)!,
      genderLabel: pickEnum(parsed.gender_label, GENDERS, 'unknown'),
      emotionLabel,
      answeredBy,
      productMention,
    },
  };
}
