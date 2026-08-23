import { getDb } from "@/db";

/**
 * Persistence layer for resume_quality_human_approvals — see schema.sql's own comment on that table
 * for the full provenance design record. A candidate's explicit, auditable approval of a
 * SAFE_BEST_ATTEMPT resume, tied to the exact workflow_id (and iteration) reviewed. Never mutates
 * resume_quality_workflows — READY keeps meaning exactly "the autonomous quality gate passed".
 *
 * Mirrors resumeQualityWorkflows.ts's identity discipline: candidate_id is required on every lookup.
 */

export interface ResumeQualityHumanApprovalRow {
  id: number;
  candidate_id: number;
  workflow_id: number;
  tailoring_run_id: number;
  job_id: number | null;
  dedupe_key: string;
  selected_iteration_number: number;
  overall_score: number | null;
  ats_score: number | null;
  truthfulness_score: number | null;
  architecture_consistency_score: number | null;
  instruction_version: string | null;
  instruction_hash: string | null;
  /** JSON-encoded SafetyVerdict (finalDisposition.ts) captured at approval time. Audit only — never
   *  re-trusted as a current safety decision. */
  safety_verdict_json: string;
  notes: string | null;
  approved_at: string;
}

export interface SaveHumanApprovalInput {
  candidateId: number;
  workflowId: number;
  tailoringRunId: number;
  jobId: number | null;
  dedupeKey: string;
  selectedIterationNumber: number;
  overallScore: number | null;
  atsScore: number | null;
  truthfulnessScore: number | null;
  architectureConsistencyScore: number | null;
  instructionVersion: string | null;
  instructionHash: string | null;
  /** Any JSON-serializable safety verdict — the caller supplies the canonical evaluateSafety() result
   *  verbatim; this module never computes or re-derives it. */
  safetyVerdict: unknown;
  notes?: string | null;
}

/** The one workflow-scoped approval, or undefined if this exact workflow has never been approved.
 *  Never falls back to candidate_id + dedupe_key — an older workflow's approval for the same job must
 *  never be found here for a newer workflow_id. */
export function getHumanApprovalForWorkflow(candidateId: number, workflowId: number): ResumeQualityHumanApprovalRow | undefined {
  return getDb()
    .prepare("SELECT * FROM resume_quality_human_approvals WHERE candidate_id = ? AND workflow_id = ?")
    .get(candidateId, workflowId) as ResumeQualityHumanApprovalRow | undefined;
}

/** Full approval history for a job, newest first — audit trail across retries/re-tailors. Each row
 *  names its own workflow_id; nothing here implies any row still applies to the job's CURRENT
 *  workflow (callers wanting "is the current resume approved" must use getHumanApprovalForWorkflow
 *  against the latest workflow_id instead). */
export function listHumanApprovalsForJob(candidateId: number, dedupeKey: string): ResumeQualityHumanApprovalRow[] {
  return getDb()
    .prepare("SELECT * FROM resume_quality_human_approvals WHERE candidate_id = ? AND dedupe_key = ? ORDER BY approved_at DESC, id DESC")
    .all(candidateId, dedupeKey) as ResumeQualityHumanApprovalRow[];
}

/**
 * Records an approval for the exact workflow/iteration. Idempotent by construction: UNIQUE(workflow_id)
 * at the schema level means a second call for a workflow that already has an approval never inserts a
 * duplicate or mutates the first record — repeated clicking on the candidate's Approve button is
 * therefore always safe. Returns the pre-existing row unchanged when one is found, so the timestamp
 * and snapshot a caller sees are always the FIRST approval's, never silently refreshed by a later click.
 */
export function saveHumanApproval(input: SaveHumanApprovalInput): ResumeQualityHumanApprovalRow {
  const existing = getHumanApprovalForWorkflow(input.candidateId, input.workflowId);
  if (existing) return existing;

  const db = getDb();
  try {
    db.prepare(
      `INSERT INTO resume_quality_human_approvals
        (candidate_id, workflow_id, tailoring_run_id, job_id, dedupe_key, selected_iteration_number,
         overall_score, ats_score, truthfulness_score, architecture_consistency_score,
         instruction_version, instruction_hash, safety_verdict_json, notes)
       VALUES
        (@candidateId, @workflowId, @tailoringRunId, @jobId, @dedupeKey, @selectedIterationNumber,
         @overallScore, @atsScore, @truthfulnessScore, @architectureConsistencyScore,
         @instructionVersion, @instructionHash, @safetyVerdictJson, @notes)`
    ).run({
      candidateId: input.candidateId,
      workflowId: input.workflowId,
      tailoringRunId: input.tailoringRunId,
      jobId: input.jobId,
      dedupeKey: input.dedupeKey,
      selectedIterationNumber: input.selectedIterationNumber,
      overallScore: input.overallScore,
      atsScore: input.atsScore,
      truthfulnessScore: input.truthfulnessScore,
      architectureConsistencyScore: input.architectureConsistencyScore,
      instructionVersion: input.instructionVersion,
      instructionHash: input.instructionHash,
      safetyVerdictJson: JSON.stringify(input.safetyVerdict),
      notes: input.notes ?? null,
    });
  } catch (err) {
    // A UNIQUE(workflow_id) race with a concurrent duplicate click: fall back to reading the row the
    // other request just inserted rather than treating this as an error.
    const raced = getHumanApprovalForWorkflow(input.candidateId, input.workflowId);
    if (raced) return raced;
    throw err;
  }

  const saved = getHumanApprovalForWorkflow(input.candidateId, input.workflowId);
  if (!saved) throw new Error(`Failed to read back human approval for workflow ${input.workflowId} after insert`);
  return saved;
}
