import type { RequirementLevel, SkillCategory } from "@/types";

/**
 * Phase 2 — Job Eligibility + Candidate Matching + Explainable Scoring + Tailoring Readiness.
 *
 * SAFETY: nothing here writes into any Phase 1 table/column, and nothing in Phase 1's deterministic
 * pipeline (scan/dedupe/lifecycle/suppression/H1B/jobIntel) imports from src/lib/match/. This module
 * tree only READS jobs/job_skills/job_certifications and the candidate-profile file — see
 * CAREER_OPS_HANDOFF.md's Phase 2 approved architecture (Revisions 1-4) for the full design record.
 *
 * Zero new AI tasks in V1 — everything below is pure, deterministic, synchronous computation.
 */

// --- Candidate profile (derived index — Master Resume/Skills Inventory remain authoritative) ----

export type SkillEvidenceSource = "employer" | "inventory_only";

/** Persisted in data/master/candidate-profile.json, written only by the build-candidate-profile
 *  skill. `rawSkillName` is the authoritative truth; canonical-taxonomy resolution is deliberately
 *  NOT stored here (see normalizeCandidateSkills.ts) so a later SKILL_TAXONOMY addition normalizes
 *  previously-unrecognized skills automatically, without ever rewriting this file. */
export interface CandidateSkillEntry {
  rawSkillName: string;
  source: SkillEvidenceSource;
  attributedTo?: { employer: string; project?: string }[];
  /** Only set when the Master Resume/Skills Inventory explicitly states a number for THIS skill —
   *  never inferred from an employer's tenure or a role's date range. */
  yearsStated?: number;
}

export interface CandidateExperienceEntry {
  employer: string;
  title: string;
  /** ISO date (YYYY-MM-DD) or ISO year-month (YYYY-MM) — best-effort per what the Master Resume
   *  actually states. Absent/unparseable dates are excluded from union-duration math, never guessed. */
  startDate: string | null;
  endDate: string | null; // null = current role
  technologies: string[]; // rawSkillName values this role's bullets actually attribute
}

export interface CandidateEducationEntry {
  level: string; // e.g. "Bachelor's", "Master's"
  field: string | null;
  institution: string | null;
}

export interface CandidateCertification {
  name: string;
  issuer?: string;
}

export interface CandidateProfile {
  schemaVersion: number;
  sourceHashes: { resume: string; skills: string };
  builtAt: string;
  skills: CandidateSkillEntry[];
  experience: CandidateExperienceEntry[];
  education: CandidateEducationEntry[];
  certifications: CandidateCertification[];
  /** Only set when unambiguously computable via interval-union math over parseable dates — see
   *  experienceDuration.ts. null = unknown, never 0-as-a-guess. */
  totalYearsExperience: number | null;
}

/** Derived, NEVER persisted — recomputed fresh on every match run from CandidateSkillEntry.rawSkillName
 *  against the CURRENT SKILL_TAXONOMY. See normalizeCandidateSkills.ts. */
export interface NormalizedCandidateSkill extends CandidateSkillEntry {
  canonicalSkillName: string | null; // null = taxonomy has no alias for this raw name yet
  category: SkillCategory | null;
}

// --- Requirement units (the JD side) --------------------------------------------------------

export type RequirementCriticality = "CRITICAL" | "REQUIRED" | "PREFERRED" | "OPTIONAL";
export type RequirementUnitKind = "skill_group" | "skill" | "education" | "certification";

export interface RequirementUnit {
  kind: RequirementUnitKind;
  /** Canonical skill name(s) this unit represents. length > 1 only for a collapsed OR-alternative
   *  group (job_skills rows sharing one alternative_group_id) — satisfying ANY one member satisfies
   *  the whole unit; it is never split back into per-member credit. Empty for education units. */
  memberSkillNames: string[];
  /** SKILL_TAXONOMY categories of the member skills (job_skills.category, passed through) — used
   *  only by trackRecommendation.ts's category-distribution signal. Empty for education/certification
   *  units and for unclaimed-text units (no taxonomy category applies). */
  categories: SkillCategory[];
  label: string; // human-readable, for UI (e.g. "AWS OR Azure", "Kubernetes", "Bachelor's in CS")
  requirementLevel: RequirementLevel; // "Required" | "Preferred" — which coverage pool this belongs to
  criticality: RequirementCriticality;
  evidenceSnippets: string[];
  /** True when this unit's evidence text matched a hands-on/production-experience cue — see
   *  handsOnCues.ts. Reduces inventory-only credit for this unit specifically (scoring.ts). */
  experienceDepthRequired: boolean;
  /** True only for units produced by unclaimedRequirementDetector.ts — a JD line that mentions a
   *  real requirement no structured extractor (job_skills/job_certifications/education) captured. */
  fromUnclaimedText: boolean;
}

