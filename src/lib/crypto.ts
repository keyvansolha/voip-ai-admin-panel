import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { env } from './env';

/**
 * Two separate concerns live here:
 *
 *  1. Secret storage — Gemini keys, service-account JSON and the downstream
 *     panel token are encrypted with AES-256-GCM before they touch SQLite, so a
 *     stolen `data/app.db` alone does not leak credentials.
 *  2. Password + token hashing — scrypt for the admin password, SHA-256 for
 *     session tokens (which are already high-entropy random values).
 */

const ENCRYPTION_PREFIX = 'v1';

/** Domain-separated key derivation so the same APP_SECRET can back several uses. */
function deriveKey(purpose: string): Buffer {
  return scryptSync(env.appSecret, `voip-ai-panel:${purpose}`, 32);
}

let cachedEncryptionKey: Buffer | null = null;
function encryptionKey(): Buffer {
  cachedEncryptionKey ??= deriveKey('secret-encryption');
  return cachedEncryptionKey;
}

/** Encrypts a UTF-8 string to `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Reverses {@link encryptSecret}. Throws if APP_SECRET changed or the row was
 * tampered with — callers treat that as "credential needs re-entering".
 */
export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== ENCRYPTION_PREFIX) {
    throw new Error('Malformed encrypted value');
  }
  const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

// --- Passwords -------------------------------------------------------------

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

/** Returns `scrypt$<N>$<r>$<p>$<salt>$<hash>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    ...SCRYPT_PARAMS,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const expected = Buffer.from(hashRaw, 'base64url');
  let actual: Buffer;
  try {
    actual = scryptSync(password.normalize('NFKC'), Buffer.from(saltRaw, 'base64url'), expected.length, {
      N: Number(nRaw),
      r: Number(rRaw),
      p: Number(pRaw),
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// --- Tokens ----------------------------------------------------------------

/** URL-safe random token; the raw value is shown once and never stored. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Session tokens and the ingest token are compared by HMAC, never in plaintext. */
export function hashToken(token: string): string {
  return createHmac('sha256', deriveKey('token-hash')).update(token).digest('base64url');
}

/**
 * Constant-time compare for two strings of unknown length. Length is leaked
 * (unavoidable without hashing), which is fine for fixed-width tokens.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
