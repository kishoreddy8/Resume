import { getCandidateJobState } from "@/db/queries/candidateJobState";
import { getLatestJobMatchResult } from "@/db/queries/jobMatches";

/**
 * Stage 26 — the single definition of "is this candidate/job pair authorized for tailoring right
 * now". Extracted verbatim from the GET /quality-workflow route's own inline check (which remains
 * its only consumer for display purposes) so the autonomous writer can re-assert the exact same
 * human-approval requirement immediately before spending a Claude invocation, instead of trusting
 * that whatever created the workflow row must have checked.
 *
 * This is deliberately NOT a new policy: a match score can never authorize anything here — the ONLY
 * way isAuthorized becomes true is an explicit human approval recorded on candidate_job_state
 * (marked_for_tailoring + tailoring_approval_type + tailoring_approved_decision), and that approval
 * must still agree with the job's current match decision. A job whose decision moved (e.g. to
 * BLOCKED) after approval reads as stale and is refused, which is what keeps invariants 2-4
 * (score-alone, BLOCKED, unapproved NEEDS_REVIEW) true for the automatic writer as well as the UI.
 */

export interface TailoringAuthorization {
  isMarked: boolean;
  markedAt: string | null;
  approvalType: string | null;
  approvedDecision: string | null;
  isAuthorized: boolean;
  blockingReason: string | null;
  matchDecision: string;
  insufficientJdSignal: boolean;
}

export function evaluateTailoringAuthorization(candidateId: number, dedupeKey: string): TailoringAuthorization {
  const state = getCandidateJobState(candidateId, dedupeKey);
  const matchResult = getLatestJobMatchResult(candidateId, dedupeKey);

  let isAuthorized = false;
  let blockingReason: string | null = null;

  if (!state || !state.marked_for_tailoring) {
    blockingReason = "Job is not marked for tailoring.";
  } else if (!state.tailoring_approval_type || !state.tailoring_approved_decision) {
    blockingReason = "Tailoring approval required: no approval context recorded.";
  } else if (!matchResult) {
    blockingReason = "Tailoring approval required: job has not been evaluated against candidate profile.";
  } else if (state.tailoring_approved_decision !== matchResult.decision) {
    blockingReason = `Tailoring approval stale: approved for ${state.tailoring_approved_decision}, but current match decision is ${matchResult.decision}.`;
  } else {
    isAuthorized = true;
  }

  return {
    isMarked: Boolean(state?.marked_for_tailoring),
    markedAt: state?.tailoring_marked_at ?? null,
    approvalType: state?.tailoring_approval_type ?? null,
    approvedDecision: state?.tailoring_approved_decision ?? null,
    isAuthorized,
    blockingReason,
    matchDecision: matchResult?.decision ?? "NO_MATCH",
    insufficientJdSignal: Boolean(matchResult?.insufficient_jd_signal),
  };
}
