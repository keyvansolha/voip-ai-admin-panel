import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  PanelClient,
  PanelError,
  summarizeErrorChain,
  unwrapErrorChain,
  type PanelSettings,
} from '../src/lib/panel/client';

/**
 * Step 2 diagnostics. The question these have to answer is the one `fetch`
 * refuses to: did our own deadline expire, or did the connection break first?
 */

const SETTINGS: PanelSettings = {
  'panel.baseUrl': 'https://mytsapp.ir',
  'panel.apiToken': 'test-token',
  'panel.timeoutMs': 5000,
  'panel.datetimeFormat': 'iso_offset',
};

const TRANSCRIPT = {
  call_id: 3757,
  recording_filename: 'q-5001-989122606844-20260825-172759-1787662663.4705.wav',
  topics: 'pricing_inquiry',
  answered_by: 'unknown',
  processing_date: '2026-08-25',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function captureFailure(makeFetch: () => typeof fetch): Promise<PanelError> {
  globalThis.fetch = makeFetch();
  try {
    await new PanelClient(SETTINGS).createTranscript(TRANSCRIPT);
  } catch (error) {
    assert.ok(error instanceof PanelError, 'expected a PanelError');
    return error;
  }
  throw new Error('expected the request to fail');
}

describe('unwrapErrorChain', () => {
  it('reaches the syscall error undici nests two levels down', () => {
    const outer = new TypeError('fetch failed');
    (outer as { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
      errno: -104,
      syscall: 'read',
    });

    const chain = unwrapErrorChain(outer);

    assert.equal(chain.length, 2);
    assert.deepEqual(chain[0], { name: 'TypeError', message: 'fetch failed' });
    assert.equal(chain[1]!.code, 'ECONNRESET');
    assert.equal(chain[1]!.errno, -104);
    assert.equal(chain[1]!.syscall, 'read');
  });

  it('does not loop forever on a self-referential cause', () => {
    const looped = new Error('boom');
    (looped as { cause?: unknown }).cause = looped;
    assert.equal(unwrapErrorChain(looped).length, 1);
  });

  it('renders a chain as one line', () => {
    const outer = new TypeError('fetch failed');
    (outer as { cause?: unknown }).cause = Object.assign(new Error('x'), { code: 'ECONNRESET' });
    assert.equal(
      summarizeErrorChain(unwrapErrorChain(outer)),
      'TypeError: fetch failed <- Error(ECONNRESET)',
    );
  });
});

describe('the timeout-vs-reset discriminator', () => {
  it('marks a peer reset as NOT a timeout, and says raising it will not help', async () => {
    const error = await captureFailure(
      () =>
        (async () => {
          const reset = new TypeError('fetch failed');
          (reset as { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), {
            code: 'ECONNRESET',
            syscall: 'read',
          });
          throw reset;
        }) as typeof fetch,
    );

    assert.equal(error.diagnostics?.timedOut, false);
    assert.equal(error.diagnostics?.phase, 'request');
    assert.equal(error.diagnostics?.chain[1]?.code, 'ECONNRESET');
    // The specific syscall diagnosis wins over the generic wording, and the
    // machine-readable timedOut flag above is what actually decides the case.
    assert.match(error.message, /dropped the connection \(ECONNRESET\)/);
    assert.match(error.message, /ECONNRESET/);
  });

  it('marks an expired deadline as a timeout', async () => {
    const error = await captureFailure(
      () =>
        (async (_input: URL | RequestInfo, init?: RequestInit) => {
          // Mirror the real abort: the signal fires, then fetch rejects.
          await new Promise((resolve) => setTimeout(resolve, 5));
          Object.defineProperty(init!.signal!, 'aborted', { value: true, configurable: true });
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        }) as typeof fetch,
    );

    assert.equal(error.diagnostics?.timedOut, true);
    assert.match(error.message, /No response from https:\/\/mytsapp\.ir within 5000ms/);
  });

  it('records elapsed time and the share of the budget used', async () => {
    const error = await captureFailure(
      () =>
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          throw new TypeError('fetch failed');
        }) as typeof fetch,
    );

    assert.ok(error.diagnostics!.elapsedMs >= 50, 'elapsed time must be measured');
    assert.equal(error.diagnostics!.timeoutMs, 5000);
    assert.match(error.message, /of 5000ms/);
  });
});

describe('failure phase', () => {
  it('separates a lost body from a lost request, and keeps the status line', async () => {
    // The status line arrived — so the server answered — and only the payload
    // was lost. Previously this escaped the handler entirely as a bare
    // TypeError with no indication of which phase failed.
    const error = await captureFailure(
      () =>
        (async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('terminated'));
              },
            }),
            { status: 201 },
          )) as typeof fetch,
    );

    assert.equal(error.diagnostics?.phase, 'body');
    assert.equal(error.diagnostics?.httpStatus, 201);
    assert.equal(error.status, 201);
    assert.equal(error.retryable, true, 'behaviour is unchanged: still retryable');
    assert.match(error.message, /answered HTTP 201 but the response body never arrived/);
  });

  it('leaves a normal HTTP rejection without transport diagnostics', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ topics: ['This field is required.'] }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    await assert.rejects(
      () => new PanelClient(SETTINGS).createTranscript(TRANSCRIPT),
      (error: unknown) => {
        assert.ok(error instanceof PanelError);
        assert.equal(error.diagnostics, undefined, 'a 400 is not a transport failure');
        assert.equal(error.status, 400);
        return true;
      },
    );
  });
});
