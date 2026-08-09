import crypto from "node:crypto";
import { SKILL_TAXONOMY } from "@/lib/jobIntel/skillsTaxonomy";
import { CREDIT } from "./creditTable";
import { HANDS_ON_CUES } from "./handsOnCues";
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
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}
