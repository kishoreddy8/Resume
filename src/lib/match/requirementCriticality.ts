import type { RequirementCriticality } from "./types";

/**
 * Promotes a Required-tier requirement to CRITICAL when either (a) the skill/requirement is
 * mentioned in the job title itself, or (b) its evidence text carries an explicit non-negotiable
 * cue phrase. A pure derived layer over data Phase 1 already extracted (job_skills/job_certifications/
 * education fields + description_sections) — never modifies jobIntel's own extractors or columns.
 *
 * Preferred-tier requirements are never promoted to CRITICAL in V1 — CRITICAL is specifically a
 * stronger form of REQUIRED, not an independent axis.
 */
const NON_NEGOTIABLE_CUES = /\b(must have|non[\s-]negotiable|hard requirement|minimum qualification|mandatory)\b/i;

export function deriveCriticality(params: {
  requirementLevel: "Required" | "Preferred";
  evidenceSnippets: string[];
  jobTitle: string;
  memberSkillNames: string[];
}): RequirementCriticality {
  if (params.requirementLevel === "Preferred") return "PREFERRED";

  const titleLower = params.jobTitle.toLowerCase();
  const mentionedInTitle = params.memberSkillNames.some(
    (name) => name.length > 0 && titleLower.includes(name.toLowerCase())
  );
  const snippetText = params.evidenceSnippets.join(" ");
  if (mentionedInTitle || NON_NEGOTIABLE_CUES.test(snippetText)) return "CRITICAL";
  return "REQUIRED";
}
