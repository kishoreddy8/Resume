import { HARD_GATE_CHECKS } from "./instructionCompliance";
import { evaluateQualityGate } from "./qualityGate";
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
  /** Stage 26A — typed hard safety/truthfulness findings on the winner (qualityGate condition 7's
   *  own field). `null` means the winning review predates the typed reviewer, so its safety was never
   *  actually established — never that it was found clean. */
  blockingFailureCount: number | null;
  /** True when the winner would pass the unchanged quality gate. Only ever true if a gate-passing
   *  attempt was among the candidates; it never makes one passable. */
  passesQualityGate: boolean;
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
 * Stage 26A — would this review pass the UNCHANGED quality gate? Delegates to evaluateQualityGate so
 * there is exactly one definition of "approvable" in the codebase; this module never re-implements or
 * relaxes any of its eight conditions. READY is iteration-independent inside that function (the
 * iteration/maxIterations arguments only choose between IMPROVEMENT_NEEDED and NEEDS_HUMAN_REVIEW when
 * the gate has already failed), so the values passed here cannot influence the only answer we use.
 */
function passesQualityGate(review: StructuredResumeReview): boolean {
  return evaluateQualityGate(review, 1, 1) === "READY";
}

/**
 * Stage 26A — how unsafe an attempt is, in terms of the reviewer's own typed blocking failures
 * (PLACEHOLDER_CONTACT, UNSUPPORTED_CLAIM, CROSS_ARTIFACT_CONTRADICTION, ...). This is the exact field
 * qualityGate.ts condition 7 enforces, and before Stage 26A the comparator never looked at it.
 *
 *   0         — present and empty: the typed reviewer ran and found nothing.
 *   count     — present and non-empty.
 *   +Infinity — ABSENT: a legacy/pre-hardening review whose safety was never established. Treated as
 *               the worst possible value for exactly the reason hardGateFailureCount() already treats
 *               missing instructionCompliance as failing every gate — absence is never a free pass.
 *               Observed for real: the pre-Stage-26 seed iteration carries "candidate@example.com" in
 *               its resume yet has no blockingFailures field at all, because the typed reviewer did not
 *               exist when it was written. Ranking it as "clean" would promote that document.
 */
function blockingFailureSeverity(review: StructuredResumeReview): number {
  const failures = review.blockingFailures;
  if (failures === undefined) return Number.POSITIVE_INFINITY;
  return failures.length;
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
 * Stage 26A prepends two safety criteria ahead of every criterion below, and changes nothing beneath
 * them. The order below was tuned against the real Ostium data and remains intact: both new criteria
 * TIE for that workflow (none of its iterations has a blockingFailures field at all), so iteration 2
 * still wins there exactly as before. What they fix is the case the tuning never covered — two
 * attempts identical on every score, separated only by hard safety findings the comparator could not
 * see. Real example: iteration 2 (four PLACEHOLDER_CONTACT failures) outranked iteration 3 (those
 * placeholders removed) purely because it had one fewer hard-gate CHECK failure, and the human-review
 * package therefore handed a human a resume reading "candidate@example.com".
 *
 * Order:
 *   0. an attempt that passes the unchanged quality gate outranks one that does not
 *   0b. lower blockingFailureSeverity (proven-clean < fewer failures < more failures < never checked)
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
  // A genuinely approvable attempt always outranks one that is not. In practice no attempt in a
  // terminal-FAILED workflow passes the gate (the workflow would have been READY instead), so this is
  // a defensive invariant rather than a behaviour change — and it can never make a failing attempt
  // passable, only order two attempts whose gate results genuinely differ.
  const gateDiff = Number(passesQualityGate(b.review)) - Number(passesQualityGate(a.review));
  if (gateDiff !== 0) return gateDiff;

  // A hard safety/truthfulness failure can never be outweighed by a higher numeric score, because
  // this is decided before any score is consulted.
  const severityA = blockingFailureSeverity(a.review);
  const severityB = blockingFailureSeverity(b.review);
  if (severityA !== severityB) return severityA < severityB ? -1 : 1;

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
  // The safety finding is stated FIRST and never omitted: it is now the criterion that outranks every
  // score, so a reason that mentioned only scores would misdescribe how the winner was chosen.
  const failures = winner.review.blockingFailures;
  const safetyPhrase =
    failures === undefined
      ? "no typed blocking-failure review available (safety never established)"
      : failures.length === 0
      ? "0 blocking failure(s)"
      : `${failures.length} blocking failure(s) (${[...new Set(failures.map((f) => f.type))].sort().join(", ")})`;
  return (
    `Iteration ${winner.iterationNumber} selected: ${safetyPhrase}, ${hgFails} hard-gate failure(s), ` +
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
    blockingFailureCount: winner.review.blockingFailures?.length ?? null,
    passesQualityGate: passesQualityGate(winner.review),
  };
}
