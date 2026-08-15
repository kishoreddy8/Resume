import { getDb } from "@/db";
import { assertValidWorkflowTransition } from "@/lib/resumeQuality/stateMachine";
import { DEFAULT_MAX_ITERATIONS, type WorkflowStatus } from "@/lib/resumeQuality/types";

/**
 * Persistence layer for resume_quality_workflows/resume_quality_iterations — see schema.sql's own
 * comment on those tables for the full identity/lifecycle design record. Phase 3 Stage 7 FOUNDATION
 * ONLY: nothing here calls an AI provider; this module only persists state a future orchestrator will
 * drive.
 *
 * Mirrors tailoringRuns.ts's identity discipline exactly: candidate_id is required on every lookup,
 * never optional — there is no "give me anyone's workflow/iteration" query anywhere in this codebase,
 * by design.
 */

export interface ResumeQualityWorkflowRow {
  id: number;
  candidate_id: number;
  application_id: number;
  tailoring_run_id: number;
  dedupe_key: string;
  status: WorkflowStatus;
  current_iteration: number;
  max_iterations: number;
  latest_overall_score: number | null;
  final_approved_iteration: number | null;
  failure_reason: string | null;
  writer_provider: string | null;
  writer_model: string | null;
  reviewer_provider: string | null;
  reviewer_model: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CreateResumeQualityWorkflowInput {
  candidateId: number;
  applicationId: number;
  tailoringRunId: number;
  dedupeKey: string;
  maxIterations?: number;
}

export class ResumeQualityWorkflowNotFoundError extends Error {
  constructor(candidateId: number, id: number) {
    super(`No resume quality workflow ${id} found for candidate ${candidateId}`);
    this.name = "ResumeQualityWorkflowNotFoundError";
  }
}

/** Creates a workflow in status='CREATED'. Does not validate that tailoring_run_id/application_id
 *  actually belong to candidateId — same "trust the caller supplied real, already-resolved identity"
 *  contract as createTailoringRun; a future orchestrator (not built in Stage 7) is responsible for
 *  resolving that identity first, exactly as the tailoring-runs API route does today. */
export function createResumeQualityWorkflow(input: CreateResumeQualityWorkflowInput): ResumeQualityWorkflowRow {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO resume_quality_workflows
        (candidate_id, application_id, tailoring_run_id, dedupe_key, status, current_iteration, max_iterations)
       VALUES
        (@candidateId, @applicationId, @tailoringRunId, @dedupeKey, 'CREATED', 0, @maxIterations)`
    )
    .run({
      candidateId: input.candidateId,
      applicationId: input.applicationId,
      tailoringRunId: input.tailoringRunId,
      dedupeKey: input.dedupeKey,
      maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    });
  return getResumeQualityWorkflow(input.candidateId, Number(result.lastInsertRowid))!;
}

export function getResumeQualityWorkflow(candidateId: number, id: number): ResumeQualityWorkflowRow | undefined {
  return getDb()
    .prepare("SELECT * FROM resume_quality_workflows WHERE candidate_id = ? AND id = ?")
    .get(candidateId, id) as ResumeQualityWorkflowRow | undefined;
}

/** Full history of quality workflows attempted against one tailoring run, newest first — a run may
 *  have zero, one, or several workflows over time (e.g. re-running the pipeline later), same
 *  "history preserved, never a singleton" philosophy as tailoring_runs itself. */
export function listResumeQualityWorkflowsForRun(candidateId: number, tailoringRunId: number): ResumeQualityWorkflowRow[] {
  return getDb()
    .prepare("SELECT * FROM resume_quality_workflows WHERE candidate_id = ? AND tailoring_run_id = ? ORDER BY created_at DESC, id DESC")
    .all(candidateId, tailoringRunId) as ResumeQualityWorkflowRow[];
}

export function listResumeQualityWorkflowsForJob(candidateId: number, dedupeKey: string): ResumeQualityWorkflowRow[] {
  return getDb()
    .prepare("SELECT * FROM resume_quality_workflows WHERE candidate_id = ? AND dedupe_key = ? ORDER BY created_at DESC, id DESC")
    .all(candidateId, dedupeKey) as ResumeQualityWorkflowRow[];
}

export function getLatestResumeQualityWorkflowForJob(candidateId: number, dedupeKey: string): ResumeQualityWorkflowRow | undefined {
  return getDb()
    .prepare("SELECT * FROM resume_quality_workflows WHERE candidate_id = ? AND dedupe_key = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(candidateId, dedupeKey) as ResumeQualityWorkflowRow | undefined;
}

/**
 * Batch lookup of one candidate's latest resume quality workflow per dedupe_key — used by the
 * For You feed ranking API to identify READY_TO_APPLY candidate jobs with a single SQL query
 * instead of N+1 individual queries.
 */
export function listLatestResumeQualityWorkflowsForDedupeKeys(
  candidateId: number,
  dedupeKeys: string[]
): Record<string, ResumeQualityWorkflowRow> {
  if (dedupeKeys.length === 0) return {};
  const db = getDb();
  const placeholders = dedupeKeys.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT t.*
       FROM resume_quality_workflows t
       INNER JOIN (
         SELECT dedupe_key, MAX(id) AS max_id
         FROM resume_quality_workflows
         WHERE candidate_id = ? AND dedupe_key IN (${placeholders})
         GROUP BY dedupe_key
       ) latest ON latest.max_id = t.id`
    )
    .all(candidateId, ...dedupeKeys) as ResumeQualityWorkflowRow[];

