import crypto from "node:crypto";
import { EXTRACTION_VERSION } from "@/lib/jobIntel/extractJobIntel";
import { SKILL_TAXONOMY } from "@/lib/jobIntel/skillsTaxonomy";
import { CREDIT } from "./creditTable";
import { HANDS_ON_CUES } from "./handsOnCues";
import {
  UBIQUITOUS_CATEGORIES,
  RESPONSIBILITY_MIN_EMPLOYER_MATCHED_UNITS,
  RESPONSIBILITY_MODERATE_SCORE,
  RESPONSIBILITY_MODERATE_WEIGHT_SHARE,
  RESPONSIBILITY_STRONG_SCORE,
  RESPONSIBILITY_STRONG_WEIGHT_SHARE,
} from "./roleAlignment";
import { CRITICALITY_WEIGHT, MIN_REQUIREMENT_UNITS, READINESS_THRESHOLDS, SCORING_WEIGHTS } from "./scoring";
import { JOB_LEVEL_INCOMPATIBILITY } from "./seniority";
import { TRACK_PROFILES } from "./trackProfiles";
import { TRANSFERABLE_SKILLS } from "./transferableSkills";

/**
 * Automatic data-fingerprint cache invalidation (Phase 2 Revision 4 §3). Folds every purely-DATA-
 * shaped matching constant into one hash, included in job_match_results' cache key alongside
 * MATCH_ENGINE_VERSION — editing SKILL_TAXONOMY, TRANSFERABLE_SKILLS, the credit table, scoring
 * weights, readiness thresholds, track profiles, or the hands-on-cues regex automatically
 * invalidates every cached match result, with ZERO discipline required (no manual version bump
 * needed for these specifically — see scoring.ts's doc comment for what DOES still need a manual
 * MATCH_ENGINE_VERSION bump: algorithmic/logic changes, which a data hash can't safely capture).
 */
/** The exact object computeMatchKnowledgeHash fingerprints. Exported so a test can assert WHICH
 *  facts participate in cache invalidation, rather than only that the hash is stable. */
export function matchKnowledgeFingerprint(): Record<string, unknown> {
  return {
    // Stage 24C — the JD-side half of a match is the STRUCTURED EXTRACTION of the posting
    // (job_skills rows and their alternative_group_id), not its raw text. jdContentHash covers only
    // title + description_text, and upsertJobIntel deliberately does not touch jobs.updated_at, so
    // before this a re-extraction that genuinely changed a job's requirement units — an extractor
    // fix, exactly like Stage 24C's OR-list grouping repair — left every cached result reusable and
    // the correction never reached a single score. Folding the extractor's own version in makes
    // "the requirements changed" a first-class cache-invalidation reason.
    extractionVersion: EXTRACTION_VERSION,
    skillTaxonomy: SKILL_TAXONOMY,
    transferableSkills: TRANSFERABLE_SKILLS,
    credit: CREDIT,
    criticalityWeight: CRITICALITY_WEIGHT,
    scoringWeights: SCORING_WEIGHTS,
    readinessThresholds: READINESS_THRESHOLDS,
    minRequirementUnits: MIN_REQUIREMENT_UNITS,
    trackProfiles: TRACK_PROFILES,
    handsOnCuesSource: HANDS_ON_CUES.source,
    // Stage 24B — role-alignment's purely-DATA constants join the same automatic invalidation
    // contract as every other tunable above, so recalibrating them needs no manual version bump.
    // (roleAlignment.ts's ALGORITHM — the title parser and the responsibility rule — is covered by
    // MATCH_ENGINE_VERSION instead, exactly as scoring.ts's doc comment prescribes.)
    roleAlignment: {
      responsibilityMinEmployerMatchedUnits: RESPONSIBILITY_MIN_EMPLOYER_MATCHED_UNITS,
      responsibilityStrongWeightShare: RESPONSIBILITY_STRONG_WEIGHT_SHARE,
      responsibilityModerateWeightShare: RESPONSIBILITY_MODERATE_WEIGHT_SHARE,
      responsibilityStrongScore: RESPONSIBILITY_STRONG_SCORE,
      responsibilityModerateScore: RESPONSIBILITY_MODERATE_SCORE,
      ubiquitousCategories: UBIQUITOUS_CATEGORIES,
    },
    // Stage 24C — the Intern/Entry job-level incompatibility thresholds are tunable DATA and join
    // the same automatic invalidation contract (the RULE itself is covered by MATCH_ENGINE_VERSION).
    jobLevelIncompatibility: JOB_LEVEL_INCOMPATIBILITY,
  };
}

export function computeMatchKnowledgeHash(): string {
  return crypto.createHash("sha256").update(JSON.stringify(matchKnowledgeFingerprint())).digest("hex");
}
