import { formatDateOnly, formatIsoUtc, formatIsoWithOffset, formatNaiveIso } from '../time';
import type { AppSettings, DatetimeFormat } from '../settings';
import type { WallClockParts } from '../time';

/**
 * Client for the downstream VoIP dashboard's machine-to-machine ingestion API.
 *
 * Three details from its docs that are easy to get wrong and produce confusing
 * failures:
 *
 *  - The trailing slash is mandatory. `/api/voip/calls` (no slash) is a
 *    different, session-authenticated endpoint that answers 401/403 and makes
 *    it look like the API key is bad.
 *  - The key must travel in the `X-API-Key` header; the query-string form is
 *    explicitly refused.
 *  - `recording_datetime` wants an explicit UTC offset and the offset must not
 *    be pre-added to the clock time. `processing_date` is date-only.
 */

export class PanelError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'PanelError';
  }
}

/** Duplicate — the record already exists downstream. Not an error worth retrying. */
export class PanelConflictError extends PanelError {
  constructor(message: string, status: number, body?: string) {
    super(message, false, status, body);
    this.name = 'PanelConflictError';
  }
}

export type PanelSettings = Pick<
  AppSettings,
  'panel.baseUrl' | 'panel.apiToken' | 'panel.timeoutMs' | 'panel.datetimeFormat'
>;

export type Direction = 'inbound' | 'outbound' | 'internal';
export type AstType = 'in' | 'out' | 'exten' | 'q';

export interface CallPayload {
  filename: string;
  direction: Direction;
  recording_datetime: string;
  customer_phone?: string | null;
  duration_sec?: number;
  file_size_bytes?: number;
  file_path?: string | null;
  missed?: boolean;
  ast_type?: AstType | null;
  ast_unique_seq?: number | null;
}

export interface TranscriptPayload {
  call_id: number;
  recording_filename: string;
  topics: string;
  answered_by: string;
  processing_date: string;
  transcript_text?: string | null;
  product_mention?: string | null;
  gender_label?: string | null;
  emotion_label?: string | null;
}

export interface CreateCallResult {
  id: number;
  astUniqueSeq: number | null;
  /** True when the call already existed downstream and its id was looked up. */
  deduplicated: boolean;
}

/**
 * Renders a recording instant in the format the panel expects.
 *
 * `iso_offset` is the documented recommendation: local wall-clock plus its real
 * offset, e.g. `2026-08-16T16:39:59+03:30`. The other two are escape hatches if
 * the deployment ever changes its mind.
 */
export function formatRecordingDatetime(
  epochSeconds: number,
  wallClock: WallClockParts | null,
  timeZone: string,
  format: DatetimeFormat,
): string {
  const epochMs = epochSeconds * 1000;
  switch (format) {
    case 'iso_utc':
      return formatIsoUtc(epochMs);
    case 'iso_naive':
      // Documented as "works, but implicit" — the server assumes Tehran.
      return wallClock ? formatNaiveIso(wallClock) : formatIsoUtc(epochMs).replace('Z', '');
    case 'iso_offset':
    default:
      return formatIsoWithOffset(epochMs, timeZone);
  }
}