  const result: Record<string, ResumeQualityWorkflowRow> = {};
  for (const row of rows) {
    result[row.dedupe_key] = row;
  }
  return result;
}

export interface TransitionWorkflowStatusOptions {
  failureReason?: string;
  latestOverallScore?: number;
  /** Set alongside a transition TO 'IMPROVEMENT_RUNNING' or 'REVIEW_RUNNING' — advances
   *  current_iteration. Omit to leave current_iteration unchanged. */
  currentIteration?: number;
  /** Set alongside a transition TO 'READY'. */
  finalApprovedIteration?: number;
}

const TERMINAL_STATUSES: readonly WorkflowStatus[] = ["READY", "FAILED"];

/**
 * Validates the transition via stateMachine.ts (throws InvalidWorkflowTransitionError on an illegal
 * one) before writing anything. completed_at is set exactly once, the moment status first reaches a
 * terminal value (READY or FAILED) — mirrors tailoring_runs' own started->completed|failed
 * immutability, though enforced here via the state machine rather than a single boolean status check,
 * since this lifecycle has more than two phases.
 */
export function transitionWorkflowStatus(
  candidateId: number,
  id: number,
  toStatus: WorkflowStatus,
  options: TransitionWorkflowStatusOptions = {}
): ResumeQualityWorkflowRow {
  const current = getResumeQualityWorkflow(candidateId, id);
  if (!current) throw new ResumeQualityWorkflowNotFoundError(candidateId, id);
  assertValidWorkflowTransition(current.status, toStatus);

  getDb()
    .prepare(
      `UPDATE resume_quality_workflows SET
         status = @toStatus,
         current_iteration = COALESCE(@currentIteration, current_iteration),
         latest_overall_score = COALESCE(@latestOverallScore, latest_overall_score),
         final_approved_iteration = COALESCE(@finalApprovedIteration, final_approved_iteration),
         failure_reason = COALESCE(@failureReason, failure_reason),
         completed_at = CASE WHEN @isTerminal THEN datetime('now') ELSE completed_at END,
         updated_at = datetime('now')
       WHERE candidate_id = @candidateId AND id = @id`
    )
    .run({
      candidateId,
      id,
      toStatus,
      currentIteration: options.currentIteration ?? null,
      latestOverallScore: options.latestOverallScore ?? null,
      finalApprovedIteration: options.finalApprovedIteration ?? null,
      failureReason: options.failureReason ?? null,
      isTerminal: TERMINAL_STATUSES.includes(toStatus) ? 1 : 0,
    });
  return getResumeQualityWorkflow(candidateId, id)!;
}

// --- Iterations -------------------------------------------------------------------------------

export interface ResumeQualityIterationRow {
  id: number;
  workflow_id: number;
  candidate_id: number;
  iteration_number: number;
  output_files: string | null;
  review_json: string | null;
  overall_score: number | null;
  ats_score: number | null;
  keyword_alignment_score: number | null;
  truthfulness_score: number | null;
  architecture_consistency_score: number | null;
  recruiter_readability_score: number | null;
  formatting_score: number | null;
  blocking_issue_count: number;
  created_at: string;
}

export class IterationAlreadyExistsError extends Error {
  constructor(workflowId: number, iterationNumber: number) {
    super(`Iteration ${iterationNumber} already exists for workflow ${workflowId} — iterations are immutable and can never be overwritten.`);
    this.name = "IterationAlreadyExistsError";
  }
}

export class IterationOutOfSequenceError extends Error {
  constructor(workflowId: number, attempted: number, expected: number) {
    super(`Workflow ${workflowId} expected iteration ${expected} next, got ${attempted} — iterations must be created in order, never skipped.`);
    this.name = "IterationOutOfSequenceError";
  }
}

