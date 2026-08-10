import { getDb } from "@/db";
import { PROTECTED_PIPELINE_STATUSES } from "@/lib/jobLifecycle";
import type { PipelineStatus, TailoringApprovalType } from "@/types";

/**
 * Phase 2.5 — candidate_job_state: one candidate's personal relationship to one shared job, keyed on
 * (candidate_id, dedupe_key), NOT job_id (same identity-safety philosophy as job_match_results/
 * suppressed_jobs — survives the underlying job row being deleted). Legacy jobs.pipeline_status/
 * pinned/notes/tags/marked_for_tailoring are frozen, read-only snapshots as of the Stage 5 migration
 * — every write from here forward goes through this module instead.
 */

export interface CandidateJobStateRow {
  id: number;
  candidate_id: number;
  dedupe_key: string;
  pipeline_status: PipelineStatus;
  pipeline_updated_at: string | null;
  marked_for_tailoring: 0 | 1;
  tailoring_marked_at: string | null;
  /** Set only alongside marked_for_tailoring=1, cleared alongside marked_for_tailoring=0 — never
   *  inferred/guessed when the caller omits approval context (see setMarkedForTailoring below). */
  tailoring_approval_type: TailoringApprovalType | null;
  /** The Phase 2 decision ('READY_FOR_TAILORING' | 'NEEDS_REVIEW') being approved, frozen at the
   *  moment of approval — never re-derived from a later job_match_results row. */
  tailoring_approved_decision: string | null;
  pinned: 0 | 1;
  not_interested: 0 | 1;
  not_interested_at: string | null;
  not_interested_reason: string | null;
  notes: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULTS = {
  pipeline_status: "New" as PipelineStatus,
  pipeline_updated_at: null,
  marked_for_tailoring: 0 as const,
  tailoring_marked_at: null,
  tailoring_approval_type: null,
  tailoring_approved_decision: null,
  pinned: 0 as const,
  not_interested: 0 as const,
  not_interested_at: null,
  not_interested_reason: null,
  notes: null,
  tags: null,
};

/** Absence of a row means "all defaults" — this is the whole point of the design: a job with no
 *  personal relationship yet (the overwhelming common case at scale) needs zero storage. */
export function getCandidateJobState(candidateId: number, dedupeKey: string): CandidateJobStateRow | undefined {
  return getDb()
    .prepare("SELECT * FROM candidate_job_state WHERE candidate_id = ? AND dedupe_key = ?")
    .get(candidateId, dedupeKey) as CandidateJobStateRow | undefined;
}

/** Batch fetch for list/ranking views — one query for every dedupe_key on the visible page. Jobs
 *  with no row are simply absent from the returned map (caller applies the same DEFAULTS). */
export function listCandidateJobStates(candidateId: number, dedupeKeys: string[]): Record<string, CandidateJobStateRow> {
  if (dedupeKeys.length === 0) return {};
  const db = getDb();
  const placeholders = dedupeKeys.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM candidate_job_state WHERE candidate_id = ? AND dedupe_key IN (${placeholders})`)
    .all(candidateId, ...dedupeKeys) as CandidateJobStateRow[];
  const result: Record<string, CandidateJobStateRow> = {};
  for (const row of rows) result[row.dedupe_key] = row;
  return result;
}

function ensureRow(candidateId: number, dedupeKey: string) {
  getDb()
    .prepare(
      `INSERT INTO candidate_job_state (candidate_id, dedupe_key) VALUES (?, ?)
       ON CONFLICT(candidate_id, dedupe_key) DO NOTHING`
    )
    .run(candidateId, dedupeKey);
}

function recordHistory(candidateId: number, dedupeKey: string, changeType: string, oldValue: string | null, newValue: string | null, reason: string | null) {
  getDb()
    .prepare(
      `INSERT INTO candidate_job_state_history (candidate_id, dedupe_key, change_type, old_value, new_value, reason)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(candidateId, dedupeKey, changeType, oldValue, newValue, reason);
}

export function setPipelineStatus(candidateId: number, dedupeKey: string, status: PipelineStatus): CandidateJobStateRow {
  ensureRow(candidateId, dedupeKey);
  const current = getCandidateJobState(candidateId, dedupeKey)!;
  const oldStatus = current.pipeline_status;
  getDb()
    .prepare(
      `UPDATE candidate_job_state SET pipeline_status = ?, pipeline_updated_at = datetime('now'), updated_at = datetime('now')
       WHERE candidate_id = ? AND dedupe_key = ?`
    )
    .run(status, candidateId, dedupeKey);
  if (oldStatus !== status) recordHistory(candidateId, dedupeKey, "pipeline_status", oldStatus, status, null);
  return getCandidateJobState(candidateId, dedupeKey)!;
}

export function setPinned(candidateId: number, dedupeKey: string, pinned: boolean): CandidateJobStateRow {
  ensureRow(candidateId, dedupeKey);
  const current = getCandidateJobState(candidateId, dedupeKey)!;
  getDb()
    .prepare("UPDATE candidate_job_state SET pinned = ?, updated_at = datetime('now') WHERE candidate_id = ? AND dedupe_key = ?")
    .run(pinned ? 1 : 0, candidateId, dedupeKey);
  if (Boolean(current.pinned) !== pinned) recordHistory(candidateId, dedupeKey, "pinned", String(current.pinned), String(pinned ? 1 : 0), null);
  return getCandidateJobState(candidateId, dedupeKey)!;
}

/**
 * Approval context for marking a job for tailoring — see the approved Phase 3 V1 approval model.
 * `approvalType` distinguishes a direct READY_FOR_TAILORING approval from an explicit
 * NEEDS_REVIEW override; `decision` is the actual Phase 2 decision being approved, frozen at this
 * moment. Optional on this function (see below) so the existing, unmodified PATCH /api/jobs/[id]
 * route — which predates this approval model and doesn't yet supply it — keeps working exactly as
 * before; when omitted, both fields are simply left null, never guessed.
 */
export interface TailoringApprovalContext {
  approvalType: TailoringApprovalType;
  decision: string;
}

/**
 * marked=true with no `approval` argument sets marked_for_tailoring the same way it always has,
 * leaving tailoring_approval_type/tailoring_approved_decision null — this function never infers or
 * guesses those two fields on its own. marked=false always clears both, regardless of whether they
 * were previously set, so stale approval context never survives an un-mark.
 */
export function setMarkedForTailoring(
  candidateId: number,
  dedupeKey: string,
  marked: boolean,
  approval?: TailoringApprovalContext
): CandidateJobStateRow {
  ensureRow(candidateId, dedupeKey);
  const current = getCandidateJobState(candidateId, dedupeKey)!;
  getDb()
    .prepare(
      `UPDATE candidate_job_state SET
         marked_for_tailoring = ?,
         tailoring_marked_at = CASE WHEN ? THEN datetime('now') ELSE tailoring_marked_at END,
         tailoring_approval_type = ?,
         tailoring_approved_decision = ?,
         updated_at = datetime('now')
       WHERE candidate_id = ? AND dedupe_key = ?`
    )
    .run(
      marked ? 1 : 0,
      marked ? 1 : 0,
      marked && approval ? approval.approvalType : null,
      marked && approval ? approval.decision : null,
      candidateId,
      dedupeKey
    );
  if (Boolean(current.marked_for_tailoring) !== marked) recordHistory(candidateId, dedupeKey, "tailoring", String(current.marked_for_tailoring), String(marked ? 1 : 0), null);
  return getCandidateJobState(candidateId, dedupeKey)!;
}

export function setNotesAndTags(candidateId: number, dedupeKey: string, notes: string | null, tags: string[] | null): CandidateJobStateRow {
  ensureRow(candidateId, dedupeKey);
  getDb()
    .prepare(
      `UPDATE candidate_job_state SET notes = ?, tags = ?, updated_at = datetime('now') WHERE candidate_id = ? AND dedupe_key = ?`
    )
    .run(notes, tags ? JSON.stringify(tags) : null, candidateId, dedupeKey);
  return getCandidateJobState(candidateId, dedupeKey)!;
}

/**
 * Candidate-personal "Not Interested" — deliberately DOES NOT touch the `jobs` row or the global
 * `suppressed_jobs` table at all (see CAREER_OPS_HANDOFF.md's Phase 2.5 design record §2/13). The
 * job remains fully intact and visible to every other candidate; only this candidate's own
 * candidate_job_state row is marked, and only this candidate's own ranking/list queries exclude it.
 */
export function setNotInterested(candidateId: number, dedupeKey: string, notInterested: boolean, reason: string | null = null): CandidateJobStateRow {
  ensureRow(candidateId, dedupeKey);
  const current = getCandidateJobState(candidateId, dedupeKey)!;
  getDb()
    .prepare(
      `UPDATE candidate_job_state SET not_interested = ?, not_interested_at = CASE WHEN ? THEN datetime('now') ELSE not_interested_at END,
         not_interested_reason = ?, updated_at = datetime('now')
       WHERE candidate_id = ? AND dedupe_key = ?`
    )
    .run(notInterested ? 1 : 0, notInterested ? 1 : 0, reason, candidateId, dedupeKey);
  if (Boolean(current.not_interested) !== notInterested) recordHistory(candidateId, dedupeKey, "not_interested", String(current.not_interested), String(notInterested ? 1 : 0), reason);
  return getCandidateJobState(candidateId, dedupeKey)!;
}

export function listCandidateJobStateHistory(candidateId: number, dedupeKey: string) {
  return getDb()
    .prepare("SELECT * FROM candidate_job_state_history WHERE candidate_id = ? AND dedupe_key = ? ORDER BY id DESC")
    .all(candidateId, dedupeKey);
}

/**
 * Cross-candidate lifecycle protection (see CAREER_OPS_HANDOFF.md's Phase 2.5 design record §1):
 * the shared `jobs` row can only have ONE protection verdict even though pipeline_status/pinned are
 * now candidate-scoped — a job stays protected from the global age-sweep/archive if ANY candidate
 * has it in a protected pipeline stage or pinned. This does NOT change src/lib/jobLifecycle.ts's
 * isLifecycleProtected/canArchive/canDelete logic at all — it only changes what data those pure
 * functions' callers feed them, moving the source from the frozen jobs.pipeline_status/jobs.pinned
 * columns to this cross-candidate query.
 */
export function isProtectedForAnyCandidate(dedupeKey: string): boolean {
  const db = getDb();
  const placeholders = PROTECTED_PIPELINE_STATUSES.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT 1 FROM candidate_job_state
       WHERE dedupe_key = ? AND (pipeline_status IN (${placeholders}) OR pinned = 1)
       LIMIT 1`
    )
    .get(dedupeKey, ...PROTECTED_PIPELINE_STATUSES);
  return Boolean(row);
}

export const CANDIDATE_JOB_STATE_DEFAULTS = DEFAULTS;
