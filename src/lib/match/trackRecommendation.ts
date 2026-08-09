import type { SkillCategory } from "@/types";
import { CRITICALITY_WEIGHT } from "./scoring";
import { TRACK_PROFILES } from "./trackProfiles";
import type { RequirementUnit, ResumeTrack } from "./types";

/** Job's own criticality-weighted category distribution, built from RequirementUnits.categories
 *  (populated from job_skills.category — see requirementUnits.ts). */
function jobCategoryWeights(units: RequirementUnit[]): Map<SkillCategory, number> {
  const weights = new Map<SkillCategory, number>();
  for (const unit of units) {
    const unitWeight = CRITICALITY_WEIGHT[unit.criticality];
    for (const category of unit.categories) {
      weights.set(category, (weights.get(category) ?? 0) + unitWeight);
    }
  }
  return weights;
}

export function recommendTrack(units: RequirementUnit[]): ResumeTrack {
  const jobWeights = jobCategoryWeights(units);
  if (jobWeights.size === 0) return "General / Unclassified";

  let best: { track: ResumeTrack; score: number } = { track: "General / Unclassified", score: 0 };
  for (const profile of TRACK_PROFILES) {
    let score = 0;
    for (const signal of profile.signals) {
      if (signal.kind === "category_distribution" && signal.category) {
        score += signal.weight * (jobWeights.get(signal.category) ?? 0);
      }
      // title_keyword / specific_technology signals: not yet populated in any TRACK_PROFILES entry
      // in V1 (see trackProfiles.ts's doc comment) — the branch exists so adding one later is
      // additive here, not a reshape.
    }
    if (score > best.score) best = { track: profile.track, score };
  }
  return best.track;
}
