import { evaluateQualityGate } from "./qualityGate";
import type { StructuredResumeReview } from "./types";

/**
 * Stage 25 — the ONE canonical answer to "can a human send this application package?".
 *
 * WHY THIS EXISTS. evaluateQualityGate answers a different question: "what should the iteration loop
 * do next?" Its three outcomes are READY / IMPROVEMENT_NEEDED / NEEDS_HUMAN_REVIEW, and the last of
 * those is reached purely by exhausting maxIterations — so it collapses two situations a human must
 * never confuse:
 *
 *   * the package contains a TRUTHFULNESS or CROSS-DOCUMENT failure (a placeholder contact, an
 *     unsupported metric, a technology attributed to the wrong employer) and must not be sent at all;
 *   * the package is entirely truthful but its recruiter quality or canonical-instruction compliance
 *     is not yet at the READY bar — safe to send, merely not as strong as it could be.
 *
 * Both land in NEEDS_HUMAN_REVIEW and both map to workflow status FAILED, so a person looking at a
 * finished workflow cannot tell "this is unsafe" from "this is mediocre" without reading the raw
 * review. That distinction is the whole point of a human-in-the-loop application step.
 *
 * This module adds NO new engine, NO new workflow, and NO new thresholds. It is a pure, deterministic
 * re-reading of the review the deterministic reviewer already produced, plus evaluateQualityGate's
 * own verdict — the gate remains the sole authority on READY, and this function never overrides it.
 */

export type ApplicationReadiness = "BLOCKED" | "NEEDS_IMPROVEMENT" | "READY_FOR_HUMAN_APPLICATION";

export interface ApplicationReadinessResult {
  readiness: ApplicationReadiness;
  /** Truthfulness/cross-document reasons that make the package unsendable. Non-empty iff BLOCKED. */
  blockingReasons: string[];
  /** Truthful-but-weak reasons. Non-empty iff NEEDS_IMPROVEMENT. */
  improvementReasons: string[];
  /** True only when a human may send this package as-is. Never implies CareerOps should send it. */
  humanMaySend: boolean;
}

/**
 * A review carries a TRUTHFULNESS failure when any of the absolute guardrails tripped. These are the
 * conditions that must never be traded against writing quality, and no aggregate score can clear
 * them — the same "blocking failures remain absolute" rule qualityGate.ts already enforces, read here
 * so the reason can be reported rather than only counted.
 */
function collectBlockingReasons(review: StructuredResumeReview): string[] {
  const reasons: string[] = [];

  // Absence is failure, never a free pass — identical treatment to qualityGate.ts's condition 7. A
  // review that never computed typed blocking failures has not been cleared of them.
  if (review.blockingFailures === undefined) {
    reasons.push(
      "Typed blocking-failure analysis is missing from this review — the package has not been cleared of truthfulness failures, which is not the same as having passed."
    );
  } else {
    for (const failure of review.blockingFailures) {
      const correction = failure.recommendedCorrection ? ` Recommended correction: ${failure.recommendedCorrection}` : "";
      reasons.push(`${failure.type}: ${failure.description}${correction}`);
    }
  }

  if (review.truthfulnessScore !== 100) {
    reasons.push(`Truthfulness score is ${review.truthfulnessScore}, not 100 — the package asserts something the candidate's evidence does not support.`);
  }
  if (review.architectureConsistencyScore !== 100) {
    reasons.push(`Architecture consistency score is ${review.architectureConsistencyScore}, not 100 — the package contradicts itself about the candidate's own history.`);
  }
  for (const issue of review.blockingIssues) {
    reasons.push(`Blocking issue: ${issue}`);
  }

  return reasons;
}

/**
 * Classifies one review into the single decision a human acts on. `iteration`/`maxIterations` are
 * passed straight through to evaluateQualityGate so READY here means exactly what READY means there —
 * this function can only ever be MORE conservative than the gate, never less.
 */
export function evaluateApplicationReadiness(
  review: StructuredResumeReview,
  iteration: number,
  maxIterations: number
): ApplicationReadinessResult {
  const blockingReasons = collectBlockingReasons(review);
  if (blockingReasons.length > 0) {
    return { readiness: "BLOCKED", blockingReasons, improvementReasons: [], humanMaySend: false };
  }

  const gateOutcome = evaluateQualityGate(review, iteration, maxIterations);
  if (gateOutcome === "READY") {
    return { readiness: "READY_FOR_HUMAN_APPLICATION", blockingReasons: [], improvementReasons: [], humanMaySend: true };
  }

  // Truthful, but the gate is not satisfied. Report WHICH of the non-truthfulness conditions failed,
  // so the human sees a specific weakness rather than a bare "not ready".
  const improvementReasons: string[] = [];
  if (review.overallScore < 95) {
    improvementReasons.push(`Overall review score is ${review.overallScore}, below the 95 required for READY.`);
  }
  if (review.recruiterQualityAssessment === undefined) {
    improvementReasons.push("Recruiter-quality assessment is missing — positioning was never verified against a target role title.");
  } else if (review.recruiterQualityAssessment.status !== "PASS") {
    improvementReasons.push(`Recruiter-quality assessment is ${review.recruiterQualityAssessment.status}, not PASS — the package is truthful but does not yet read as a targeted application.`);
  }
  if (review.instructionCompliance === undefined) {
    improvementReasons.push("Canonical instruction compliance was not computed for this review.");
  }
  if (improvementReasons.length === 0) {
    improvementReasons.push("The quality gate is not satisfied — see the canonical instruction compliance checks for the specific failing check(s).");
  }

  return { readiness: "NEEDS_IMPROVEMENT", blockingReasons: [], improvementReasons, humanMaySend: false };
}
