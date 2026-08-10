import { getDb } from "@/db";
import type { TailoringApprovalType, TailoringRunStatus } from "@/types";

/**
 * Persistence layer for tailoring_runs — see schema.sql's own comment on that table for the full
 * design record (identity, lifecycle, approval-provenance, and why no provider/model/API-cost
 * columns exist in Phase 3 V1). This module owns the two-phase started -> completed|failed
 * transition and enforces it at the query layer: a terminal row can never be completed/failed a
 * second time, matching "completed run directories are immutable" from the approved artifact
 * design (Stage 4, not yet built) one level up in the data model.
 *
 * Mirrors job_match_results'/candidate_job_state's identity discipline exactly: candidate_id +
 * dedupe_key is authoritative for every lookup; job_id is convenience/debug metadata only.
 */

export interface TailoringRunRow {
  id: number;
  candidate_id: number;
  dedupe_key: string;
  job_id: number | null;
  approval_type: TailoringApprovalType;
  decision_at_approval: string;
  approved_at: string;
  master_resume_hash: string | null;
  master_skills_hash: string | null;
  candidate_profile_hash: string | null;
  jd_content_hash: string | null;
  match_engine_version: number | null;
  recommended_track: string | null;
  selected_track: string | null;
  methodology_version: number | null;
  renderer_version: number | null;
  executed_by: string | null;
  status: TailoringRunStatus;
  job_fit_classification: string | null;
  /** JSON array of filenames — null while status='started'. */
  output_files: string | null;
  validation_passed: 0 | 1 | null;
  failure_reason: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface CreateTailoringRunInput {
  candidateId: number;
  dedupeKey: string;
  jobId?: number | null;
  approvalType: TailoringApprovalType;
  decisionAtApproval: string;
  /** The moment approval actually happened (e.g. candidate_job_state.tailoring_marked_at) — not
   *  necessarily "now"; a run can be started some time after its approval. */
  approvedAt: string;
  masterResumeHash?: string | null;
  masterSkillsHash?: string | null;
  candidateProfileHash?: string | null;
  jdContentHash?: string | null;
  matchEngineVersion?: number | null;
  recommendedTrack?: string | null;
  /** Set only when the executor already knows the track at start time (rare — usually decided
   *  during tailoring and set at completion instead, see CompleteTailoringRunInput.selectedTrack). */
  selectedTrack?: string | null;
  methodologyVersion?: number | null;
  rendererVersion?: number | null;
  executedBy?: string | null;
}

/** Phase 1 of the lifecycle — creates a 'started' row before any tailoring reasoning has run, so
 *  the returned id can determine an output directory (Stage 4) before Claude Code/Codex is even
 *  invoked. Never writes to job_match_results — this is purely the application's own record. */
export function createTailoringRun(input: CreateTailoringRunInput): TailoringRunRow {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO tailoring_runs
        (candidate_id, dedupe_key, job_id, approval_type, decision_at_approval, approved_at,
         master_resume_hash, master_skills_hash, candidate_profile_hash, jd_content_hash,
         match_engine_version, recommended_track, selected_track, methodology_version, renderer_version, executed_by)
       VALUES
        (@candidateId, @dedupeKey, @jobId, @approvalType, @decisionAtApproval, @approvedAt,
         @masterResumeHash, @masterSkillsHash, @candidateProfileHash, @jdContentHash,
         @matchEngineVersion, @recommendedTrack, @selectedTrack, @methodologyVersion, @rendererVersion, @executedBy)`
    )
    .run({
      candidateId: input.candidateId,
      dedupeKey: input.dedupeKey,
      jobId: input.jobId ?? null,
      approvalType: input.approvalType,
      decisionAtApproval: input.decisionAtApproval,
      approvedAt: input.approvedAt,
      masterResumeHash: input.masterResumeHash ?? null,
      masterSkillsHash: input.masterSkillsHash ?? null,
      candidateProfileHash: input.candidateProfileHash ?? null,
      jdContentHash: input.jdContentHash ?? null,
      matchEngineVersion: input.matchEngineVersion ?? null,
      recommendedTrack: input.recommendedTrack ?? null,
      selectedTrack: input.selectedTrack ?? null,
      methodologyVersion: input.methodologyVersion ?? null,
      rendererVersion: input.rendererVersion ?? null,
      executedBy: input.executedBy ?? null,
    });
  return getTailoringRun(input.candidateId, Number(result.lastInsertRowid))!;
}

/** candidate_id is required, not optional — same discipline as getLatestJobMatchResult: there is
 *  no "give me anyone's run" query anywhere in this codebase, by design. */
export function getTailoringRun(candidateId: number, id: number): TailoringRunRow | undefined {
  return getDb()
    .prepare("SELECT * FROM tailoring_runs WHERE candidate_id = ? AND id = ?")
    .get(candidateId, id) as TailoringRunRow | undefined;
}

/** Full history for one candidate's relationship to one job, newest first — id is the deterministic
 *  tie-break for rows created within the same datetime('now') second-resolution window. */
export function listTailoringRuns(candidateId: number, dedupeKey: string): TailoringRunRow[] {
  return getDb()
    .prepare("SELECT * FROM tailoring_runs WHERE candidate_id = ? AND dedupe_key = ? ORDER BY created_at DESC, id DESC")
    .all(candidateId, dedupeKey) as TailoringRunRow[];
}

export class TailoringRunNotFoundError extends Error {
  constructor(candidateId: number, id: number) {
    super(`No tailoring run ${id} found for candidate ${candidateId}`);
    this.name = "TailoringRunNotFoundError";
  }
}

export class TailoringRunNotStartedError extends Error {
  constructor(id: number, actualStatus: TailoringRunStatus) {
    super(`Tailoring run ${id} is already '${actualStatus}' — completed/failed runs are immutable and cannot be completed or failed again.`);
    this.name = "TailoringRunNotStartedError";
  }
}

export interface CompleteTailoringRunInput {
  outputFiles: string[];
  validationPassed: boolean;
  jobFitClassification?: string | null;
  selectedTrack?: string | null;
  /** Allows setting executed_by at completion time if it wasn't known when the run was created. */
  executedBy?: string | null;
}

/**
 * Phase 2 of the lifecycle — 'started' -> 'completed'. Throws TailoringRunNotFoundError if no such
 * run exists for this candidate, or TailoringRunNotStartedError if the run has already reached a
 * terminal status (immutability enforced here, not just by convention).
 */
export function completeTailoringRun(candidateId: number, id: number, input: CompleteTailoringRunInput): TailoringRunRow {
  const current = getTailoringRun(candidateId, id);
  if (!current) throw new TailoringRunNotFoundError(candidateId, id);
  if (current.status !== "started") throw new TailoringRunNotStartedError(id, current.status);

  getDb()
    .prepare(
      `UPDATE tailoring_runs SET
         status = 'completed',
         output_files = @outputFiles,
         validation_passed = @validationPassed,
         job_fit_classification = @jobFitClassification,
         selected_track = COALESCE(@selectedTrack, selected_track),
         executed_by = COALESCE(@executedBy, executed_by),
         completed_at = datetime('now')
       WHERE candidate_id = @candidateId AND id = @id`
    )
    .run({
      outputFiles: JSON.stringify(input.outputFiles),
      validationPassed: input.validationPassed ? 1 : 0,
      jobFitClassification: input.jobFitClassification ?? null,
      selectedTrack: input.selectedTrack ?? null,
      executedBy: input.executedBy ?? null,
      candidateId,
      id,
    });
  return getTailoringRun(candidateId, id)!;
}

/**
 * Phase 2 of the lifecycle — 'started' -> 'failed'. A failed run must still be recorded (never
 * silently left 'started' forever) — same TailoringRunNotFoundError/TailoringRunNotStartedError
 * guards as completeTailoringRun.
 */
export function failTailoringRun(candidateId: number, id: number, failureReason: string): TailoringRunRow {
  const current = getTailoringRun(candidateId, id);
  if (!current) throw new TailoringRunNotFoundError(candidateId, id);
  if (current.status !== "started") throw new TailoringRunNotStartedError(id, current.status);

  getDb()
    .prepare(
      `UPDATE tailoring_runs SET status = 'failed', failure_reason = ?, completed_at = datetime('now')
       WHERE candidate_id = ? AND id = ?`
    )
    .run(failureReason, candidateId, id);
  return getTailoringRun(candidateId, id)!;
}
