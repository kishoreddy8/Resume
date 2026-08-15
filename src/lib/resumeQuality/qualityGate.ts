import { matchesCurrentInstructions } from "./canonicalInstructions";
import { allChecksPass } from "./instructionCompliance";
import type { StructuredResumeReview } from "./types";

/**
 * Section 7's future quality-gate contract, as a pure, side-effect-free function — no AI execution,
 * no persistence. A future orchestrator (not built in Stage 7) will call this after each review to
 * decide the next state transition (see stateMachine.ts).
 */
export type QualityGateOutcome = "READY" | "IMPROVEMENT_NEEDED" | "NEEDS_HUMAN_REVIEW";

/**
 * READY requires ALL of the original four Stage 7 conditions (overallScore >= 95, truthfulnessScore
 * exactly 100, architectureConsistencyScore exactly 100, zero blockingIssues — UNCHANGED, never
 * relaxed) PLUS, additively (Resume Quality Hardening §7), the canonical instruction compliance:
 *
 *   5. review.instructionCompliance is present AND was computed against the CURRENT canonical
 *      instruction version/hash (matchesCurrentInstructions) — a review computed against a stale or
 *      edited instruction set, or a legacy pre-hardening review missing this field entirely, can
 *      NEVER be READY purely by having "no compliance data to contradict it." Absence is treated as
 *      failure, never as a free pass (see §16's own "do not silently mark an old incomplete review
 *      as compliant with the new standard").
 *   6. every one of the 22 named compliance checks is PASS (allChecksPass) — a single FAIL or REVIEW
 *      anywhere blocks READY, matching "the writer's self-validation is NOT sufficient... CareerOps
 *      review is authoritative" and "do not make every minor stylistic warning a CRITICAL blocker"
 *      is instead satisfied by keeping soft-gate checks genuinely PASS-able (see
 *      instructionCompliance.ts's SOFT_GATE_CHECKS) rather than by letting a real violation slide.
 *
 * A high overall score can never compensate for a factual, architectural, OR canonical-compliance
 * problem — the exact "never let a numeric score alone hide a factual or architectural error" rule
 * from the Stage 7 spec, now extended to the full canonical standard. Otherwise: more iterations
 * remain -> IMPROVEMENT_NEEDED; at maxIterations with the gate still failing -> NEEDS_HUMAN_REVIEW
 * (mapped to workflow status FAILED with an explanatory failure_reason — see
 * resumeQualityWorkflows.ts).
 */
export function evaluateQualityGate(review: StructuredResumeReview, iteration: number, maxIterations: number): QualityGateOutcome {
  const passesOriginalStage7Gate =
    review.overallScore >= 95 &&
    review.truthfulnessScore === 100 &&
    review.architectureConsistencyScore === 100 &&
    review.blockingIssues.length === 0;

  const compliance = review.instructionCompliance;
  const passesCanonicalComplianceGate =
    compliance !== undefined && matchesCurrentInstructions(compliance) && allChecksPass(compliance);

  const passesGate = passesOriginalStage7Gate && passesCanonicalComplianceGate;

  if (passesGate) return "READY";
  if (iteration < maxIterations) return "IMPROVEMENT_NEEDED";
  return "NEEDS_HUMAN_REVIEW";
}