// --- Matching outcomes -----------------------------------------------------------------------

export type MatchType = "MATCHED" | "TRANSFERABLE" | "MISSING" | "UNRESOLVED";

export interface RequirementMatch {
  requirement: RequirementUnit;
  matchType: MatchType;
  credit: number; // 0..1, see scoring.ts's credit table — the ONLY place evidence strength is scored
  evidence?: {
    source: SkillEvidenceSource;
    rawSkillName: string;
    canonicalSkillName: string | null;
    employers?: string[];
    yearsStated?: number;
  };
  transferable?: { fromRawSkillName: string; toCanonicalSkillName: string; strength: "strong" | "moderate"; reason: string };
}

// --- Eligibility -----------------------------------------------------------------------------

export type SponsorshipJobSignal = "explicit_positive" | "explicit_negative" | "silent_company_history" | "unknown" | "not_applicable";

export interface EligibilityResult {
  /** PASS means only "no known hard blocker" — never "confirmed eligible" or "sponsorship
   *  confirmed". UI must always render `reasons`/`sponsorship.note` alongside this, never the
   *  bare status. */
  status: "PASS" | "BLOCKED" | "UNKNOWN";
  reasons: string[];
  sponsorship: { signal: SponsorshipJobSignal; note: string };
}

// --- Track recommendation ----------------------------------------------------------------------

export type ResumeTrack =
  | "Azure Data Engineer"
  | "Data Engineer"
  | "Snowflake Data Engineer"
  | "Azure Databricks Engineer"
  | "AI Engineer"
  | "General / Unclassified";

// --- Seniority -------------------------------------------------------------------------------

export interface CandidateSeniorityEstimate {
  level: import("@/types").Seniority;
  derivedFrom: "most_recent_title" | "unknown";
  note: string;
}

// --- Final result ------------------------------------------------------------------------------

export type Decision = "BLOCKED" | "NEEDS_REVIEW" | "READY_FOR_TAILORING";

export interface DimensionScores {
  required: number | null; // 0..100, null = inapplicable (zero Required units)
  preferred: number | null;
  experience: number | null;
  seniority: number | null;
}

export interface JobMatchResult {
  candidateId: number;
  jobId: number;
  dedupeKey: string;
  matchEngineVersion: number;
  matchKnowledgeHash: string;
  candidateProfileHash: string;
  candidateSettingsHash: string;
  jdContentHash: string;
  computedAt: string;

  eligibility: EligibilityResult;

  dimensionScores: DimensionScores;
  overallScore: number; // honest weighted average, never capped/mutated
  requirementCoverage: number; // 0..1, criticality-weighted
  employerEvidencedShare: number; // 0..1
  insufficientJdSignal: boolean;

  employerEvidencedMatches: RequirementMatch[];
  inventoryOnlyMatches: RequirementMatch[];
  transferableMatches: RequirementMatch[];
  missingRequirements: RequirementMatch[];
  unresolvedRequirements: RequirementMatch[];
  criticalGaps: RequirementMatch[];

  unrecognizedCandidateSkills: string[]; // rawSkillName values with no taxonomy match — diagnostic

  recommendedTrack: ResumeTrack;
  decision: Decision;
  blockingReasons: string[]; // empty iff decision === READY_FOR_TAILORING
}

export type EvaluateMatchResult =
  | { status: "unavailable"; reason: "missing_candidate_profile" | "stale_candidate_profile" }
  | { status: "ok"; data: JobMatchResult };
