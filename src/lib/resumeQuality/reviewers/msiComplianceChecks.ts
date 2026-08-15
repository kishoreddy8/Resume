import type { CandidateProfile } from "@/lib/match/types";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";
import { extractCanonicalSkillsFromText, resolveSkillForReview } from "./skillAliases";

/**
 * MASTER SKILLS INVENTORY RULE compliance — the canonical instructions' explicit rule (see
 * canonicalInstructions.ts) that every technology on the resume must be grounded in EITHER the
 * candidate's own Master Skills Inventory (CandidateProfile.skills, source "employer" OR
 * "inventory_only" — both count as "genuinely know", per the rule's own wording) OR an employer's
 * recorded technologies (CandidateProfile.experience[].technologies) — never invented wholesale.
 *
 * This is deliberately NOT the same check as ATS keyword coverage (atsChecks.ts, which measures
 * "does the resume mention what the JD asks for") — this measures the opposite direction: "is
 * everything the resume claims actually traceable to an authoritative candidate source."
 */

export interface MsiComplianceResult {
  /** Canonical technology names found on the resume with NO grounding anywhere in the Master Resume
   *  or Master Skills Inventory — the resume asserts capability the candidate profile never claims. */
  ungroundedTechnologies: string[];
  insufficientProfileData: boolean;
}

function candidateAuthoritativeSkillSet(profile: CandidateProfile): Set<string> {
  const canonical = new Set<string>();
  for (const skill of profile.skills) {
    const resolved = resolveSkillForReview(skill.rawSkillName);
    canonical.add(resolved?.canonical ?? skill.rawSkillName);
  }
  for (const entry of profile.experience) {
    for (const tech of entry.technologies) {
      const resolved = resolveSkillForReview(tech);
      canonical.add(resolved?.canonical ?? tech);
    }
  }
  return canonical;
}

/** Skills genuinely evidenced by the resume's OWN experience/skills sections — summary is
 *  deliberately excluded here (a summary can reasonably reference the target role's stack in framing
 *  language; MSI grounding matters most for what's asserted as actual capability/experience). */
function resumeClaimedTechnologies(resume: ResumeContent): Set<string> {
  const text = [...resume.skillGroups.flatMap((g) => g.items), ...resume.experience.flatMap((e) => e.bullets)].join("\n");
  return extractCanonicalSkillsFromText(text);
}

export function evaluateMsiCompliance(resume: ResumeContent, masterResumeProfile: CandidateProfile | undefined): MsiComplianceResult {
  if (!masterResumeProfile) {
    return { ungroundedTechnologies: [], insufficientProfileData: true };
  }

  const authoritative = candidateAuthoritativeSkillSet(masterResumeProfile);
  const claimed = resumeClaimedTechnologies(resume);

  const ungroundedTechnologies = [...claimed].filter((skill) => !authoritative.has(skill)).sort();

  return { ungroundedTechnologies, insufficientProfileData: false };
}
