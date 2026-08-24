/**
 * Timezone handling for recording timestamps.
 *
 * Asterisk writes the *local wall-clock* time into the recording filename
 * (20260816-163959 means 16:39:59 in the store's timezone). The downstream
 * panel wants ISO-8601 with an explicit UTC offset and warns against adding the
 * offset by hand, so the job here is: take naive wall-clock digits, resolve
 * them in a named IANA zone, and emit both a correct offset string and a true
 * UTC epoch.
 *
 * The offset is resolved through Intl rather than hardcoded to +03:30. Iran
 * dropped DST in 2022, but a policy reversal would silently shift every
 * timestamp by an hour if the offset were a constant.
 */

export interface WallClockParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Reads back the wall-clock a given instant shows in `timeZone`. */
function wallClockAt(epochMs: number, timeZone: string): WallClockParts {
  const parts = partsFormatter(timeZone).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  // Intl renders midnight as hour 24 in some engines; normalise it to 0.
  const hour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: hour === 24 ? 0 : hour,
    minute: get('minute'),
    second: get('second'),
  };
}

function asUtcMs(parts: WallClockParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** Offset of `timeZone` at a given instant, in minutes east of UTC. */
export function offsetMinutesAt(epochMs: number, timeZone: string): number {
  return (asUtcMs(wallClockAt(epochMs, timeZone)) - epochMs) / 60_000;
}

/**
 * Resolves naive wall-clock digits in `timeZone` to a UTC instant.
 *
 * Two passes: the first guess treats the digits as UTC and measures the zone
 * offset there; the second re-measures at the corrected instant, which is what
 * makes DST transition days come out right. Ambiguous times inside a
 * fall-back hour resolve to the earlier (pre-transition) instant.
 */
export function wallClockToEpochMs(parts: WallClockParts, timeZone: string): number {
  const naiveUtc = asUtcMs(parts);
  const firstGuess = naiveUtc - offsetMinutesAt(naiveUtc, timeZone) * 60_000;
  const secondGuess = naiveUtc - offsetMinutesAt(firstGuess, timeZone) * 60_000;
  return secondGuess;
}

function pad(value: number, width = 2): string {
  return String(Math.abs(value)).padStart(width, '0');
}

/** Formats minutes-east-of-UTC as `+03:30` / `-05:00` / `Z`. */
export function formatOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return 'Z';
  const sign = offsetMinutes > 0 ? '+' : '-';
  const total = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** `2026-08-16T16:39:59` — naive, no zone suffix. */
export function formatNaiveIso(parts: WallClockParts): string {
  return (
    `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}` +
    `T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
  );
}

/** `2026-08-16T16:39:59+03:30` — local wall-clock with its real offset. */
export function formatIsoWithOffset(epochMs: number, timeZone: string): string {
  const local = wallClockAt(epochMs, timeZone);
  return `${formatNaiveIso(local)}${formatOffset(offsetMinutesAt(epochMs, timeZone))}`;
}

/** `2026-08-16T13:09:59Z` — the same instant expressed in UTC. */
export function formatIsoUtc(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19)}Z`;
}

/** `2026-08-16` in the given zone — for the panel's `processing_date` DateField. */
export function formatDateOnly(epochMs: number, timeZone: string): string {
  const local = wallClockAt(epochMs, timeZone);
  return `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}`;
}

/** Human-readable local timestamp for the admin UI. */
export function formatLocalDisplay(epochSeconds: number, timeZone: string): string {
  const local = wallClockAt(epochSeconds * 1000, timeZone);
  return formatNaiveIso(local).replace('T', ' ');
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
