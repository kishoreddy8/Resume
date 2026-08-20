import { getDb } from "@/db";
import crypto from "node:crypto";
import { hashPin, verifyPin } from "@/lib/auth/candidatePin";

/**
 * Storage and policy for profile PINs, lockout, and the owner account.
 *
 * THE LOCKOUT IS THE REAL CONTROL. A 4-digit PIN is 10,000 combinations; without a limit an
 * attacker walks the whole space in seconds over HTTP. Five wrong attempts locks the profile for
 * fifteen minutes, and the counter is stored in the database rather than in process memory so a
 * server restart cannot be used to clear it.
 */

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const SECRET_KEY = "profile_unlock_secret";

export interface CandidatePinState {
  candidateId: number;
  hasPin: boolean;
  isOwner: boolean;
  lockedUntil: string | null;
  failedAttempts: number;
}

interface PinRow {
  id: number;
  pin_hash: string | null;
  pin_salt: string | null;
  pin_failed_attempts: number;
  pin_locked_until: string | null;
  is_owner: number;
}

function row(candidateId: number): PinRow | undefined {
  return getDb()
    .prepare(
      `SELECT id, pin_hash, pin_salt, pin_failed_attempts, pin_locked_until, is_owner
         FROM candidates WHERE id = ?`
    )
    .get(candidateId) as PinRow | undefined;
}

/**
 * The signing secret for unlock tokens, generated once and persisted.
 *
 * Kept in the database rather than an env var so it survives restarts without configuration — if it
 * regenerated on every boot, every unlocked session would silently drop.
 */
export function getUnlockSecret(): string {
  const db = getDb();
  const existing = db.prepare("SELECT value FROM settings WHERE key = ?").get(SECRET_KEY) as
    | { value: string }
    | undefined;
  if (existing?.value) return existing.value;
  const secret = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    SECRET_KEY,
    secret
  );
  return secret;
}

export function getPinState(candidateId: number): CandidatePinState | null {
  const r = row(candidateId);
  if (!r) return null;
  return {
    candidateId: r.id,
    hasPin: Boolean(r.pin_hash && r.pin_salt),
    isOwner: r.is_owner === 1,
    lockedUntil: r.pin_locked_until,
    failedAttempts: r.pin_failed_attempts,
  };
}

/** A profile with no PIN is open by design — see the migration's note on why. */
export function isProtected(candidateId: number): boolean {
  return getPinState(candidateId)?.hasPin ?? false;
}

export function isOwner(candidateId: number): boolean {
  return getPinState(candidateId)?.isOwner ?? false;
}

export function getOwnerId(): number | null {
  const r = getDb().prepare("SELECT id FROM candidates WHERE is_owner = 1 LIMIT 1").get() as
    | { id: number }
    | undefined;
  return r?.id ?? null;
}

function lockRemainingMs(r: PinRow, now: number): number {
  if (!r.pin_locked_until) return 0;
  const until = Date.parse(r.pin_locked_until);
  if (Number.isNaN(until)) return 0;
  return Math.max(0, until - now);
}

export type PinAttempt =
  | { ok: true }
  | { ok: false; reason: "no_pin" | "not_found" }
  | { ok: false; reason: "locked"; retryAfterMs: number }
  | { ok: false; reason: "wrong"; attemptsRemaining: number };

/**
 * Verify a PIN, applying lockout. Never reveals whether a profile exists separately from whether
 * the PIN was wrong beyond what the caller already knows from the id it supplied.
 */
export function attemptPin(candidateId: number, pin: string, now = Date.now()): PinAttempt {
  const r = row(candidateId);
  if (!r) return { ok: false, reason: "not_found" };
  if (!r.pin_hash || !r.pin_salt) return { ok: false, reason: "no_pin" };

  const remaining = lockRemainingMs(r, now);
  if (remaining > 0) return { ok: false, reason: "locked", retryAfterMs: remaining };

  if (verifyPin(pin, r.pin_hash, r.pin_salt)) {
    getDb()
      .prepare("UPDATE candidates SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?")
      .run(candidateId);
    return { ok: true };
  }

  const attempts = r.pin_failed_attempts + 1;
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    const until = new Date(now + LOCKOUT_MS).toISOString();
    getDb()
      .prepare("UPDATE candidates SET pin_failed_attempts = ?, pin_locked_until = ? WHERE id = ?")
      .run(attempts, until, candidateId);
    return { ok: false, reason: "locked", retryAfterMs: LOCKOUT_MS };
  }
  getDb().prepare("UPDATE candidates SET pin_failed_attempts = ? WHERE id = ?").run(attempts, candidateId);
  return { ok: false, reason: "wrong", attemptsRemaining: MAX_FAILED_ATTEMPTS - attempts };
}

export function setPin(candidateId: number, pin: string): void {
  const { hash, salt } = hashPin(pin);
  getDb()
    .prepare(
      `UPDATE candidates
          SET pin_hash = ?, pin_salt = ?, pin_set_at = datetime('now'),
              pin_failed_attempts = 0, pin_locked_until = NULL
        WHERE id = ?`
    )
    .run(hash, salt, candidateId);
}

export function clearPin(candidateId: number): void {
  getDb()
    .prepare(
      `UPDATE candidates
          SET pin_hash = NULL, pin_salt = NULL, pin_set_at = NULL,
              pin_failed_attempts = 0, pin_locked_until = NULL
        WHERE id = ?`
    )
    .run(candidateId);
}
