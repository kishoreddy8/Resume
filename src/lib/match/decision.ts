import { MIN_REQUIREMENT_UNITS, READINESS_THRESHOLDS } from "./scoring";
import type { Decision, EligibilityResult, RequirementMatch } from "./types";

/**
 * Final readiness decision (Phase 2 Revision 4's final formula, recalibrated by Stage 24B).
 * BLOCKED always wins regardless of score. A critical gap gates independently of score (no
 * score-cap mechanism — the overallScore stays honest and uncapped; see scoring.ts).
 * blockingReasons collects EVERY contributing reason, not just the first, so the UI can show all of
 * them at once.
 *
 * STAGE 24B — WHY ELIGIBILITY "UNKNOWN" NO LONGER BLOCKS READINESS.
 * Measured on the real corpus (19,665 evaluated active jobs, candidate 1): 17,853 of them —
 * 90.8% — carried eligibility status UNKNOWN, every single one for the same reason, verbatim:
 * "No sponsorship signal available for this posting or employer — genuinely unknown, not assumed to
 * pass." Exactly 8 jobs reached PASS. Because the previous implementation pushed those UNKNOWN
 * reasons into `blockingReasons`, an UNKNOWN sponsorship signal made READY_FOR_TAILORING
 * structurally unreachable for 90.8% of the corpus no matter how strong the fit was — the dominant
 * root cause of the observed "0 jobs reached READY_FOR_TAILORING" result. Even ignoring every other
 * gate, at most 8 jobs could ever have qualified.
 *
 * That behaviour also contradicted the system's own stated sponsorship policy. eligibility.ts is
 * explicit that a silent JD is "genuinely unknown, not assumed to pass" — it deliberately does NOT
 * infer a negative. Converting that non-inference into a permanent readiness disqualification is the
 * same inference by another route. UNKNOWN is now an ADVISORY: the reason text is still computed,
 * still persisted in `eligibility_reasons`, still rendered next to the decision by the UI, and
 * sponsorship still dominates For You ordering via src/lib/rank/forYou.ts's sponsorshipTier. What it
 * no longer does is silently veto readiness.
 *
 * NOTHING about hard blockers changed. eligibility.status === "BLOCKED" — an explicit "no visa
 * sponsorship" JD, a required clearance the candidate lacks, a citizenship or existing-work-
 * authorization requirement — still short-circuits to BLOCKED before any score is consulted, and no
 * amount of skill overlap can compensate for it.
 */
export function decide(params: {
  eligibility: EligibilityResult;
  insufficientJdSignal: boolean;
  criticalGaps: RequirementMatch[];
  overallScore: number;
  requirementCoverage: number;
  employerEvidencedShare: number;
  /** 0..1 from src/lib/match/roleAlignment.ts. Stage 24B Phase 10: readiness is score AND hard
   *  constraints AND JD evidence quality AND role alignment AND candidate evidence — not score
   *  alone. */
  roleAlignment: number;
}): { decision: Decision; blockingReasons: string[] } {
  if (params.eligibility.status === "BLOCKED") {
    return { decision: "BLOCKED", blockingReasons: [...params.eligibility.reasons] };
  }

  const reasons: string[] = [];

  if (params.insufficientJdSignal) {
    reasons.push(`Job description too sparse for reliable structured matching (fewer than ${MIN_REQUIREMENT_UNITS} requirement(s) extracted) — verify manually.`);
  }
  if (params.criticalGaps.length > 0) {
    const labels = params.criticalGaps.map((g) => g.requirement.label).join(", ");
    reasons.push(`${params.criticalGaps.length} unresolved/missing critical requirement(s): ${labels}`);
  }
  if (params.roleAlignment < READINESS_THRESHOLDS.minRoleAlignment) {
    reasons.push(
      `Role alignment ${(params.roleAlignment * 100).toFixed(0)}% is below the ${(READINESS_THRESHOLDS.minRoleAlignment * 100).toFixed(0)}% threshold — this posting is not clearly the same kind of role the candidate has actually held`
    );
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
