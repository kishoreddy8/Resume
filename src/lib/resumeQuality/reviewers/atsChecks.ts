import type { RequirementUnit } from "@/lib/match/types";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";
import { extractCanonicalSkillsFromText } from "./skillAliases";

/**
 * ATS keyword alignment — compares the tailored resume's evidenced canonical skills against Phase
 * 2's own JD-side RequirementUnit[] (criticality/requirementLevel, already canonical). Review only:
 * this module never rewrites or reorders the resume, it only measures overlap.
 */
export interface AtsAlignmentResult {
  atsScore: number;
  keywordAlignmentScore: number;
  missingRequiredSkills: string[];
  /** Present but not required-satisfying — informational, not a StructuredResumeReview field on its
   *  own; folded into scoring and requiredCorrections by the caller. */
  missingPreferredSkills: string[];
  /** True when jobRequirements was empty/absent — caller surfaces this as a limitation rather than
   *  silently treating the resulting scores as a real, evidenced measurement. */
  insufficientRequirementData: boolean;
}

function resumeCanonicalSkills(resume: ResumeContent): Set<string> {
  const allText = [
    ...resume.summary,
    ...resume.skillGroups.flatMap((g) => g.items),
    ...resume.experience.flatMap((e) => e.bullets),
    ...(resume.certifications ?? []),
  ].join("\n");
  return extractCanonicalSkillsFromText(allText);
}

export function evaluateAtsAlignment(resume: ResumeContent, jobRequirements: RequirementUnit[] | undefined): AtsAlignmentResult {
  const evidenced = resumeCanonicalSkills(resume);

  const skillUnits = (jobRequirements ?? []).filter((u) => u.kind === "skill" || u.kind === "skill_group");
  if (skillUnits.length === 0) {
    return {
      atsScore: 50,
      keywordAlignmentScore: 50,
      missingRequiredSkills: [],
      missingPreferredSkills: [],
      insufficientRequirementData: true,
    };
  }

  const requiredUnits = skillUnits.filter((u) => u.requirementLevel === "Required");
  const preferredUnits = skillUnits.filter((u) => u.requirementLevel === "Preferred");

  const isSatisfied = (unit: RequirementUnit) => unit.memberSkillNames.some((name) => evidenced.has(name));

  const missingRequiredSkills = requiredUnits.filter((u) => !isSatisfied(u)).map((u) => u.label);
  const missingPreferredSkills = preferredUnits.filter((u) => !isSatisfied(u)).map((u) => u.label);

  // Vacuous truth: zero units at a given level means nothing to miss at that level.
  const requiredCoverage = requiredUnits.length === 0 ? 1 : (requiredUnits.length - missingRequiredSkills.length) / requiredUnits.length;
  const preferredCoverage = preferredUnits.length === 0 ? 1 : (preferredUnits.length - missingPreferredSkills.length) / preferredUnits.length;

  // Criticality-weighted: required coverage dominates, matching "ATS systems gate on required
  // qualifications far more than preferred ones."
  const atsScore = Math.round(100 * (0.75 * requiredCoverage + 0.25 * preferredCoverage));

  // Broader raw overlap across ALL JD-mentioned canonical skills, not criticality-weighted — a
  // distinct signal from atsScore (see the module doc comment).
  const allJdSkillNames = new Set(skillUnits.flatMap((u) => u.memberSkillNames));
  const overlap = [...allJdSkillNames].filter((name) => evidenced.has(name)).length;
  const keywordAlignmentScore = allJdSkillNames.size === 0 ? 50 : Math.round((100 * overlap) / allJdSkillNames.size);

  return {
    atsScore: Math.min(100, Math.max(0, atsScore)),
    keywordAlignmentScore: Math.min(100, Math.max(0, keywordAlignmentScore)),
    missingRequiredSkills,
    missingPreferredSkills,
    insufficientRequirementData: false,
  };
}
