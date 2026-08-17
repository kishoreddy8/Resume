import crypto from "node:crypto";
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
export function computeMatchKnowledgeHash(): string {
  const payload = JSON.stringify({
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
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}