export function formatProcessingDate(epochSeconds: number, timeZone: string): string {
  return formatDateOnly(epochSeconds * 1000, timeZone);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Turns a DRF validation body into one readable line.
 *
 * The panel answers a rejected field with `{"call_id": ["call_id must
 * reference an existing calls.id."]}`, which is precise but unreadable when
 * dumped raw into a log. This renders it as `call_id: call_id must reference an
 * existing calls.id.` and names every offending field, so the fix is obvious
 * without opening the panel's source.
 */
function describeValidationError(json: unknown, fallback: string): string {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return summarizeBody(fallback);

  const record = json as Record<string, unknown>;

  // `{"success": false, "error": "..."}` — the panel's own shape.
  if (typeof record.error === 'string') return record.error;

  const parts: string[] = [];
  for (const [field, value] of Object.entries(record)) {
    if (field === 'success') continue;
    const messages = Array.isArray(value)
      ? value.map((entry) => String(entry)).join(' ')
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
    parts.push(`${field}: ${messages}`);
  }

  return parts.length > 0 ? parts.join(' | ') : summarizeBody(fallback);
}

/**
 * Names the actual transport failure instead of relaying `fetch`'s opaque
 * wording.
 *
 * A timeout surfaces as "The operation was aborted due to timeout" and a DNS or
 * TLS failure as a bare "fetch failed", which say nothing about what to check.
 * The real cause is nested in `error.cause`, so it is unwrapped and each case is
 * paired with the setting or the check that resolves it.
 */
function describeNetworkError(cause: unknown, origin: string, timeoutMs: number): string {
  const error = cause as { name?: string; message?: string; cause?: unknown } | null;
  const inner = error?.cause as { code?: string; message?: string } | undefined;
  const code = inner?.code;

  if (error?.name === 'TimeoutError' || /aborted due to timeout/i.test(error?.message ?? '')) {
    return (
      `No response from ${origin} within ${timeoutMs}ms. The request left this server but the ` +
      `panel did not answer in time — check that ${origin} is reachable from this machine ` +
      `(a firewall or geo-block between the two is the usual cause), or raise the panel ` +
      `request timeout in Settings if it is simply slow.`
    );
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Cannot resolve the hostname for ${origin} (${code}). Check DNS inside the container.`;
  }

  if (code === 'ECONNREFUSED') {
    return `${origin} refused the connection (ECONNREFUSED). The host is reachable but nothing is listening on that port.`;
  }

  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return `${origin} dropped the connection (${code}). Often a proxy or firewall cutting the request mid-flight.`;
  }

  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return (
      `Could not open a connection to ${origin} (${code}) — the TCP handshake never completed. ` +
      `The host is not accepting traffic from this server's IP address.`
    );
  }

  if (typeof code === 'string' && (code.startsWith('CERT_') || code.startsWith('DEPTH_') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')) {
    return `TLS certificate problem talking to ${origin} (${code}).`;
  }

  const detail = inner?.message ?? error?.message ?? String(cause);
  return `Could not reach the panel at ${origin}: ${detail}${code ? ` (${code})` : ''}`;
}

function summarizeBody(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}

export class PanelClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(settings: PanelSettings) {
    this.baseUrl = normalizeBaseUrl(settings['panel.baseUrl']);
    this.token = settings['panel.apiToken'].trim();
    this.timeoutMs = settings['panel.timeoutMs'];

    if (!this.token) {
      throw new PanelError('No panel API token is configured. Add one in Settings.', false);
    }
  }

  private async request(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; query?: Record<string, string> },
  ): Promise<{ status: number; text: string; json: unknown }> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        headers: {
          'X-API-Key': this.token,
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
        // Never reuse a cached response for an ingestion call.
        cache: 'no-store',
      });
    } catch (cause) {
      throw new PanelError(describeNetworkError(cause, url.origin, this.timeoutMs), true);
    }

    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // HTML error pages and WAF blocks are not JSON; keep the raw text.
    }

    return { status: response.status, text, json };
  }

  /** POST /api/voip/calls/ — returns the downstream call id. */
  async createCall(payload: CallPayload): Promise<CreateCallResult> {
    let sent: { status: number; text: string; json: unknown };

    try {
      sent = await this.request('/api/voip/calls/', { method: 'POST', body: payload });
    } catch (cause) {
      /*
       * A transport failure says nothing about whether the server processed the
       * request. On a high-latency link the POST arrives, the row is inserted,
       * and only the *response* is lost — so treating this as "it did not
       * happen" both abandons a call that is already stored and re-POSTs it on
       * the next attempt.
       *
       * Ask the panel what it actually has before believing the failure.
       */
      if (payload.ast_unique_seq) {
        const existing = await this.findCallByAstUniqueSeq(payload.ast_unique_seq);
        if (existing !== null) {
          return { id: existing, astUniqueSeq: payload.ast_unique_seq, deduplicated: true };
        }
      }
      throw cause;
    }

    const { status, text, json } = sent;

    if (status === 201 || status === 200) {
      const body = json as { id?: number; ast_unique_seq?: number } | null;
      if (typeof body?.id !== 'number') {
        throw new PanelError(
          `Panel accepted the call but returned no id: ${summarizeBody(text)}`,
          false,
          status,
          text,
        );
      }
      return {
        id: body.id,
        astUniqueSeq: typeof body.ast_unique_seq === 'number' ? body.ast_unique_seq : null,
        deduplicated: false,
      };
    }

    if (status === 409) {
      // The recording was already pushed — most likely a retry after a response
      // was lost in flight. Recover the existing id so the transcript can still
      // be attached instead of failing the whole call.
      const existing = payload.ast_unique_seq
        ? await this.findCallByAstUniqueSeq(payload.ast_unique_seq)
        : null;

      if (existing !== null) {
        return { id: existing, astUniqueSeq: payload.ast_unique_seq ?? null, deduplicated: true };
      }

      throw new PanelConflictError(
        `Panel reports this call already exists but it could not be looked up: ${summarizeBody(text)}`,
        status,
        text,
      );
    }

    if (status === 401) {
      throw new PanelError(
        'Panel rejected the API key (401). Check the token in Settings, and note the ' +
          'endpoint requires a trailing slash — /api/voip/calls without it is a different route.',
        false,
        status,
        text,
      );
    }

    if (status === 400) {
      throw new PanelError(
        `Panel rejected the call (400) — ${describeValidationError(json, text)}`,
        false,
        status,
        text,
      );
    }

    throw new PanelError(
      `Panel returned HTTP ${status} creating the call: ${summarizeBody(text)}`,
      isRetryableStatus(status),
      status,
      text,
    );
  }

  /** GET /api/voip/calls/?ast_unique_seq=… — used to resolve a 409. */
  async findCallByAstUniqueSeq(astUniqueSeq: number): Promise<number | null> {
    try {
      const { status, json } = await this.request('/api/voip/calls/', {
        method: 'GET',
        query: { ast_unique_seq: String(astUniqueSeq), limit: '1' },
      });
      if (status !== 200) return null;

      const results = (json as { results?: Array<{ id?: number }> } | null)?.results;
      const id = results?.[0]?.id;
      return typeof id === 'number' ? id : null;
    } catch {
      return null;
    }
  }

  /** GET /api/voip/transcripts/?call_id=… — confirms a transcript really exists. */
  async transcriptExists(callId: number): Promise<boolean | null> {
    try {
      const { status, json } = await this.request('/api/voip/transcripts/', {
        method: 'GET',
        query: { call_id: String(callId), limit: '1' },
      });
      if (status !== 200) return null;

      const results = (json as { results?: unknown[] } | null)?.results;
      return Array.isArray(results) ? results.length > 0 : null;
    } catch {
      return null;
    }
  }

  /**
   * POST /api/voip/transcripts/ — one transcript per call.
   *
   * A 409 is *not* taken at face value. The panel wraps the insert in a single
   * `except IntegrityError` that always answers "a transcript already exists for
   * this call_id", so a NOT NULL or FK violation is reported with the same
   * status and message as a genuine duplicate. Trusting it blindly would mark
   * the call delivered while nothing was written. So the claim is verified with
   * a read-back, and only a transcript that is actually there counts as done.
   */
  async createTranscript(payload: TranscriptPayload): Promise<{ created: boolean }> {
    const { status, text, json } = await this.request('/api/voip/transcripts/', {
      method: 'POST',
      body: payload,
    });

    if (status === 201 || status === 200) return { created: true };

    if (status === 409) {
      const exists = await this.transcriptExists(payload.call_id);

      // Genuinely already there: the desired end state holds.
      if (exists === true) return { created: false };

      // The read-back itself failed — cannot tell. Retry rather than record a
      // delivery that may not have happened.
      if (exists === null) {
        throw new PanelError(
          `Panel answered 409 for the transcript and the read-back check could not confirm it. ` +
            `Original response: ${summarizeBody(text)}`,
          true,
          status,
          text,
        );
      }

      throw new PanelError(
        `Panel answered 409 ("already exists") but no transcript is stored for call_id ` +
          `${payload.call_id}. The panel reports every database integrity error with this same ` +
          `409, so the real cause is most likely a rejected field value rather than a duplicate. ` +
          `Original response: ${summarizeBody(text)}`,
        false,
        status,
        text,
      );
    }

    if (status === 400) {
      throw new PanelError(
        `Panel rejected the transcript (400) — ${describeValidationError(json, text)}`,
        false,
        status,
        text,
      );
    }

    if (status === 401) {
      throw new PanelError(
        'Panel rejected the API key (401) on the transcripts endpoint.',
        false,
        status,
        text,
      );
    }

    throw new PanelError(
      `Panel returned HTTP ${status} creating the transcript: ${summarizeBody(text)}`,
      isRetryableStatus(status),
      status,
      text,
    );
  }

  /** Lightweight credential check for the Settings page. */
  async testConnection(): Promise<{ ok: true; count: number | null } | { ok: false; error: string }> {
    try {
      const { status, text, json } = await this.request('/api/voip/calls/', {
        method: 'GET',
        query: { limit: '1' },
      });

      if (status === 200) {
        // The list envelope renamed `count` to `total_items` (and `per_page` to
        // `limit`); both spellings are read so the check works either way.
        const body = json as { total_items?: number; count?: number } | null;
        const count = body?.total_items ?? body?.count;
        return { ok: true, count: typeof count === 'number' ? count : null };
      }
      if (status === 401) {
        return { ok: false, error: 'HTTP 401 — the API key was rejected.' };
      }
      return { ok: false, error: `HTTP ${status}: ${summarizeBody(text)}` };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
}
