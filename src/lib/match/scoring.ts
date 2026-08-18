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
 *
 * v3 (Stage 24B, bumped after auditing 19,665 real evaluations for candidate 1): TWO algorithmic
 * changes, both forced by what that audit found, both documented at their call sites below.
 *   (a) A `roleAlignment` dimension now participates in the score (src/lib/match/roleAlignment.ts).
 *       Before this, role identity had ZERO weight anywhere in the score and the top of the ranked
 *       list was "Cust Care Rep II", "Mammography Technologist" and "Classroom Floater", all at 100.
 *   (b) computeOverallScore no longer lets experience/seniority carry the score on their own — see
 *       its doc comment. 1,255 jobs scored >= 80 with NO skill dimension applicable at all, purely
 *       because a JD stating nothing but "3+ years experience" left `experience` as the single
 *       applicable dimension and weight redistribution handed it 100% of the weight.
 *
 * v4 (Stage 24C, bumped after an independent second audit pass over the same engine): ONE
 * algorithmic change — seniorityAlignmentScore now recognises an explicit Intern/Entry JD level as a
 * JOB-level incompatibility when CareerOps already evidences the candidate is past that level (see
 * seniority.ts's JOB_LEVEL_INCOMPATIBILITY). Before this, candidate 1's keyword-free "Data Engineer"
 * title left candidate seniority Unknown, so the dimension was inapplicable for every job level and a
 * "Data Engineer Intern" posting scored identically to a "Senior Data Engineer" one. No candidate
 * seniority is claimed or inferred anywhere by that rule.
 */
export const MATCH_ENGINE_VERSION = 6;

/**
 * Stage 24B weights. `roleAlignment` is deliberately the second-heaviest term: Phase 4's requirement
 * is that a Senior/Azure/Snowflake/Databricks/Platform Data Engineer role outranks an unrelated role
 * that merely shares Python/SQL/Docker, and only a real role-identity term can express that. Required
 * coverage stays dominant — role identity decides WHETHER this is the candidate's kind of job,
 * required coverage decides HOW WELL they cover it.
 */
export const SCORING_WEIGHTS = {
  roleAlignment: 25,
  required: 40,
  preferred: 10,
  experience: 15,
  seniority: 10,
} as const;

export const READINESS_THRESHOLDS = {
  minScore: 80,
  minCoverage: 0.85,
  minEmployerEvidencedShare: 0.5,
  /** Stage 24B Phase 10: readiness is not score alone. A job the candidate should TAILOR A RESUME FOR
   *  must be their kind of job — 0.75 is "same profession with overlapping specialisation" or better
   *  (see roleAlignment.ts's scoreTitleAlignment), never the bare same-profession 0.35 tier. */
  minRoleAlignment: 0.75,
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

/**
 * Honest weighted average over only the APPLICABLE (non-null) dimensions — weight is redistributed
 * proportionally, never divided by zero, never mutated/capped afterward (Revision 4 §7 removed the
 * earlier score-cap in favor of decide()'s independent critical-gap gate).
 *
 * STAGE 24B — REQUIREMENT ANCHOR. Experience and seniority are SUPPORTING dimensions: they qualify a
 * fit, they cannot constitute one. They participate only when at least one requirement-coverage
 * dimension (required/preferred) is applicable. Without this rule, weight redistribution let a JD
 * that stated nothing but a years-of-experience minimum produce a perfect score: measured on the real
 * corpus, 1,255 jobs scored >= 80 with no skill dimension at all, and the entire 100-point band was
 * roles like "Classroom Floater" and "Material Handler" whose only applicable dimension was
 * `experience: 100`. Role alignment is exempt from the anchor because it is itself an independent
 * fit signal derived from the candidate's own employment history, and because keeping it always
 * applicable guarantees the applicable set is never empty.
 *
 * This does NOT invent a floor or a cap. A job with no extracted requirements now scores what its
 * role alignment alone supports, and `insufficientJdSignal` (set independently) tells every consumer
 * that even that number is low-confidence — an unknown, never a confident verdict.
 */
export function computeOverallScore(dimensions: DimensionScores, hasSkillRequirement = true): number {
  // STAGE 25B — THE ANCHOR MUST BE A *SKILL* REQUIREMENT.
  //
  // Stage 24B established that experience/seniority cannot constitute a fit on their own, and gated
  // them behind "at least one requirement-coverage dimension is applicable". Stage 25B's section-
  // boundary fix extracts requirements from ~1,750 more postings, and that surfaced the same
  // inflation through a different door: a posting whose ONLY extracted requirement unit is an
  // EDUCATION unit. Measured on the real corpus, 29 live jobs landed on
  // {roleAlignment: 0, required: 100, preferred: 0, experience: 100} = 61.1 — "Pharmaceutical Sales
  // Representative" (only unit: "BA/BS required" -> Bachelor's, which the candidate holds),
  // "Crisis & Referral Specialist", "Vaccines Specialist", "Facilities Technician" — and they
  // outranked genuine postings like "Data Platform Engineer, VP II" (57) in the For You feed.
  //
  // A matched degree is a binary "does the candidate hold this" fact. It is not evidence that this
  // posting is the candidate's kind of job, which is exactly why computeEmployerEvidencedShare
  // already excludes education/certification units from ITS gate. The same reasoning applies here:
  // education alone does not open the door for experience/seniority to carry a score.
  //
  // Callers that cannot distinguish unit kinds default to `true`, preserving the previous behaviour.
  const hasRequirementAnchor = (dimensions.required !== null || dimensions.preferred !== null) && hasSkillRequirement;

  const applicable: { weight: number; score: number }[] = [];
  // `!= null` (not `!== null`) on purpose: a v2-or-earlier persisted row round-tripped back through
  // this function has no roleAlignment key at all, and an `undefined` must be treated as
  // inapplicable, never pushed as a NaN-producing weight.
  if (dimensions.roleAlignment != null) applicable.push({ weight: SCORING_WEIGHTS.roleAlignment, score: dimensions.roleAlignment });
  if (dimensions.required !== null) applicable.push({ weight: SCORING_WEIGHTS.required, score: dimensions.required });
  if (dimensions.preferred !== null) applicable.push({ weight: SCORING_WEIGHTS.preferred, score: dimensions.preferred });
  if (hasRequirementAnchor && dimensions.experience !== null) applicable.push({ weight: SCORING_WEIGHTS.experience, score: dimensions.experience });
  if (hasRequirementAnchor && dimensions.seniority !== null) applicable.push({ weight: SCORING_WEIGHTS.seniority, score: dimensions.seniority });

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
