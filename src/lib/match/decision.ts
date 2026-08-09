import { MIN_REQUIREMENT_UNITS, READINESS_THRESHOLDS } from "./scoring";
import type { Decision, EligibilityResult, RequirementMatch } from "./types";

/**
 * Final readiness decision (Phase 2 Revision 4's final formula). BLOCKED always wins regardless of
 * score. A critical gap gates independently of score (no score-cap mechanism — the overallScore
 * stays honest and uncapped; see scoring.ts). blockingReasons collects EVERY contributing reason,
 * not just the first, so the UI can show all of them at once.
 */
export function decide(params: {
  eligibility: EligibilityResult;
  insufficientJdSignal: boolean;
  criticalGaps: RequirementMatch[];
  overallScore: number;
  requirementCoverage: number;
  employerEvidencedShare: number;
}): { decision: Decision; blockingReasons: string[] } {
  if (params.eligibility.status === "BLOCKED") {
    return { decision: "BLOCKED", blockingReasons: [...params.eligibility.reasons] };
  }

  const reasons: string[] = [];

  if (params.eligibility.status === "UNKNOWN") {
    reasons.push(...params.eligibility.reasons);
  }
  if (params.insufficientJdSignal) {
    reasons.push(`Job description too sparse for reliable structured matching (fewer than ${MIN_REQUIREMENT_UNITS} requirement(s) extracted) — verify manually.`);
  }
  if (params.criticalGaps.length > 0) {
    const labels = params.criticalGaps.map((g) => g.requirement.label).join(", ");
    reasons.push(`${params.criticalGaps.length} unresolved/missing critical requirement(s): ${labels}`);
  }
  if (params.overallScore < READINESS_THRESHOLDS.minScore) {
    reasons.push(`Overall score ${params.overallScore} is below the ${READINESS_THRESHOLDS.minScore} readiness threshold`);
  }
  if (params.requirementCoverage < READINESS_THRESHOLDS.minCoverage) {
    reasons.push(
      `Requirement coverage ${(params.requirementCoverage * 100).toFixed(1)}% is below the ${(READINESS_THRESHOLDS.minCoverage * 100).toFixed(0)}% threshold`
    );
  }
  if (params.employerEvidencedShare < READINESS_THRESHOLDS.minEmployerEvidencedShare) {
    reasons.push(
      `Required-skill match is only ${(params.employerEvidencedShare * 100).toFixed(1)}% employer-attributed (mostly/entirely inventory-only) — insufficient hands-on evidence for READY_FOR_TAILORING (requires >= ${(READINESS_THRESHOLDS.minEmployerEvidencedShare * 100).toFixed(0)}%)`
    );
  }

  if (reasons.length === 0) {
    return { decision: "READY_FOR_TAILORING", blockingReasons: [] };
  }
  return { decision: "NEEDS_REVIEW", blockingReasons: reasons };
}
