import crypto from "node:crypto";

/**
 * Profile PIN: hashing, verification, and the signed unlock token.
 *
 * WHAT THIS PROTECTS, STATED HONESTLY. A 4-digit PIN is 10,000 combinations. scrypt makes each
 * guess cost real work, but anyone who steals app.db can still exhaust that space offline. The
 * control that actually stops an attack is the LOCKOUT in candidatePinStore.ts; the hashing exists
 * so a stolen database does not hand over PINs instantly, not because 4 digits can ever be strong.
 * This is a barrier between people sharing a machine or a LAN — not protection against an attacker
 * holding the file.
 *
 * Comparisons are timing-safe. The PIN is never logged, never returned by an API, never stored raw.
 */

const SCRYPT_KEYLEN = 32;
/** Above scrypt's default cost: a 4-digit space needs every millisecond it can get. */
const SCRYPT_OPTS: crypto.ScryptOptions = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

export const PIN_PATTERN = /^\d{4}$/;
/** 30 minutes, per the product decision — re-prompt after that, not on every request. */
export const UNLOCK_TTL_MS = 30 * 60 * 1000;
export const UNLOCK_COOKIE = "co_profile_unlock";

export function isValidPinFormat(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

export function hashPin(pin: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pin, salt, SCRYPT_KEYLEN, SCRYPT_OPTS).toString("hex");
  return { hash, salt };
}

/** Timing-safe. Returns false for malformed stored values rather than throwing. */
export function verifyPin(pin: string, hash: string, salt: string): boolean {
  if (!hash || !salt) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hash, "hex");
  } catch {
    return false;
  }
  const actual = crypto.scryptSync(pin, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

// --- Unlock token -----------------------------------------------------------------------------

export interface UnlockPayload {
  /** Candidate ids this browser has unlocked. */
  ids: number[];
  /** Absolute expiry, ms since epoch. */
  exp: number;
}

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * `<payload>.<hmac>`. The payload is readable but not forgeable: any edit breaks the HMAC, so a
 * browser cannot add a candidate id it never unlocked. Carried in an HttpOnly cookie, so page
 * scripts cannot read it either.
 */
export function signUnlockToken(payload: UnlockPayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf-8"));
  const mac = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

/** Null for anything tampered with, malformed, or expired — never a partial result. */
export function verifyUnlockToken(
  token: string | undefined,
  secret: string,
  now = Date.now()
): UnlockPayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(b64url(crypto.createHmac("sha256", secret).update(body).digest()));
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromB64url(body).toString("utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Partial<UnlockPayload>;
  if (typeof p.exp !== "number" || !Array.isArray(p.ids)) return null;
  if (p.exp <= now) return null;
  if (!p.ids.every((n) => Number.isInteger(n) && n > 0)) return null;
  return { ids: p.ids, exp: p.exp };
}
