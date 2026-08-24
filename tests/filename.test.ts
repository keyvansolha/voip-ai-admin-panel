import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAsteriskFilename, sanitizeFilename } from '../src/lib/asterisk/filename';

const TEHRAN = 'Asia/Tehran';

describe('parseAsteriskFilename', () => {
  it('parses a queue recording and takes the customer number from the second field', () => {
    const result = parseAsteriskFilename(
      'q-5001-989912107914-20260816-163959-1786882183.3683.wav',
      TEHRAN,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.astType, 'q');
    assert.equal(result.direction, 'inbound');
    // q puts the internal extension first, so p2 is the outside party.
    assert.equal(result.customerPhone, '989912107914');
    assert.equal(result.astUid, 1786882183);
    assert.equal(result.astUniqueSeq, 3683);
    assert.equal(result.localIso, '2026-08-16T16:39:59');
  });

  it('takes the customer number from the first field for in/out recordings', () => {
    const inbound = parseAsteriskFilename(
      'in-989121234567-5001-20260816-163959-1786882183.3683.wav',
      TEHRAN,
    );
    assert.equal(inbound.ok, true);
    if (inbound.ok) {
      assert.equal(inbound.direction, 'inbound');
      assert.equal(inbound.customerPhone, '989121234567');
    }

    const outbound = parseAsteriskFilename(
      'out-989121234567-5001-20260816-163959-1786882183.3683.wav',
      TEHRAN,
    );
    assert.equal(outbound.ok, true);
    if (outbound.ok) {
      assert.equal(outbound.direction, 'outbound');
      assert.equal(outbound.customerPhone, '989121234567');
    }
  });

  it('classifies extension-to-extension recordings as internal', () => {
    const result = parseAsteriskFilename('exten-101-102-20260816-090000-1786882183.1.wav', TEHRAN);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.direction, 'internal');
    assert.equal(result.customerPhone, '102');
  });

  it('reads the filename clock as local time and emits the right offset', () => {
    const result = parseAsteriskFilename('in-900-5001-20260816-163959-1.1.wav', TEHRAN);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // 16:39:59 in Tehran (+03:30) is 13:09:59 UTC.
    assert.equal(result.offsetIso, '2026-08-16T16:39:59+03:30');
    assert.equal(result.epochSeconds, Math.floor(Date.UTC(2026, 7, 16, 13, 9, 59) / 1000));
  });

  it('produces a different instant for the same digits in a different zone', () => {
    const tehran = parseAsteriskFilename('in-900-5001-20260816-163959-1.1.wav', TEHRAN);
    const utc = parseAsteriskFilename('in-900-5001-20260816-163959-1.1.wav', 'UTC');

    assert.equal(tehran.ok && utc.ok, true);
    if (!tehran.ok || !utc.ok) return;

    assert.equal(utc.offsetIso, '2026-08-16T16:39:59Z');
    assert.equal(utc.epochSeconds - tehran.epochSeconds, 3.5 * 3600);
  });

  it('accepts a filename with no extension', () => {
    const result = parseAsteriskFilename('in-900-5001-20260816-163959-1786882183.3683', TEHRAN);
    assert.equal(result.ok, true);
  });

  it('rejects names that are not Asterisk recordings', () => {
    for (const name of [
      'recording.wav',
      'x-900-5001-20260816-163959-1.1.wav',
      'in-900-5001-2026081-163959-1.1.wav',
      '',
    ]) {
      assert.equal(parseAsteriskFilename(name, TEHRAN).ok, false, `expected "${name}" to fail`);
    }
  });

  it('rejects an impossible clock time rather than silently shifting it', () => {
    const result = parseAsteriskFilename('in-900-5001-20260816-256159-1.1.wav', TEHRAN);
    assert.equal(result.ok, false);
  });
});

describe('sanitizeFilename', () => {
  it('strips directory components including traversal attempts', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFilename('/var/spool/asterisk/rec.wav'), 'rec.wav');
    assert.equal(sanitizeFilename('C:\\recordings\\rec.wav'), 'rec.wav');
  });

  it('keeps the hyphens and dots Asterisk uses as field separators', () => {
    const name = 'q-5001-989912107914-20260816-163959-1786882183.3683.wav';
    assert.equal(sanitizeFilename(name), name);
  });

  it('removes control characters', () => {
    assert.equal(sanitizeFilename('rec\u0000\u001f.wav'), 'rec.wav');
  });
});
