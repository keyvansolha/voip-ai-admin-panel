import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { PanelClient, PanelError, type PanelSettings } from '../src/lib/panel/client';

/**
 * Contract tests against the downstream panel, driven by a stubbed `fetch`.
 *
 * These exist because the panel and this app are separate codebases: the only
 * thing keeping them compatible is the shape of these requests and responses,
 * and a rename on either side is otherwise silent until calls stop arriving.
 */

const SETTINGS: PanelSettings = {
  'panel.baseUrl': 'https://mytsapp.ir',
  'panel.apiToken': 'test-token',
  'panel.timeoutMs': 5000,
  'panel.datetimeFormat': 'iso_offset',
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];

function stubFetch(handler: (call: Call) => { status: number; body: unknown }) {
  calls = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);

    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const TRANSCRIPT = {
  call_id: 3757,
  recording_filename: 'q-5001-989912107914-20260816-163959-1.1.wav',
  topics: 'pricing_inquiry',
  answered_by: 'zahra',
  processing_date: '2026-08-16',
};

describe('endpoint shape', () => {
  it('keeps the trailing slash and sends the key as a header, never a query param', async () => {
    stubFetch(() => ({ status: 201, body: { success: true, id: 42 } }));

    await new PanelClient(SETTINGS).createCall({
      filename: 'x.wav',
      direction: 'inbound',
      recording_datetime: '2026-08-16T16:39:59+03:30',
    });

    const call = calls[0]!;
    assert.equal(call.url, 'https://mytsapp.ir/api/voip/calls/');
    assert.equal(call.headers['X-API-Key'], 'test-token');
    assert.doesNotMatch(call.url, /token=/);
  });

  it('pages with `limit`, the renamed page-size param', async () => {
    // The panel switched its list envelope from {count, next, per_page} to
    // {total_items, page, limit}; `per_page` is now silently ignored.
    stubFetch(() => ({ status: 200, body: { total_items: 3756, results: [{ id: 3757 }] } }));

    const found = await new PanelClient(SETTINGS).findCallByAstUniqueSeq(178453);

    assert.equal(found, 3757);
    assert.match(calls[0]!.url, /[?&]limit=1(&|$)/);
    assert.doesNotMatch(calls[0]!.url, /per_page/);
  });

  it('reads the total from `total_items`, falling back to the old `count`', async () => {
    stubFetch(() => ({ status: 200, body: { total_items: 99, results: [] } }));
    const modern = await new PanelClient(SETTINGS).testConnection();
    assert.deepEqual(modern, { ok: true, count: 99 });

    stubFetch(() => ({ status: 200, body: { count: 12, results: [] } }));
    const legacy = await new PanelClient(SETTINGS).testConnection();
    assert.deepEqual(legacy, { ok: true, count: 12 });
  });
});

