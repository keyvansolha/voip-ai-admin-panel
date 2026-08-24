import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatDateOnly,
  formatIsoUtc,
  formatIsoWithOffset,
  formatOffset,
  offsetMinutesAt,
  wallClockToEpochMs,
} from '../src/lib/time';
import { formatRecordingDatetime } from '../src/lib/panel/client';

const TEHRAN = 'Asia/Tehran';
const NEW_YORK = 'America/New_York';

describe('wallClockToEpochMs', () => {
  it('resolves Tehran wall-clock to the right instant', () => {
    const epochMs = wallClockToEpochMs(
      { year: 2026, month: 8, day: 16, hour: 16, minute: 39, second: 59 },
      TEHRAN,
    );
    assert.equal(epochMs, Date.UTC(2026, 7, 16, 13, 9, 59));
  });

  it('is the identity for UTC', () => {
    const parts = { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
    assert.equal(wallClockToEpochMs(parts, 'UTC'), Date.UTC(2026, 0, 1, 0, 0, 0));
  });

  it('handles a zone that still observes DST, on both sides of the switch', () => {
    // US DST began 2026-03-08; 12:00 is EST before and EDT after.
    const winter = wallClockToEpochMs(
      { year: 2026, month: 1, day: 15, hour: 12, minute: 0, second: 0 },
      NEW_YORK,
    );
    const summer = wallClockToEpochMs(
      { year: 2026, month: 7, day: 15, hour: 12, minute: 0, second: 0 },
      NEW_YORK,
    );

    assert.equal(winter, Date.UTC(2026, 0, 15, 17, 0, 0)); // UTC-5
    assert.equal(summer, Date.UTC(2026, 6, 15, 16, 0, 0)); // UTC-4
  });
});

describe('offset formatting', () => {
  it('renders offsets the way the panel expects', () => {
    assert.equal(formatOffset(210), '+03:30');
    assert.equal(formatOffset(0), 'Z');
    assert.equal(formatOffset(-300), '-05:00');
  });

  it('reads Tehran as +03:30 year-round', () => {
    assert.equal(offsetMinutesAt(Date.UTC(2026, 0, 15), TEHRAN), 210);
    assert.equal(offsetMinutesAt(Date.UTC(2026, 6, 15), TEHRAN), 210);
  });
});

describe('panel datetime rendering', () => {
  const epochSeconds = Math.floor(Date.UTC(2026, 7, 16, 13, 9, 59) / 1000);
  const wallClock = { year: 2026, month: 8, day: 16, hour: 16, minute: 39, second: 59 };

  it('emits local time with an explicit offset by default', () => {
    assert.equal(
      formatRecordingDatetime(epochSeconds, wallClock, TEHRAN, 'iso_offset'),
      '2026-08-16T16:39:59+03:30',
    );
  });

  it('emits the same instant in UTC when asked', () => {
    assert.equal(
      formatRecordingDatetime(epochSeconds, wallClock, TEHRAN, 'iso_utc'),
      '2026-08-16T13:09:59Z',
    );
  });

  it('emits naive local time when asked', () => {
    assert.equal(
      formatRecordingDatetime(epochSeconds, wallClock, TEHRAN, 'iso_naive'),
      '2026-08-16T16:39:59',
    );
  });

  it('never pre-adds the offset to the clock time', () => {
    // The panel docs call this out as the classic mistake: 16:39+03:30 must not
    // become 20:09+03:30.
    const rendered = formatRecordingDatetime(epochSeconds, wallClock, TEHRAN, 'iso_offset');
    assert.ok(rendered.startsWith('2026-08-16T16:39:59'));
  });
});

describe('display helpers', () => {
  it('formats a date-only value in the target zone', () => {
    // 21:00 UTC is already the next day in Tehran.
    assert.equal(formatDateOnly(Date.UTC(2026, 7, 16, 21, 0, 0), TEHRAN), '2026-08-17');
    assert.equal(formatDateOnly(Date.UTC(2026, 7, 16, 21, 0, 0), 'UTC'), '2026-08-16');
  });

  it('formats UTC without milliseconds', () => {
    assert.equal(formatIsoUtc(Date.UTC(2026, 7, 16, 13, 9, 59)), '2026-08-16T13:09:59Z');
  });

  it('round-trips a wall clock through epoch and back', () => {
    const parts = { year: 2026, month: 3, day: 21, hour: 0, minute: 0, second: 1 };
    const epochMs = wallClockToEpochMs(parts, TEHRAN);
    assert.equal(formatIsoWithOffset(epochMs, TEHRAN), '2026-03-21T00:00:01+03:30');
  });
});
