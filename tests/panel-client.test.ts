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

describe('network failures', () => {
  const attempt = (settings = SETTINGS) =>
    new PanelClient(settings).createCall({
      filename: 'x.wav',
      direction: 'inbound',
      recording_datetime: '2026-08-16T16:39:59+03:30',
    });

  function failFetch(error: unknown) {
    globalThis.fetch = (async () => {
      throw error;
    }) as typeof fetch;
  }

  it('names a timeout and points at the setting that controls it', async () => {
    // What AbortSignal.timeout actually throws.
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    failFetch(timeout);

    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof PanelError);
      assert.equal(error.retryable, true, 'a timeout is transient');
      assert.match(error.message, /within 5000ms/);
      assert.match(error.message, /firewall or geo-block/);
      return true;
    });
  });

  it('unwraps a DNS failure hidden behind "fetch failed"', async () => {
    const wrapped = new TypeError('fetch failed');
    (wrapped as { cause?: unknown }).cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
      code: 'ENOTFOUND',
    });
    failFetch(wrapped);

    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof PanelError);
      assert.match(error.message, /Cannot resolve the hostname/);
      assert.match(error.message, /ENOTFOUND/);
      return true;
    });
  });

  it('distinguishes a refused connection from a blocked one', async () => {
    const refused = new TypeError('fetch failed');
    (refused as { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    failFetch(refused);
    await assert.rejects(attempt, (error: unknown) => {
      assert.match((error as Error).message, /refused the connection/);
      return true;
    });

    const blocked = new TypeError('fetch failed');
    (blocked as { cause?: unknown }).cause = Object.assign(new Error('connect ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    });
    failFetch(blocked);
    await assert.rejects(attempt, (error: unknown) => {
      assert.match((error as Error).message, /TCP handshake never completed/);
      return true;
    });
  });

  it('reports a TLS problem as such', async () => {
    const tls = new TypeError('fetch failed');
    (tls as { cause?: unknown }).cause = Object.assign(new Error('certificate has expired'), {
      code: 'CERT_HAS_EXPIRED',
    });
    failFetch(tls);

    await assert.rejects(attempt, (error: unknown) => {
      assert.match((error as Error).message, /TLS certificate problem/);
      return true;
    });
  });
});

describe('a lost response must not be read as a lost write', () => {
  /**
   * The failure this reproduces: on a slow link the POST reaches the panel and
   * the row is inserted, but the reply never arrives. Reporting that as a
   * failure abandons a call that is already stored — and, because createCall
   * throws, the transcript step is never reached at all.
   */
  it('recovers the id when the POST times out but the row landed', async () => {
    let posts = 0;
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts += 1;
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      assert.match(String(input), /ast_unique_seq=4705/);
      return new Response(JSON.stringify({ total_items: 1, results: [{ id: 1767882711 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await new PanelClient(SETTINGS).createCall({
      filename: 'q-5001-989122606844-20260825-172759-1787662663.4705.wav',
      direction: 'inbound',
      recording_datetime: '2026-08-25T17:27:59+03:30',
      ast_unique_seq: 4705,
    });

    assert.deepEqual(result, { id: 1767882711, astUniqueSeq: 4705, deduplicated: true });
    assert.equal(posts, 1, 'the call must not be posted twice');
  });

  it('still reports failure when the row genuinely is not there', async () => {
    globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      return new Response(JSON.stringify({ total_items: 0, results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await assert.rejects(
      () =>
        new PanelClient(SETTINGS).createCall({
          filename: 'x.wav',
          direction: 'inbound',
          recording_datetime: '2026-08-25T17:27:59+03:30',
          ast_unique_seq: 4705,
        }),
      (error: unknown) => {
        assert.ok(error instanceof PanelError);
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });

  it('reports failure when the lookup is impossible (unparsed filename)', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as typeof fetch;

    await assert.rejects(
      () =>
        new PanelClient(SETTINGS).createCall({
          filename: 'x.wav',
          direction: 'inbound',
          recording_datetime: '2026-08-25T17:27:59+03:30',
          // No ast_unique_seq — nothing to look the call up by.
        }),
      (error: unknown) => {
        assert.ok(error instanceof PanelError);
        return true;
      },
    );
    assert.equal(requests, 1, 'no pointless lookup without a key to search on');
  });
});

describe('transcript keyed on ast_unique_seq', () => {
  it('sends the sequence alongside call_id so it works before and after the panel change', async () => {
    stubFetch(() => ({ status: 201, body: { success: true, call_id: 3757 } }));

    await new PanelClient(SETTINGS).createTranscript({ ...TRANSCRIPT, ast_unique_seq: 4705 });

    const body = calls[0]!.body as Record<string, unknown>;
    assert.equal(body.call_id, 3757);
    assert.equal(body.ast_unique_seq, 4705);
  });

  it('delivers with the sequence alone when the call id was never received', async () => {
    stubFetch(() => ({ status: 201, body: { success: true, call_id: 3757 } }));

    const result = await new PanelClient(SETTINGS).createTranscript({
      ast_unique_seq: 4705,
      recording_filename: 'q-5001-989122606844-20260825-172759-1787662663.4705.wav',
      topics: 'pricing_inquiry',
      answered_by: 'unknown',
      processing_date: '2026-08-25',
    });

    assert.deepEqual(result, { created: true });
    const body = calls[0]!.body as Record<string, unknown>;
    assert.equal(body.ast_unique_seq, 4705);
    assert.ok(!('call_id' in body), 'no call_id is sent when none is known');
  });

  it('verifies a 409 by resolving the sequence to a call id first', async () => {
    const seen: string[] = [];
    stubFetch((call) => {
      seen.push(`${call.method} ${call.url.replace('https://mytsapp.ir', '')}`);
      if (call.method === 'POST') {
        return { status: 409, body: { success: false, error: 'a transcript already exists' } };
      }
      if (call.url.includes('/calls/')) {
        return { status: 200, body: { total_items: 1, results: [{ id: 3757 }] } };
      }
      return { status: 200, body: { total_items: 1, results: [{ call_id: 3757 }] } };
    });

    const result = await new PanelClient(SETTINGS).createTranscript({
      ast_unique_seq: 4705,
      recording_filename: 'x.wav',
      topics: 'pricing_inquiry',
      answered_by: 'unknown',
      processing_date: '2026-08-25',
    });

    assert.deepEqual(result, { created: false });
    assert.match(seen[1]!, /GET \/api\/voip\/calls\/\?ast_unique_seq=4705/);
    assert.match(seen[2]!, /GET \/api\/voip\/transcripts\/\?call_id=3757/);
  });

  it('names the sequence when a 409 is disproved by the read-back', async () => {
    // The call resolves, but no transcript is stored against it — so the 409
    // was some other integrity error wearing a duplicate's clothes.
    stubFetch((call) => {
      if (call.method === 'POST') {
        return { status: 409, body: { success: false, error: 'a transcript already exists' } };
      }
      if (call.url.includes('/calls/')) {
        return { status: 200, body: { total_items: 1, results: [{ id: 3757 }] } };
      }
      return { status: 200, body: { total_items: 0, results: [] } };
    });

    await assert.rejects(
      () =>
        new PanelClient(SETTINGS).createTranscript({
          ast_unique_seq: 4705,
          recording_filename: 'x.wav',
          topics: 'pricing_inquiry',
          answered_by: 'unknown',
          processing_date: '2026-08-25',
        }),
      (error: unknown) => {
        assert.ok(error instanceof PanelError);
        assert.equal(error.retryable, false);
        assert.match(error.message, /ast_unique_seq 4705/);
        return true;
      },
    );
  });

  it('retries when the sequence cannot even be resolved to a call', async () => {
    // Nothing can be established either way here, so the only safe answer is
    // "try again" — never "delivered".
    stubFetch((call) =>
      call.method === 'POST'
        ? { status: 409, body: { success: false, error: 'a transcript already exists' } }
        : { status: 200, body: { total_items: 0, results: [] } },
    );

    await assert.rejects(
      () =>
        new PanelClient(SETTINGS).createTranscript({
          ast_unique_seq: 4705,
          recording_filename: 'x.wav',
          topics: 'pricing_inquiry',
          answered_by: 'unknown',
          processing_date: '2026-08-25',
        }),
      (error: unknown) => {
        assert.ok(error instanceof PanelError);
        assert.equal(error.retryable, true);
        assert.match(error.message, /could not confirm/);
        return true;
      },
    );
  });
})
