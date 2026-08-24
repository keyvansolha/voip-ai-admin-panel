import { GoogleGenAI, Type, type GenerateContentResponse, type Schema } from '@google/genai';
import type { AppSettings } from '../settings';

/**
 * Gemini client covering both ways to reach the model:
 *
 *   gemini_api — an AI Studio API key. Simplest, billed to the key.
 *   vertex     — Vertex AI on Google Cloud, authenticated by a service-account
 *                JSON pasted into the panel or by ambient Application Default
 *                Credentials. This is the path that spends Google Cloud credit.
 *
 * Both go through the same @google/genai SDK, so switching provider changes
 * only how the client is constructed.
 */

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}

export class AiRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiRequestError';
  }
}

/**
 * Mirrors the JSON contract in the prompts. Supplying it as a responseSchema
 * makes the model return parseable JSON instead of hoping it obeys the prose.
 */
export const ANALYSIS_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    transcript_text: {
      type: Type.STRING,
      nullable: true,
      description: 'Verbatim Persian transcript, one labelled line per speaker turn.',
    },
    topic: {
      type: Type.STRING,
      description: 'A single snake_case topic slug from the preset list.',
    },
    gender_label: { type: Type.STRING, enum: ['male', 'female', 'unknown'] },
    emotion_label: {
      type: Type.STRING,
      enum: ['angry', 'sad', 'neutral', 'happy', 'frustrated', 'unknown'],
    },
    answered_by: { type: Type.STRING },
    product_mention: { type: Type.STRING, nullable: true },
  },
  required: ['topic', 'gender_label', 'emotion_label', 'answered_by'],
  propertyOrdering: [
    'transcript_text',
    'topic',
    'gender_label',
    'emotion_label',
    'answered_by',
    'product_mention',
  ],
};

export type AiSettings = Pick<
  AppSettings,
  | 'ai.provider'
  | 'ai.apiKey'
  | 'ai.vertexProject'
  | 'ai.vertexLocation'
  | 'ai.vertexServiceAccountJson'
  | 'ai.model'
  | 'ai.temperature'
  | 'ai.maxOutputTokens'
  | 'ai.timeoutMs'
  | 'ai.structuredOutput'
>;

function parseServiceAccount(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AiConfigError('The Vertex service-account credential is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new AiConfigError('The Vertex service-account credential must be a JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.client_email !== 'string' || typeof record.private_key !== 'string') {
    throw new AiConfigError(
      'The Vertex service-account JSON is missing client_email or private_key. ' +
        'Download a service-account key from Google Cloud IAM and paste the whole file.',
    );
  }
  return record;
}

/** True when the process can supply Application Default Credentials on its own. */
function ambientCredentialsAvailable(): boolean {
  return Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCE_METADATA_HOST,
  );
}

export function createGeminiClient(settings: AiSettings): GoogleGenAI {
  const timeout = settings['ai.timeoutMs'];
  const provider = settings['ai.provider'];
  const apiKey = settings['ai.apiKey'].trim();

  // --- Enterprise / Vertex, OAuth: service account or ambient ADC ----------
  if (provider === 'vertex') {
    const project = settings['ai.vertexProject'].trim();
    const location = settings['ai.vertexLocation'].trim() || 'us-central1';
    const rawCredentials = settings['ai.vertexServiceAccountJson'].trim();

    if (!project) {
      throw new AiConfigError(
        'Vertex / Gemini Enterprise is selected but no Google Cloud project is set.',
      );
    }

    // Without a pasted key the SDK falls back to ambient ADC. Inside a
    // container there usually is none, and google-auth-library's own error
    // ("Could not load the default credentials") gives no hint about what to
    // do, so refuse early with something actionable.
    if (!rawCredentials && !ambientCredentialsAvailable()) {
      throw new AiConfigError(
        'Vertex / Gemini Enterprise with a service account is selected, but the service-account ' +
          'JSON box is empty and this container has no Application Default Credentials. ' +
          'Either paste the service-account key file into Settings, or — if all you have is an ' +
          'API key string — switch the access method to "Gemini Enterprise, API key (express mode)".',
      );
    }

    return new GoogleGenAI({
      vertexai: true,
      project,
      location,
      httpOptions: { timeout },
      ...(rawCredentials
        ? {
            googleAuthOptions: {
              credentials: parseServiceAccount(rawCredentials),
              scopes: ['https://www.googleapis.com/auth/cloud-platform'],
            },
          }
        : {}),
    });
  }

  // --- Enterprise / Vertex, express mode: API key only --------------------
  if (provider === 'vertex_express') {
    if (!apiKey) {
      throw new AiConfigError(
        'Express mode is selected but no API key is set. Paste the key into the "Gemini API key" field.',
      );
    }

    // project/location must NOT be sent here: the SDK rejects the combination
    // with "Project/location and API key are mutually exclusive". The project
    // is implied by the key itself.
    return new GoogleGenAI({ vertexai: true, apiKey, httpOptions: { timeout } });
  }

  // --- Gemini Developer API (AI Studio) -----------------------------------
  if (!apiKey) {
    throw new AiConfigError(
      'No Gemini API key is configured. Add one in Settings, or switch the access method.',
    );
  }

  return new GoogleGenAI({ apiKey, httpOptions: { timeout } });
}

