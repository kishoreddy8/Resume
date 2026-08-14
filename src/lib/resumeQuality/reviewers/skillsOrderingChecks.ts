import type { RequirementUnit } from "@/lib/match/types";
import type { SkillGroup } from "../../../../tools/tailoring-engine/types";
import { extractCanonicalSkillsFromText } from "./skillAliases";

const BURIED_GROUP_INDEX_THRESHOLD = 2; // "the top" == the first 3 groups (indices 0-2)

export interface SkillsOrderingCheckResult {
  skillsOrderingIssues: string[];
  insufficientRequirementData: boolean;
}

/** Deterministic only: checks whether the JD's dominant (CRITICAL/REQUIRED) technologies appear
 *  within the first few Technical Skills groups, never rewrites the section. */
export function evaluateSkillsOrdering(skillGroups: SkillGroup[], jobRequirements: RequirementUnit[] | undefined): SkillsOrderingCheckResult {
  if (!jobRequirements || jobRequirements.length === 0) {
    return { skillsOrderingIssues: [], insufficientRequirementData: true };
  }

  const dominant = jobRequirements
    .filter((u) => (u.kind === "skill" || u.kind === "skill_group") && (u.criticality === "CRITICAL" || u.criticality === "REQUIRED"))
    .flatMap((u) => u.memberSkillNames)
    .slice(0, 6);

  if (dominant.length === 0 || skillGroups.length === 0) {
    return { skillsOrderingIssues: [], insufficientRequirementData: false };
  }

  const issues: string[] = [];
  for (const skillName of dominant) {
    let foundAtIndex: number | null = null;
    for (let i = 0; i < skillGroups.length; i++) {
      const groupCanonical = extractCanonicalSkillsFromText(skillGroups[i].items.join(" "));
      if (groupCanonical.has(skillName)) {
        foundAtIndex = i;
        break;
      }
    }
    if (foundAtIndex === null) {
      issues.push(`Dominant JD requirement "${skillName}" does not appear in Technical Skills at all.`);
    } else if (foundAtIndex > BURIED_GROUP_INDEX_THRESHOLD) {
      issues.push(`Dominant JD requirement "${skillName}" is buried in skill group #${foundAtIndex + 1} ("${skillGroups[foundAtIndex].label}") instead of near the top.`);
    }
  }

  return { skillsOrderingIssues: issues, insufficientRequirementData: false };
}
