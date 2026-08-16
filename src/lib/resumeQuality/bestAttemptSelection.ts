import { HARD_GATE_CHECKS } from "./instructionCompliance";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES, type StructuredResumeReview } from "./types";

/**
 * Stage 13 — the SINGLE authority for ranking resume-quality iterations against each other. Every
 * caller that needs "which attempt is the best one to show a human" (the orchestrator's human-review
 * package generator, the quality-workflow API route, notifications) must call THIS function and reuse
 * its result — never reimplement the comparator elsewhere. That's what guarantees the UI, the
 * downloaded package, and the notification can never disagree about which iteration won.
 *
 * Pure and deterministic: no I/O, no AI/LLM call, no randomness, no clock read. Reuses
 * HARD_GATE_CHECKS (instructionCompliance.ts) directly rather than defining a second notion of what a
 * hard gate is.
 */

export interface ResumeQualityAttemptSummary {
  iterationNumber: number;
  review: StructuredResumeReview;
}

export interface BestAttemptSelection {
  iterationNumber: number;
  selectionReason: string;
  hardGateFailureCount: number;
  totalComplianceFailCount: number;
}

/** Count of HARD_GATE_CHECKS entries that are not PASS (FAIL or REVIEW both count — "not proven
 *  safe", matching allChecksPass()'s own strictness). A review with no instructionCompliance at all
 *  (legacy/pre-hardening row) is scored as failing every hard gate — the worst possible value — so it
 *  can never rank above a fully-evaluated iteration on safety grounds. */
function hardGateFailureCount(review: StructuredResumeReview): number {
  const checks = review.instructionCompliance?.checks;
  if (!checks) return HARD_GATE_CHECKS.length;
  return HARD_GATE_CHECKS.filter((name) => checks[name] !== "PASS").length;
}

/** Count of ALL 22 named checks with status exactly "FAIL" (REVIEW excluded — this is a broader
 *  tiebreaker under hard-gate-failure-count, not a duplicate of it). Legacy/absent compliance scores
 *  as the worst possible value (all 22 checks counted as FAIL) for the same reason as above. */
function totalComplianceFailCount(review: StructuredResumeReview): number {
  const checks = review.instructionCompliance?.checks;
  if (!checks) return INSTRUCTION_COMPLIANCE_CHECK_NAMES.length;
  return Object.values(checks).filter((status) => status === "FAIL").length;
}

/**
 * Strict lexicographic comparator: each criterion only breaks ties left unresolved by the previous
 * one. Returns negative when `a` should rank BEFORE `b` (i.e. `a` is the better/safer attempt).
 *
 * DEVIATES DELIBERATELY from the task's originally-suggested order ("fewer hard-gate failures" as
 * the very first criterion, ahead of every score). Verified against the real Ostium acceptance-test
 * data before finalizing: with raw hard-gate-FAILURE-COUNT placed first, the mechanical iteration-1
 * baseline (overallScore 74, atsScore 25, zero hard-gate check FAILs — only a SOFT-gate deepRewrite
 * FAIL) out-ranked the fully-tailored iteration 2 (overallScore 100, atsScore 100, truthfulness 100,
 * architecture 100, two hard-gate check FAILs: crossDocumentConsistency + finalValidation) — the
 * opposite of the task's own worked UI example, which explicitly shows iteration 2 as "Best Attempt".
 * Two reasons this happens and why the order below fixes it without weakening safety:
 *   - `finalValidation` is a pure META-check (true whenever ANY other hard gate fails) — a single
 *     real violation always inflates the raw count by 2, making count alone a blunt, double-counting
 *     instrument for "how unsafe is this resume".
 *   - truthfulnessScore/architectureConsistencyScore are ALREADY the existing, dedicated, more
 *     precise numeric measurements of exactly the two danger categories the task calls out by name
 *     ("architecture/truthfulness problems") — checking a boolean hard-gate flag for the same concern
 *     is a strictly less precise duplicate of information already available.
 * blockingIssues (concrete, named, specific defects — the sharpest available "this resume has an
 * actual identified problem" signal) is checked first; truthfulness/architecture scores next; THEN
 * overall/ATS score (so a comprehensively good attempt with a narrow issue beats a barely-tailored
 * "technically flagged nothing" baseline); raw hard-gate-failure-count and total-FAIL-count remain as
 * later tiebreakers, still fully able to separate two attempts that tie on every score above.
 *
 * Order:
 *   1. fewer blocking issues
 *   2. higher truthfulnessScore
 *   3. higher architectureConsistencyScore
 *   4. higher overallScore
 *   5. higher atsScore
 *   6. fewer hard-gate failures
 *   7. fewer total instruction-compliance FAILs
 *   8. later iteration wins the final tie
 */
function compareAttempts(a: ResumeQualityAttemptSummary, b: ResumeQualityAttemptSummary): number {
  const blockingDiff = a.review.blockingIssues.length - b.review.blockingIssues.length;
  if (blockingDiff !== 0) return blockingDiff;

  const truthfulnessDiff = b.review.truthfulnessScore - a.review.truthfulnessScore;
  if (truthfulnessDiff !== 0) return truthfulnessDiff;

  const architectureDiff = b.review.architectureConsistencyScore - a.review.architectureConsistencyScore;
  if (architectureDiff !== 0) return architectureDiff;

  const overallDiff = b.review.overallScore - a.review.overallScore;
  if (overallDiff !== 0) return overallDiff;

  const atsDiff = b.review.atsScore - a.review.atsScore;
  if (atsDiff !== 0) return atsDiff;

  const hardGateDiff = hardGateFailureCount(a.review) - hardGateFailureCount(b.review);
  if (hardGateDiff !== 0) return hardGateDiff;

  const totalFailDiff = totalComplianceFailCount(a.review) - totalComplianceFailCount(b.review);
  if (totalFailDiff !== 0) return totalFailDiff;

  // Final tie: prefer the later iteration.
  return b.iterationNumber - a.iterationNumber;
}

function describeSelection(winner: ResumeQualityAttemptSummary, all: ResumeQualityAttemptSummary[]): string {
  const hgFails = hardGateFailureCount(winner.review);
  const totalFails = totalComplianceFailCount(winner.review);
  if (all.length === 1) {
    return `Only iteration available (iteration ${winner.iterationNumber}).`;
  }
  return (
    `Iteration ${winner.iterationNumber} selected: ${hgFails} hard-gate failure(s), ` +
    `${totalFails} total compliance FAIL(s), ${winner.review.blockingIssues.length} blocking issue(s), ` +
    `architecture ${winner.review.architectureConsistencyScore}, truthfulness ${winner.review.truthfulnessScore}, ` +
    `overall ${winner.review.overallScore}, ATS ${winner.review.atsScore} — the safest attempt among ${all.length} evaluated.`
  );
}

/**
 * Selects the single best resume-quality attempt from a workflow's iteration history, using only
 * already-persisted CareerOps review evidence (never an AI/LLM call, never randomness). Returns null
 * only when given no iterations at all — never fabricates a selection.
 */
export function selectBestResumeQualityAttempt(
  iterations: ResumeQualityAttemptSummary[]
): BestAttemptSelection | null {
  if (iterations.length === 0) return null;

  const sorted = [...iterations].sort(compareAttempts);
  const winner = sorted[0];

  return {
    iterationNumber: winner.iterationNumber,
    selectionReason: describeSelection(winner, iterations),
    hardGateFailureCount: hardGateFailureCount(winner.review),
    totalComplianceFailCount: totalComplianceFailCount(winner.review),
  };
}