export interface AnalyzeAudioInput {
  systemText: string;
  userText: string;
  audio: Buffer;
  audioMimeType: string;
}

export interface AnalyzeAudioResult {
  text: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  model: string;
  provider: string;
  finishReason: string | null;
}

/** HTTP statuses worth another attempt: transient server and rate-limit errors. */
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

function statusFrom(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.code === 'number') return candidate.code;
  return undefined;
}

/**
 * google-auth-library's "Could not load the default credentials" says nothing
 * about which knob to turn, and it is the single most likely first-run failure.
 * Replace it with the actual next step.
 */
function explainAuthFailure(message: string, provider: string): string | null {
  if (!/default credentials|could not load the default|GOOGLE_APPLICATION_CREDENTIALS/i.test(message)) {
    return null;
  }
  if (provider === 'vertex') {
    return (
      'Google could not find any credentials. The service-account JSON box in Settings is empty ' +
      'and this container has no Application Default Credentials. Paste the service-account key ' +
      'file into Settings, or switch the access method to "Gemini Enterprise, API key (express ' +
      'mode)" if you only have an API key string.'
    );
  }
  return (
    'Google could not find any credentials for the selected access method. Check the ' +
    'credentials in Settings.'
  );
}

function isRetryable(error: unknown, status: number | undefined): boolean {
  if (status !== undefined) return RETRYABLE_STATUSES.has(status);
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('etimedout') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('fetch failed') ||
    message.includes('unavailable') ||
    message.includes('overloaded') ||
    message.includes('rate limit') ||
    message.includes('resource_exhausted')
  );
}

/**
 * Concatenates every text part of the first candidate. `response.text` covers
 * the common case, but a response split across parts (or one whose accessor is
 * absent on an older SDK) still needs assembling.
 */
function extractText(response: GenerateContentResponse): string {
  if (typeof response.text === 'string' && response.text.length > 0) return response.text;

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

export async function analyzeAudio(
  settings: AiSettings,
  input: AnalyzeAudioInput,
): Promise<AnalyzeAudioResult> {
  const client = createGeminiClient(settings);
  const model = settings['ai.model'];
  const startedAt = Date.now();

  let response: GenerateContentResponse;
  try {
    response = await client.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { text: input.userText },
            {
              inlineData: {
                mimeType: input.audioMimeType,
                data: input.audio.toString('base64'),
              },
            },
          ],
        },
      ],
      config: {
        systemInstruction: input.systemText,
        temperature: settings['ai.temperature'],
        maxOutputTokens: settings['ai.maxOutputTokens'],
        ...(settings['ai.structuredOutput']
          ? {
              responseMimeType: 'application/json',
              responseSchema: ANALYSIS_RESPONSE_SCHEMA,
            }
          : {}),
      },
    });
  } catch (cause) {
    const status = statusFrom(cause);
    const message = cause instanceof Error ? cause.message : String(cause);

    // A credentials problem is a configuration fault: retrying it five times
    // over an hour helps nobody.
    const explained = explainAuthFailure(message, settings['ai.provider']);
    if (explained) throw new AiRequestError(explained, false, status);

    throw new AiRequestError(
      `Gemini request failed${status ? ` (HTTP ${status})` : ''}: ${message}`,
      isRetryable(cause, status),
      status,
    );
  }

  const latencyMs = Date.now() - startedAt;
  const text = extractText(response);
  const finishReason = response.candidates?.[0]?.finishReason ?? null;

  if (!text) {
    // MAX_TOKENS on a long call is a config problem, not a transient one.
    const retryable = finishReason !== 'MAX_TOKENS' && finishReason !== 'SAFETY';
    throw new AiRequestError(
      `Gemini returned no text${finishReason ? ` (finishReason: ${finishReason})` : ''}.` +
        (finishReason === 'MAX_TOKENS'
          ? ' Raise "Max output tokens" in Settings — long calls need a bigger budget.'
          : ''),
      retryable,
    );
  }

  return {
    text,
    latencyMs,
    inputTokens: response.usageMetadata?.promptTokenCount ?? null,
    outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
    model,
    provider: settings['ai.provider'],
    finishReason: finishReason ?? null,
  };
}

/** Cheap credential check for the Settings page's "Test connection" button. */
export async function testAiConnection(
  settings: AiSettings,
): Promise<{ ok: true; model: string; reply: string } | { ok: false; error: string }> {
  try {
    const client = createGeminiClient(settings);
    const response = await client.models.generateContent({
      model: settings['ai.model'],
      contents: 'Reply with the single word: ok',
      config: { maxOutputTokens: 2048, temperature: 0 },
    });
    return {
      ok: true,
      model: settings['ai.model'],
      reply: extractText(response).slice(0, 200) || '(empty reply)',
    };
  } catch (cause) {
    if (cause instanceof AiConfigError) return { ok: false, error: cause.message };

    const status = statusFrom(cause);
    const message = cause instanceof Error ? cause.message : String(cause);
    const explained = explainAuthFailure(message, settings['ai.provider']);
    if (explained) return { ok: false, error: explained };

    return { ok: false, error: status ? `HTTP ${status}: ${message}` : message };
  }
}
