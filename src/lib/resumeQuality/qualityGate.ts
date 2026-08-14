import type { StructuredResumeReview } from "./types";

/**
 * Section 7's future quality-gate contract, as a pure, side-effect-free function — no AI execution,
 * no persistence. A future orchestrator (not built in Stage 7) will call this after each review to
 * decide the next state transition (see stateMachine.ts).
 */
export type QualityGateOutcome = "READY" | "IMPROVEMENT_NEEDED" | "NEEDS_HUMAN_REVIEW";

/**
 * READY requires ALL of: overallScore >= 95, truthfulnessScore exactly 100, architectureConsistencyScore
 * exactly 100, and zero blockingIssues — a high overall score can never compensate for a factual or
 * architectural problem (the exact "never let a numeric score alone hide a factual or architectural
 * error" rule from the Stage 7 spec). Otherwise: more iterations remain -> IMPROVEMENT_NEEDED; at
 * maxIterations with the gate still failing -> NEEDS_HUMAN_REVIEW (mapped to workflow status FAILED
 * with an explanatory failure_reason — see resumeQualityWorkflows.ts).
 */
export function evaluateQualityGate(review: StructuredResumeReview, iteration: number, maxIterations: number): QualityGateOutcome {
  const passesGate =
    review.overallScore >= 95 &&
    review.truthfulnessScore === 100 &&
    review.architectureConsistencyScore === 100 &&
    review.blockingIssues.length === 0;

  if (passesGate) return "READY";
  if (iteration < maxIterations) return "IMPROVEMENT_NEEDED";
  return "NEEDS_HUMAN_REVIEW";
}