export class IterationExceedsMaxError extends Error {
  constructor(workflowId: number, iterationNumber: number, maxIterations: number) {
    super(`Iteration ${iterationNumber} exceeds workflow ${workflowId}'s max_iterations (${maxIterations}).`);
    this.name = "IterationExceedsMaxError";
  }
}

export interface CreateResumeQualityIterationInput {
  outputFiles: string[];
  overallScore: number;
  atsScore: number;
  keywordAlignmentScore: number;
  truthfulnessScore: number;
  architectureConsistencyScore: number;
  recruiterReadabilityScore: number;
  formattingScore: number;
  blockingIssueCount: number;
  /** The full StructuredResumeReview, already JSON.stringify-able by the caller. */
  reviewJson: string;
}

/**
 * Insert-only — there is no updateResumeQualityIteration function anywhere in this module, by
 * design. Rejects a duplicate iteration_number (IterationAlreadyExistsError, also enforced by the
 * table's UNIQUE(workflow_id, iteration_number) constraint as a second guarantee), a non-sequential
 * number (IterationOutOfSequenceError), or one beyond the workflow's max_iterations
 * (IterationExceedsMaxError) — before writing anything.
 */
export function createResumeQualityIteration(
  candidateId: number,
  workflowId: number,
  iterationNumber: number,
  input: CreateResumeQualityIterationInput
): ResumeQualityIterationRow {
  const workflow = getResumeQualityWorkflow(candidateId, workflowId);
  if (!workflow) throw new ResumeQualityWorkflowNotFoundError(candidateId, workflowId);

  // Existence checked first: attempting to re-create ANY past iteration number is always also
  // "out of sequence" once current_iteration has advanced past it, so checking sequence first would
  // make IterationAlreadyExistsError practically unreachable and report a less specific error for
  // exactly the case ("you're trying to overwrite an existing iteration") this exists to name.
  if (getResumeQualityIteration(candidateId, workflowId, iterationNumber)) {
    throw new IterationAlreadyExistsError(workflowId, iterationNumber);
  }
  if (iterationNumber > workflow.max_iterations) {
    throw new IterationExceedsMaxError(workflowId, iterationNumber, workflow.max_iterations);
  }
  if (iterationNumber !== workflow.current_iteration + 1) {
    throw new IterationOutOfSequenceError(workflowId, iterationNumber, workflow.current_iteration + 1);
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO resume_quality_iterations
      (workflow_id, candidate_id, iteration_number, output_files, review_json, overall_score,
       ats_score, keyword_alignment_score, truthfulness_score, architecture_consistency_score,
       recruiter_readability_score, formatting_score, blocking_issue_count)
     VALUES
      (@workflowId, @candidateId, @iterationNumber, @outputFiles, @reviewJson, @overallScore,
       @atsScore, @keywordAlignmentScore, @truthfulnessScore, @architectureConsistencyScore,
       @recruiterReadabilityScore, @formattingScore, @blockingIssueCount)`
  ).run({
    workflowId,
    candidateId,
    iterationNumber,
    outputFiles: JSON.stringify(input.outputFiles),
    reviewJson: input.reviewJson,
    overallScore: input.overallScore,
    atsScore: input.atsScore,
    keywordAlignmentScore: input.keywordAlignmentScore,
    truthfulnessScore: input.truthfulnessScore,
    architectureConsistencyScore: input.architectureConsistencyScore,
    recruiterReadabilityScore: input.recruiterReadabilityScore,
    formattingScore: input.formattingScore,
    blockingIssueCount: input.blockingIssueCount,
  });

  db.prepare("UPDATE resume_quality_workflows SET current_iteration = ?, updated_at = datetime('now') WHERE candidate_id = ? AND id = ?").run(
    iterationNumber,
    candidateId,
    workflowId
  );

  return getResumeQualityIteration(candidateId, workflowId, iterationNumber)!;
}

export function getResumeQualityIteration(candidateId: number, workflowId: number, iterationNumber: number): ResumeQualityIterationRow | undefined {
  return getDb()
    .prepare("SELECT * FROM resume_quality_iterations WHERE candidate_id = ? AND workflow_id = ? AND iteration_number = ?")
    .get(candidateId, workflowId, iterationNumber) as ResumeQualityIterationRow | undefined;
}

/** All iterations for one workflow, oldest first (iteration_number ASC) — the natural reading order
 *  for "show me how this resume evolved across improvement cycles." */
export function listResumeQualityIterations(candidateId: number, workflowId: number): ResumeQualityIterationRow[] {
  return getDb()
    .prepare("SELECT * FROM resume_quality_iterations WHERE candidate_id = ? AND workflow_id = ? ORDER BY iteration_number ASC")
    .all(candidateId, workflowId) as ResumeQualityIterationRow[];
}
