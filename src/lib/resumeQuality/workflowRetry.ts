import type { TailoringAuthorization } from "./tailoringAuthorization";

/**
 * Stage 27 — may a NEW quality workflow be created for a job that already has one?
 *
 * The defect this fixes: the create route looked up the latest workflow for a job with no status
 * filter and created one only when none existed. A workflow that had exhausted its three iterations
 * and ended FAILED therefore blocked that job forever — re-approving returned the same dead row, and
 * there was no path, in the UI or the API, to try again. Three of the six workflows on the real
 * corpus are in exactly that state.
 *
 * The rules below are deliberately conservative, because "let it try again" must never become "let it
 * try again by itself":
 *
 *   - A non-terminal workflow (CREATED / IMPROVEMENT_RUNNING) is always reused, exactly as before.
 *     Pressing the button twice must never create a second workflow or re-run anything.
 *   - A READY workflow is reused, never duplicated. Its artifacts are published and approved; there
 *     is nothing to retry, and a second workflow would leave two competing "final" results.
 *   - A FAILED workflow may be retried, but ONLY behind a FRESH human approval — one recorded after
 *     the failed workflow was created. Without that rule a single old approval would authorize an
 *     unlimited number of automatic re-runs, which is precisely the human-approval boundary this
 *     system exists to keep.
 *   - The failed workflow is never reopened, patched, or mutated. It stays exactly as it is, as
 *     history; a retry creates a brand-new workflow and run alongside it.
 *
 * Authorization itself is NOT re-implemented here: the caller passes the result of the same
 * evaluateTailoringAuthorization the writer re-asserts before spending anything, which already
 * enforces that the approval exists and still matches the job's CURRENT match decision (so a job
 * re-evaluated to BLOCKED, or an approval that has gone stale, is refused here too).
 */

export type WorkflowRetryDecision =
  | { action: "REUSE_EXISTING"; reason: string }
  | { action: "CREATE_FIRST"; reason: string }
  | { action: "CREATE_RETRY"; reason: string }
  | { action: "REFUSE"; code: WorkflowRetryRefusalCode; reason: string };

export type WorkflowRetryRefusalCode = "NOT_AUTHORIZED" | "STALE_APPROVAL_FOR_RETRY";

/** The terminal statuses, per the Stage 7 state machine's fixed status list. */
const TERMINAL_STATUSES = new Set(["READY", "FAILED"]);

export interface WorkflowRetryInput {
  /** The latest workflow for this candidate+job, or null when there is none. */
  existingWorkflow: { id: number; status: string; created_at: string } | null;
  /** When the human most recently approved this job for tailoring (candidate_job_state). */
  tailoringMarkedAt: string | null;
  authorization: Pick<TailoringAuthorization, "isAuthorized" | "blockingReason">;
}

/**
 * Compares two SQLite `datetime('now')` timestamps. Both sides are produced by the same SQLite
 * expression in the same UTC frame and the same 'YYYY-MM-DD HH:MM:SS' shape, so a lexicographic
 * comparison is exact — no timezone reinterpretation, and no dependence on the host's locale.
 */
function isStrictlyAfter(candidate: string, reference: string): boolean {
  return candidate.trim() > reference.trim();
}

export function evaluateWorkflowRetry(input: WorkflowRetryInput): WorkflowRetryDecision {
  const { existingWorkflow, tailoringMarkedAt, authorization } = input;

  // Authorization is checked first and applies to every path that could create work. A job whose
  // current decision is BLOCKED, or whose approval no longer matches it, never gets past this.
  if (!authorization.isAuthorized) {
    return {
      action: "REFUSE",
      code: "NOT_AUTHORIZED",
      reason: authorization.blockingReason ?? "Tailoring is not authorized for this job.",
    };
  }

  if (!existingWorkflow) {
    return { action: "CREATE_FIRST", reason: "No workflow exists for this job yet." };
  }

  if (!TERMINAL_STATUSES.has(existingWorkflow.status)) {
    return {
      action: "REUSE_EXISTING",
      reason: `Workflow ${existingWorkflow.id} is ${existingWorkflow.status} and already queued; it is returned unchanged.`,
    };
  }

  if (existingWorkflow.status === "READY") {
    return {
      action: "REUSE_EXISTING",
      reason: `Workflow ${existingWorkflow.id} is READY and its artifacts are published; there is nothing to retry.`,
    };
  }

  // FAILED — retry only behind an approval recorded AFTER the failed attempt.
  if (!tailoringMarkedAt || !isStrictlyAfter(tailoringMarkedAt, existingWorkflow.created_at)) {
    return {
      action: "REFUSE",
      code: "STALE_APPROVAL_FOR_RETRY",
      reason:
        `Workflow ${existingWorkflow.id} failed and the approval on file predates it. ` +
        "Review the job and approve it again to start a fresh tailoring attempt.",
    };
  }

  return {
    action: "CREATE_RETRY",
    reason: `Workflow ${existingWorkflow.id} failed and has since been re-approved by a human; a new workflow will be created alongside it.`,
  };
}
