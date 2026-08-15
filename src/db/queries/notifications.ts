import { getDb } from "@/db";

/**
 * Phase 4 Stage 4 — in-app candidate notification persistence. Every function here is explicitly
 * candidate-scoped (candidate_id is always part of the WHERE clause, never inferred) — same
 * discipline as candidate_job_state's query layer. See schema.sql's notifications table comment for
 * the UNIQUE(candidate_id, dedupe_key, type) identity/dedup invariant this module relies on.
 */

export interface NotificationRow {
  id: number;
  candidate_id: number;
  dedupe_key: string;
  type: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export interface CreateNotificationInput {
  candidateId: number;
  dedupeKey: string;
  type: string;
  title: string;
  body: string;
}

/**
 * Conflict-safe insert. The UNIQUE(candidate_id, dedupe_key, type) constraint — not a check-then-
 * insert race — is the actual dedup mechanism: `ON CONFLICT DO NOTHING` makes a duplicate call a
 * true no-op at the database level even under concurrent/repeated execution. Returns true only when
 * a NEW row was actually created (`changes === 1`); false when one already existed.
 */
export function createNotificationIfAbsent(input: CreateNotificationInput): boolean {
  const result = getDb()
    .prepare(
      `INSERT INTO notifications (candidate_id, dedupe_key, type, title, body)
       VALUES (@candidateId, @dedupeKey, @type, @title, @body)
       ON CONFLICT(candidate_id, dedupe_key, type) DO NOTHING`
    )
    .run(input);
  return result.changes === 1;
}

export interface ListNotificationsOptions {
  unreadOnly?: boolean;
  limit?: number;
}

export function listNotificationsForCandidate(candidateId: number, options: ListNotificationsOptions = {}): NotificationRow[] {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const db = getDb();
  if (options.unreadOnly) {
    return db
      .prepare(`SELECT * FROM notifications WHERE candidate_id = ? AND read_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(candidateId, limit) as NotificationRow[];
  }
  return db
    .prepare(`SELECT * FROM notifications WHERE candidate_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(candidateId, limit) as NotificationRow[];
}

export function getUnreadNotificationCount(candidateId: number): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM notifications WHERE candidate_id = ? AND read_at IS NULL`)
    .get(candidateId) as { count: number };
  return row.count;
}

export type MarkNotificationReadResult = "marked" | "already_read" | "not_found";

/** Candidate-scoped by construction: the WHERE clause includes candidate_id, so a notification id
 *  belonging to a DIFFERENT candidate can never be marked read here — it reads back as "not_found"
 *  for this candidate, never a silent cross-candidate success. */
export function markNotificationRead(candidateId: number, notificationId: number): MarkNotificationReadResult {
  const db = getDb();
  const result = db
    .prepare(`UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND candidate_id = ? AND read_at IS NULL`)
    .run(notificationId, candidateId);
  if (result.changes === 1) return "marked";

  const existing = db.prepare(`SELECT id FROM notifications WHERE id = ? AND candidate_id = ?`).get(notificationId, candidateId);
  return existing ? "already_read" : "not_found";
}

/** Returns the number of notifications actually transitioned from unread to read (0 if there were
 *  none) — always candidate-scoped. */
export function markAllNotificationsRead(candidateId: number): number {
  const result = getDb()
    .prepare(`UPDATE notifications SET read_at = datetime('now') WHERE candidate_id = ? AND read_at IS NULL`)
    .run(candidateId);
  return result.changes;
}
