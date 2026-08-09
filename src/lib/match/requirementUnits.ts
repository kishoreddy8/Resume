import type { JobCertification, JobSkill, RequirementLevel } from "@/types";
import { deriveCriticality } from "./requirementCriticality";
import { isExperienceDepthRequired } from "./handsOnCues";
import type { RequirementUnit } from "./types";

/**
 * Builds the JD-side Requirement Units from data Phase 1 already extracted — job_skills (collapsed
 * by alternative_group_id so an "AWS OR Azure" alternation is ONE unit, satisfied by any one member,
 * never split into per-member credit), job_certifications, and the education_* columns on jobs.
 * Pure function, no DB access, no re-scanning of raw text — see unclaimedRequirementDetector.ts for
 * the one place that DOES scan qualification-section text, and only for lines these units don't
 * already cover.
 */

function buildEvidenceSnippets(snippets: (string | null)[]): string[] {
  return snippets.filter((s): s is string => s !== null && s.length > 0);
}

export function collapseSkillUnits(skills: JobSkill[], jobTitle: string): RequirementUnit[] {
  const grouped = new Map<string, JobSkill[]>();
  const ungrouped: JobSkill[] = [];

  for (const skill of skills) {
    if (skill.alternative_group_id) {
      const key = skill.alternative_group_id;
      const list = grouped.get(key) ?? [];
      list.push(skill);
      grouped.set(key, list);
    } else {
      ungrouped.push(skill);
    }
  }

  const units: RequirementUnit[] = [];

  for (const skill of ungrouped) {
    const memberSkillNames = [skill.skill_name];
    const evidenceSnippets = buildEvidenceSnippets([skill.evidence_snippet]);
    units.push({
      kind: "skill",
      memberSkillNames,
      categories: [skill.category],
      label: skill.skill_name,
      requirementLevel: skill.requirement_level,
      criticality: deriveCriticality({
        requirementLevel: skill.requirement_level,
        evidenceSnippets,
        jobTitle,
        memberSkillNames,
      }),
      evidenceSnippets,
      experienceDepthRequired: isExperienceDepthRequired(evidenceSnippets),
      fromUnclaimedText: false,
    });
  }

  for (const [, members] of grouped) {
    const memberSkillNames = members.map((m) => m.skill_name);
    // Every member of one alternation group shares the same requirement_level by construction (see
    // src/lib/jobIntel/skills.ts's buildMatchesForLine — one classified level applies to the whole
    // line/group it came from), so taking the first member's level is safe, not a guess.
    const requirementLevel: RequirementLevel = members[0].requirement_level;
    const evidenceSnippets = buildEvidenceSnippets(members.map((m) => m.evidence_snippet));
    units.push({
      kind: "skill_group",
      memberSkillNames,
      categories: [...new Set(members.map((m) => m.category))],
      label: memberSkillNames.join(" OR "),
      requirementLevel,
      criticality: deriveCriticality({ requirementLevel, evidenceSnippets, jobTitle, memberSkillNames }),
      evidenceSnippets,
      experienceDepthRequired: isExperienceDepthRequired(evidenceSnippets),
      fromUnclaimedText: false,
    });
  }

  return units;
}

export function buildCertificationUnits(certifications: JobCertification[], jobTitle: string): RequirementUnit[] {
  return certifications.map((cert) => {
    const evidenceSnippets = buildEvidenceSnippets([cert.evidence_snippet]);
    return {
      kind: "certification",
      memberSkillNames: [],
      categories: [],
      label: cert.name,
      requirementLevel: cert.requirement_level,
      criticality: deriveCriticality({
        requirementLevel: cert.requirement_level,
        evidenceSnippets,
        jobTitle,
        memberSkillNames: [cert.name],
      }),
      evidenceSnippets,
      experienceDepthRequired: false, // not a meaningful concept for "do you hold this certification"
      fromUnclaimedText: false,
    };
  });
}

export interface EducationRequirementInput {
  level: string | null;
  field: string | null;
  requirement: RequirementLevel | "Unknown" | null;
  equivalentExperienceAllowed: boolean;
  evidence: string | null;
}

export function buildEducationUnit(input: EducationRequirementInput): RequirementUnit | null {
  // No degree requirement extracted, or extracted with no clear Required/Preferred signal — never
  // fabricate a requirement unit from an absence (same "Unknown stays Unknown" discipline as Phase 1).
  if (!input.level || input.requirement === "Unknown" || input.requirement === null) return null;

  const evidenceSnippets = buildEvidenceSnippets([input.evidence]);
  const label = input.field ? `${input.level} in ${input.field}` : input.level;
  const criticality = input.equivalentExperienceAllowed
    ? // The JD itself states a flexible path exists — never gate readiness as hard as a strict
      // requirement with no such flexibility.
      (input.requirement === "Preferred" ? "PREFERRED" : "REQUIRED")
    : deriveCriticality({ requirementLevel: input.requirement, evidenceSnippets, jobTitle: "", memberSkillNames: [] });

  return {
    kind: "education",
    memberSkillNames: [],
    categories: [],
    label,
    requirementLevel: input.requirement,
    criticality,
    evidenceSnippets,
    experienceDepthRequired: false,
    fromUnclaimedText: false,
  };
}