describe('createTranscript', () => {
  it('reports success on 201', async () => {
    stubFetch(() => ({ status: 201, body: { success: true, call_id: 3757 } }));
    assert.deepEqual(await new PanelClient(SETTINGS).createTranscript(TRANSCRIPT), {
      created: true,
    });
  });

  it('accepts a 409 only after reading the transcript back', async () => {
    stubFetch((call) =>
      call.method === 'POST'
        ? { status: 409, body: { success: false, error: 'a transcript already exists' } }
        : { status: 200, body: { total_items: 1, results: [{ call_id: 3757 }] } },
    );

    const result = await new PanelClient(SETTINGS).createTranscript(TRANSCRIPT);

    assert.deepEqual(result, { created: false });
    assert.equal(calls.length, 2, 'the 409 must be verified, not trusted');
    assert.match(calls[1]!.url, /transcripts\/\?call_id=3757/);
  });

  it('refuses to record a delivery when the 409 was not a real duplicate', async () => {
    // The panel answers every IntegrityError with the same "already exists"
    // 409, so a rejected field looks identical to a duplicate. Believing it
    // would mark the call delivered with nothing stored downstream.
    stubFetch((call) =>
      call.method === 'POST'
        ? { status: 409, body: { success: false, error: 'a transcript already exists' } }
        : { status: 200, body: { total_items: 0, results: [] } },
    );

    await assert.rejects(
      () => new PanelClient(SETTINGS).createTranscript(TRANSCRIPT),
      (error: unknown) => {
        assert.ok(error instanceof PanelError);
        assert.equal(error.retryable, false);
        assert.match(error.message, /no transcript is stored/);
        return true;
      },
    );
  });

  it('retries when the read-back itself could not answer', async () => {
    stubFetch((call) =>
      call.method === 'POST'
        ? { status: 409, body: { success: false, error: 'a transcript already exists' } }
        : { status: 503, body: {} },
    );

    await assert.rejects(
      () => new PanelClient(SETTINGS).createTranscript(TRANSCRIPT),
      (error: unknown) => {
        assert.ok(error instanceof PanelError);
        assert.equal(error.retryable, true, 'an unverifiable 409 must be retried');
        return true;
      },
    );
  });

  it('renders a DRF field error as a readable sentence', async () => {
    stubFetch(() => ({
      status: 400,
      body: { call_id: ['call_id must reference an existing calls.id.'] },
    }));

    await assert.rejects(
      () => new PanelClient(SETTINGS).createTranscript(TRANSCRIPT),
      (error: unknown) => {
        assert.ok(error instanceof PanelError);
        assert.equal(error.retryable, false);
        assert.match(error.message, /call_id: call_id must reference an existing calls\.id\./);
        return true;
      },
    );
  });
});

describe('createCall', () => {
  it('recovers the existing id when the panel reports a duplicate', async () => {
    stubFetch((call) =>
      call.method === 'POST'
        ? { status: 409, body: { success: false, error: 'duplicate or constraint violation' } }
        : { status: 200, body: { total_items: 1, results: [{ id: 3757 }] } },
    );

    const result = await new PanelClient(SETTINGS).createCall({
      filename: 'x.wav',
      direction: 'inbound',
      recording_datetime: '2026-08-16T16:39:59+03:30',
      ast_unique_seq: 178453,
    });

    assert.deepEqual(result, { id: 3757, astUniqueSeq: 178453, deduplicated: true });
  });

  it('explains a 400 without dumping raw JSON', async () => {
    stubFetch(() => ({
      status: 400,
      body: { direction: ['"sideways" is not a valid choice.'] },
    }));

    await assert.rejects(
      () =>
        new PanelClient(SETTINGS).createCall({
          filename: 'x.wav',
          direction: 'inbound',
          recording_datetime: '2026-08-16T16:39:59+03:30',
        }),
      (error: unknown) => {
        assert.ok(error instanceof PanelError);
        assert.equal(error.retryable, false);
        assert.match(error.message, /direction: "sideways" is not a valid choice\./);
        return true;
      },
    );
  });

  it('treats a 401 as terminal, with the trailing-slash hint', async () => {
    stubFetch(() => ({ status: 401, body: { detail: 'Invalid VoIP API key.' } }));

    await assert.rejects(
      () =>
        new PanelClient(SETTINGS).createCall({
          filename: 'x.wav',
          direction: 'inbound',
          recording_datetime: '2026-08-16T16:39:59+03:30',
        }),
      (error: unknown) => {
        assert.ok(error instanceof PanelError);
        assert.equal(error.retryable, false);
        assert.match(error.message, /trailing slash/);
        return true;
      },
    );
  });

  it('retries a 5xx but not a 400', async () => {
    stubFetch(() => ({ status: 502, body: {} }));
    await assert.rejects(
      () =>
        new PanelClient(SETTINGS).createCall({
          filename: 'x.wav',
          direction: 'inbound',
          recording_datetime: '2026-08-16T16:39:59+03:30',
        }),
      (error: unknown) => {
        assert.ok(error instanceof PanelError);
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });
});
