import { getDb } from "@/db";

/**
 * Phase 2.5: candidate identity. candidates.id is INTEGER PRIMARY KEY AUTOINCREMENT (unlike
 * companies.id/jobs.id), so it is never reused even if a row is ever hard-deleted — safe to thread
 * through file paths and every candidate-scoped table without an id-reuse identity-safety concern.
 */

export interface CandidateRow {
  id: number;
  first_name: string;
  last_name: string;
  display_name: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
  /** Presentation-safe: whether a PIN exists, never the PIN material itself. */
  has_pin: 0 | 1;
  is_owner: 0 | 1;
}

/**
 * Explicit column list, never SELECT *.
 *
 * The PIN migration added pin_hash and pin_salt to this table, and SELECT * put both on the wire
 * through /api/candidates — which is unauthenticated by necessity, since the profile picker has to
 * list profiles before anyone has unlocked anything. Publishing the hash and salt would have made
 * the PIN worthless: 10,000 combinations is seconds of offline work once you hold them.
 *
 * `has_pin` is derived here so callers can render a lock icon without ever seeing the secret, and
 * the lockout counters stay server-side because they are attacker-useful feedback.
 */
const CANDIDATE_SELECT = `
  id, first_name, last_name, display_name, status, created_at, updated_at,
  CASE WHEN pin_hash IS NOT NULL AND pin_salt IS NOT NULL THEN 1 ELSE 0 END AS has_pin,
  is_owner
`;

export function listCandidates(includeArchived = false): CandidateRow[] {
  const db = getDb();
  if (includeArchived) {
    return db.prepare(`SELECT ${CANDIDATE_SELECT} FROM candidates ORDER BY id`).all() as CandidateRow[];
  }
  return db
    .prepare(`SELECT ${CANDIDATE_SELECT} FROM candidates WHERE status = 'active' ORDER BY id`)
    .all() as CandidateRow[];
}

export function getCandidate(candidateId: number): CandidateRow | undefined {
  return getDb()
    .prepare(`SELECT ${CANDIDATE_SELECT} FROM candidates WHERE id = ?`)
    .get(candidateId) as CandidateRow | undefined;
}

/** Every candidate-scoped API handler must call this before doing anything — explicit validation
 *  that the id in the request actually refers to an active candidate, never assumed. This is data-
 *  isolation/correctness (preventing the app from accidentally mixing profiles), not an
 *  authentication/authorization boundary — there are no security principals in this local app. */
export function requireActiveCandidate(candidateId: number): CandidateRow | null {
  const candidate = getCandidate(candidateId);
  if (!candidate || candidate.status !== "active") return null;
  return candidate;
}

export interface CreateCandidateInput {
  firstName: string;
  lastName: string;
}

export function createCandidate(input: CreateCandidateInput): CandidateRow {
  const db = getDb();
  const displayName = `${input.firstName} ${input.lastName}`.trim();
  const result = db
    .prepare("INSERT INTO candidates (first_name, last_name, display_name) VALUES (?, ?, ?)")
    .run(input.firstName, input.lastName, displayName);
  db.prepare(
    `INSERT INTO candidate_settings (candidate_id) VALUES (?)`
  ).run(result.lastInsertRowid);
  return getCandidate(Number(result.lastInsertRowid))!;
}

export interface UpdateCandidateNameInput {
  firstName: string;
  lastName: string;
  /**
   * The name shown on generated documents, verbatim.
   *
   * Stage 31.1 — this is deliberately NOT reconstructed from firstName + lastName when supplied.
   * createCandidate() joins the two parts because at creation there is nothing else to go on, and
   * that join is exactly how a display name drifts from the name a person actually writes: a
   * candidate whose given name is "Saikishore" entered as first="Sai Kishore" renders forever as
   * "Sai Kishore Reddy", and no amount of correcting the renderer can fix a wrong stored value.
   * Omitting it falls back to the join, so the two callers that genuinely have no display name keep
   * working; supplying it means "store exactly this".
   */
  displayName?: string;
}

/**
 * Corrects a candidate's stored name. The candidates row is the single authoritative source of the
 * name every generated document and filename uses, and until Stage 31.1 there was no way to change
 * it at all — only create and archive — so a name entered wrongly at creation could never be fixed
 * anywhere except by editing the database by hand.
 *
 * Nothing here touches the Master Resume/Skills files or the derived candidate profile: those are
 * the candidate's EVIDENCE and are owned elsewhere. This is the registry record.
 */
export function updateCandidateName(candidateId: number, input: UpdateCandidateNameInput): CandidateRow | undefined {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const displayName = (input.displayName ?? `${firstName} ${lastName}`).trim();
  if (firstName.length === 0 || lastName.length === 0 || displayName.length === 0) {
    throw new Error("Candidate first name, last name, and display name must all be non-empty.");
  }
  getDb()
    .prepare(
      "UPDATE candidates SET first_name = ?, last_name = ?, display_name = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .run(firstName, lastName, displayName, candidateId);
  return getCandidate(candidateId);
}

export function archiveCandidate(candidateId: number): CandidateRow | undefined {
  const db = getDb();
  db.prepare("UPDATE candidates SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(candidateId);
  return getCandidate(candidateId);
}

// --- Active-candidate UX default (see CAREER_OPS_HANDOFF.md's Phase 2.5 design record §8/9): this
// is a convenience default for which candidateId a fresh page load's URL/selector starts on. It is
// NEVER used inside an API handler as the source of truth for a candidate-scoped operation — every
// handler requires candidateId explicitly in the request. Stored as a row in the existing global
// `settings` key-value table (reusing Phase 1's own convention) rather than a new table.
const ACTIVE_CANDIDATE_SETTINGS_KEY = "candidate_ui.active_candidate_id";

export function getActiveCandidateId(): number {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(ACTIVE_CANDIDATE_SETTINGS_KEY) as { value: string } | undefined;
  if (row) {
    const parsed = Number(row.value);
    if (Number.isInteger(parsed) && requireActiveCandidate(parsed)) return parsed;
  }
  return 1; // Candidate #1 — always exists (auto-seeded by src/db/index.ts's ensureCandidateOne)
}

export function setActiveCandidateId(candidateId: number): void {
  if (!requireActiveCandidate(candidateId)) {
    throw new Error(`Cannot set active candidate to ${candidateId}: not an active candidate`);
  }
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run({ key: ACTIVE_CANDIDATE_SETTINGS_KEY, value: String(candidateId) });
}
