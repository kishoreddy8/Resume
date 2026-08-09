import type { DimensionScores, RequirementCriticality, RequirementMatch } from "./types";

/**
 * Central versioning + scoring/coverage/gate formulas (Phase 2 Revision 4 §11 final formula).
 * V1 HYPOTHESES throughout — not empirically validated, first calibration pass. Revisit after
 * running the deterministic engine against real jobs in data/app.db.
 *
 * VERSIONING (Revision 4 §3): bump MATCH_ENGINE_VERSION by hand whenever ALGORITHMIC/LOGIC changes
 * to any of: requirement-unit construction (OR-group collapsing, unclaimedRequirementDetector's
 * classification algorithm), the requirement-criticality promotion algorithm, eligibility
 * decision-table logic, this file's formula structure / decide()'s gating order,
 * normalizeCandidateSkills' matching algorithm, or the experience-duration union-interval algorithm.
 * Purely DATA-shaped constants below (weights/thresholds/credit table/taxonomy/transferable
 * pairs/track profiles/hands-on cues) are instead covered AUTOMATICALLY by matchKnowledgeHash.ts —
 * no manual bump needed for editing those.
 *
 * v2 (bumped during real-data validation): computeEmployerEvidencedShare now excludes education/
 * certification units from its calculation — they were incorrectly diluting/inflating a gate meant
 * specifically for skill evidence strength. See that function's doc comment for the full story.
 */
export const MATCH_ENGINE_VERSION = 2;

export const SCORING_WEIGHTS = {
  required: 50,
  preferred: 15,
  experience: 20,
  seniority: 15,
} as const;

export const READINESS_THRESHOLDS = {
  minScore: 80,
  minCoverage: 0.85,
  minEmployerEvidencedShare: 0.5,
} as const;

export const MIN_REQUIREMENT_UNITS = 3;

export const CRITICALITY_WEIGHT: Record<RequirementCriticality, number> = {
  CRITICAL: 3,
  REQUIRED: 2,
  PREFERRED: 1,
  OPTIONAL: 0.5,
};

/** RequiredUnits.length > 0 ? ... : null — a dimension with zero units is inapplicable, never a
 *  guessed 0% or a vacuous 100%. See computeOverallScore for the weight-redistribution this feeds. */
export function computeCoverageDimensionScore(matches: RequirementMatch[]): number | null {
  if (matches.length === 0) return null;
  const totalCredit = matches.reduce((sum, m) => sum + m.credit, 0);
  return (totalCredit / matches.length) * 100;
}

/** Honest weighted average over only the APPLICABLE (non-null) dimensions — weight is redistributed
 *  proportionally, never divided by zero, never mutated/capped afterward (Revision 4 §7 removed the
 *  earlier score-cap in favor of decide()'s independent critical-gap gate). */
export function computeOverallScore(dimensions: DimensionScores): number {
  const applicable: { weight: number; score: number }[] = [];
  if (dimensions.required !== null) applicable.push({ weight: SCORING_WEIGHTS.required, score: dimensions.required });
  if (dimensions.preferred !== null) applicable.push({ weight: SCORING_WEIGHTS.preferred, score: dimensions.preferred });
  if (dimensions.experience !== null) applicable.push({ weight: SCORING_WEIGHTS.experience, score: dimensions.experience });
  if (dimensions.seniority !== null) applicable.push({ weight: SCORING_WEIGHTS.seniority, score: dimensions.seniority });

  const totalWeight = applicable.reduce((sum, a) => sum + a.weight, 0);
  if (totalWeight === 0) return 0; // pathological (every dimension inapplicable) — never divide by zero

  const weighted = applicable.reduce((sum, a) => sum + a.weight * a.score, 0);
  return Math.round((weighted / totalWeight) * 10) / 10;
}

/** Criticality-weighted confidence metric — independent of overallScore. Zero total evidence reads
 *  as ZERO confidence (never skipped, never a vacuous 100%) — see the guarded division below. */
export function computeRequirementCoverage(allMatches: RequirementMatch[]): number {
  const totalWeight = allMatches.reduce((sum, m) => sum + CRITICALITY_WEIGHT[m.requirement.criticality], 0);
  if (totalWeight === 0) return 0;
  const resolvedWeight = allMatches
    .filter((m) => m.matchType !== "UNRESOLVED")
    .reduce((sum, m) => sum + CRITICALITY_WEIGHT[m.requirement.criticality], 0);
  return Math.round((resolvedWeight / totalWeight) * 1000) / 1000;
}

/** What fraction of the Required-pool's EARNED credit came from employer-attributed evidence
 *  specifically, as opposed to inventory-only or transferable credit — the gate that stops a broad
 *  Master Skills Inventory from manufacturing READY_FOR_TAILORING on its own (Revision 4 §9).
 *
 *  Restricted to skill/skill_group units on purpose (bug found during real-data validation):
 *  education/certification units are a binary "does the candidate hold this" fact with no
 *  employer/inventory evidence-strength distinction (see skillMatching.ts's education/certification
 *  branches — a MATCHED one is marked `evidence.source: "employer"` only as a display convenience,
 *  never a real claim of employer-attributed skill depth). Counting them here would let a matched
 *  degree/certification dilute or inflate this specifically skill-evidence-strength gate — exactly
 *  what §9 exists to prevent, just via a different unit kind than the one it was designed against. */
export function computeEmployerEvidencedShare(requiredMatches: RequirementMatch[]): number {
  const skillMatches = requiredMatches.filter((m) => m.requirement.kind === "skill" || m.requirement.kind === "skill_group");
  const totalCredit = skillMatches.reduce((sum, m) => sum + m.credit, 0);
  if (totalCredit === 0) return 0;
  const employerCredit = skillMatches.filter((m) => m.evidence?.source === "employer").reduce((sum, m) => sum + m.credit, 0);
  return Math.round((employerCredit / totalCredit) * 1000) / 1000;
}

export function isInsufficientJdSignal(allMatches: RequirementMatch[]): boolean {
  return allMatches.length < MIN_REQUIREMENT_UNITS;
}

export function criticalGaps(allMatches: RequirementMatch[]): RequirementMatch[] {
  return allMatches.filter((m) => m.requirement.criticality === "CRITICAL" && (m.matchType === "MISSING" || m.matchType === "UNRESOLVED"));
}
