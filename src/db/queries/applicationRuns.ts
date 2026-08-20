import { getDb } from "@/db";
import { canTransition, type RunStatus } from "@/lib/apply/runState";

/**
 * Application runs, persisted.
 *
 * TRANSITIONS ARE ENFORCED HERE, not merely documented. Every status change goes through
 * `advanceRun`, which refuses an illegal move — most importantly any path to SUBMITTING that did
 * not come from WAITING_FOR_SUBMIT_APPROVAL. A rule the storage layer enforces cannot be forgotten
 * by a caller.
 *
 * NO SECRETS. Passwords and verification codes are never written here. The checkpoint holds
 * navigational state so a run can resume, not the values typed into sensitive fields.
 */

export interface ApplicationRun {
  id: number;
  candidate_id: number;
  job_id: number;
  dedupe_key: string;
  ats: string | null;
  apply_url: string | null;
  status: RunStatus;
  blocking_reason: string | null;
  blocking_question: string | null;
  checkpoint_json: string | null;
  resume_file: string | null;
  cover_letter_file: string | null;
  submit_approved_at: string | null;
  submitted_at: string | null;
  confirmation_text: string | null;
  created_at: string;
  updated_at: string;
}

export class IllegalTransitionError extends Error {
  constructor(from: RunStatus, to: RunStatus) {
    super(`Illegal application-run transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function createRun(input: {
  candidateId: number;
  jobId: number;
  dedupeKey: string;
  ats?: string | null;
  applyUrl?: string | null;
  resumeFile?: string | null;
  coverLetterFile?: string | null;
}): ApplicationRun {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO application_runs (candidate_id, job_id, dedupe_key, ats, apply_url, status, resume_file, cover_letter_file)
       VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?)`
    )
    .run(
      input.candidateId,
      input.jobId,
      input.dedupeKey,
      input.ats ?? null,
      input.applyUrl ?? null,
      input.resumeFile ?? null,
      input.coverLetterFile ?? null
    );
  recordEvent(Number(info.lastInsertRowid), "run_created", null);
  return getRun(Number(info.lastInsertRowid))!;
}

export function getRun(id: number): ApplicationRun | undefined {
  return getDb().prepare("SELECT * FROM application_runs WHERE id = ?").get(id) as ApplicationRun | undefined;
}

export function recordEvent(runId: number, eventType: string, detail: string | null): void {
  getDb().prepare("INSERT INTO application_run_events (run_id, event_type, detail) VALUES (?,?,?)").run(runId, eventType, detail);
}

export function listEvents(runId: number) {
  return getDb().prepare("SELECT * FROM application_run_events WHERE run_id = ? ORDER BY id ASC").all(runId) as {
    id: number;
    event_type: string;
    detail: string | null;
    created_at: string;
  }[];
}

/**
 * Move a run to a new status, or refuse.
 *
 * `submitApproval` must name the run it belongs to. Approval is per application — reusing one
 * job's approval for another is exactly the mistake this parameter exists to make impossible.
 */
export function advanceRun(
  runId: number,
  to: RunStatus,
  opts: {
    blockingReason?: string | null;
    blockingQuestion?: string | null;
    checkpoint?: unknown;
    confirmationText?: string | null;
    submitApproval?: { runId: number };
  } = {}
): ApplicationRun {
  const run = getRun(runId);
  if (!run) throw new Error(`No application run ${runId}`);
  if (!canTransition(run.status, to)) throw new IllegalTransitionError(run.status, to);

  if (to === "SUBMITTING") {
    /* Belt and braces over the transition table: the approval must exist AND belong to this run. */
    if (!opts.submitApproval || opts.submitApproval.runId !== runId) {
      throw new Error("Submission requires an explicit approval for this application run.");
    }
  }

  const db = getDb();
  db.prepare(
    `UPDATE application_runs SET
        status = @status,
        blocking_reason = @reason,
        blocking_question = @question,
        checkpoint_json = COALESCE(@checkpoint, checkpoint_json),
        confirmation_text = COALESCE(@confirmation, confirmation_text),
        submit_approved_at = CASE WHEN @status = 'SUBMITTING' THEN datetime('now') ELSE submit_approved_at END,
        submitted_at = CASE WHEN @status = 'SUBMITTED' THEN datetime('now') ELSE submitted_at END,
        updated_at = datetime('now')
      WHERE id = @id`
  ).run({
    id: runId,
    status: to,
    reason: opts.blockingReason ?? null,
    question: opts.blockingQuestion ?? null,
    checkpoint: opts.checkpoint === undefined ? null : JSON.stringify(opts.checkpoint),
    confirmation: opts.confirmationText ?? null,
  });

  recordEvent(runId, `status_${to.toLowerCase()}`, opts.blockingReason ?? opts.blockingQuestion ?? null);
  return getRun(runId)!;
}

/**
 * Update the checkpoint without a status change.
 *
 * The executor checkpoints after EVERY successful action, and most of those happen inside one
 * FILLING state — a same-state advanceRun would be an illegal transition, and looping through
 * states to record progress would corrupt the history. Checkpoints hold navigational state (URL,
 * step, which selectors are done), never passwords or verification codes.
 */
export function updateCheckpoint(runId: number, checkpoint: unknown): void {
  getDb()
    .prepare("UPDATE application_runs SET checkpoint_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(checkpoint), runId);
}

/** Runs stopped and waiting on the user — the Needs Your Input inbox. */
export function listWaitingRuns(candidateId: number): ApplicationRun[] {
  return getDb()
    .prepare(
      `SELECT * FROM application_runs
        WHERE candidate_id = ?
          AND status IN ('ACCOUNT_REQUIRED','WAITING_FOR_ANSWER','WAITING_FOR_CAPTCHA','WAITING_FOR_MFA',
                         'WAITING_FOR_EMAIL_VERIFICATION','READY_FOR_REVIEW','WAITING_FOR_SUBMIT_APPROVAL')
        ORDER BY updated_at DESC`
    )
    .all(candidateId) as ApplicationRun[];
}

export function listRuns(candidateId: number, limit = 50): ApplicationRun[] {
  return getDb()
    .prepare("SELECT * FROM application_runs WHERE candidate_id = ? ORDER BY updated_at DESC LIMIT ?")
    .all(candidateId, limit) as ApplicationRun[];
}
