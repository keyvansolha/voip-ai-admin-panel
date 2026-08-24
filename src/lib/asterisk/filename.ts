import { formatIsoWithOffset, formatNaiveIso, wallClockToEpochMs, type WallClockParts } from '../time';

/**
 * Parses Asterisk recording filenames.
 *
 *   q-5001-989912107914-20260816-163959-1786882183.3683.wav
 *   └┬┘ └┬─┘ └────┬─────┘ └───┬──┘ └─┬──┘ └───┬────┘ └─┬─┘
 *    │   │        │           │      │        │       └── seq  (ast_unique_seq)
 *    │   │        │           │      │        └────────── uid
 *    │   │        │           │      └─────────────────── HHMMSS, store-local
 *    │   │        │           └────────────────────────── YYYYMMDD, store-local
 *    │   │        └────────────────────────────────────── p2
 *    │   └─────────────────────────────────────────────── p1
 *    └─────────────────────────────────────────────────── type
 *
 * Which of p1/p2 holds the customer's number depends on the type, because
 * queue and extension recordings put the internal leg first.
 */

export const AST_TYPES = ['in', 'out', 'exten', 'q'] as const;
export type AstType = (typeof AST_TYPES)[number];

export const DIRECTIONS = ['inbound', 'outbound', 'internal'] as const;
export type Direction = (typeof DIRECTIONS)[number];

const FILENAME_RE =
  /^(?<type>in|out|exten|q)-(?<p1>[^-]+)-(?<p2>[^-]+)-(?<d>\d{8})-(?<t>\d{6})-(?<uid>\d+)\.(?<seq>\d+)(?:\.\w+)?$/i;

export interface ParsedFilename {
  ok: true;
  astType: AstType;
  astUid: number;
  astUniqueSeq: number;
  direction: Direction;
  customerPhone: string | null;
  /** Wall-clock digits exactly as they appear in the filename. */
  wallClock: WallClockParts;
  /** `2026-08-16T16:39:59` — no zone suffix. */
  localIso: string;
  /** `2026-08-16T16:39:59+03:30` — what the downstream panel wants. */
  offsetIso: string;
  /** True UTC instant, seconds. */
  epochSeconds: number;
}

export interface UnparsedFilename {
  ok: false;
  reason: string;
}

export type FilenameParseResult = ParsedFilename | UnparsedFilename;

function directionFor(astType: AstType): Direction {
  // Queue calls are inbound calls that landed in a queue.
  if (astType === 'in' || astType === 'q') return 'inbound';
  if (astType === 'out') return 'outbound';
  return 'internal';
}

/**
 * `in`/`out` recordings name the outside party first; `q`/`exten` name the
 * internal leg first, so the customer is the second field.
 */
function customerPhoneFor(astType: AstType, p1: string, p2: string): string | null {
  const raw = astType === 'in' || astType === 'out' ? p1 : p2;
  const trimmed = raw?.trim();
  return trimmed ? trimmed.slice(0, 32) : null;
}

/**
 * @param timeZone IANA zone the Asterisk box writes its filenames in
 *                 (the store's local time, e.g. `Asia/Tehran`).
 */
export function parseAsteriskFilename(name: string, timeZone: string): FilenameParseResult {
  const match = String(name ?? '').match(FILENAME_RE);
  if (!match?.groups) {
    return { ok: false, reason: 'filename does not match the Asterisk recording pattern' };
  }

  const { type, p1, p2, d, t, uid, seq } = match.groups as Record<string, string>;
  const astType = type!.toLowerCase() as AstType;

  const wallClock: WallClockParts = {
    year: Number(d!.slice(0, 4)),
    month: Number(d!.slice(4, 6)),
    day: Number(d!.slice(6, 8)),
    hour: Number(t!.slice(0, 2)),
    minute: Number(t!.slice(2, 4)),
    second: Number(t!.slice(4, 6)),
  };

  if (
    wallClock.month < 1 ||
    wallClock.month > 12 ||
    wallClock.day < 1 ||
    wallClock.day > 31 ||
    wallClock.hour > 23 ||
    wallClock.minute > 59 ||
    wallClock.second > 59
  ) {
    return { ok: false, reason: `filename contains an impossible date/time: ${d}-${t}` };
  }

  const epochMs = wallClockToEpochMs(wallClock, timeZone);

  return {
    ok: true,
    astType,
    astUid: Number(uid),
    astUniqueSeq: Number(seq),
    direction: directionFor(astType),
    customerPhone: customerPhoneFor(astType, p1!, p2!),
    wallClock,
    localIso: formatNaiveIso(wallClock),
    offsetIso: formatIsoWithOffset(epochMs, timeZone),
    epochSeconds: Math.floor(epochMs / 1000),
  };
}

/**
 * Reduces an uploaded name to a bare basename: drops any directory component
 * (so `../../etc/passwd` becomes `passwd`) and strips control characters.
 * Hyphens and dots are preserved — they are the Asterisk field separators.
 */
export function sanitizeFilename(name: string): string {
  return String(name ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 255);
}
