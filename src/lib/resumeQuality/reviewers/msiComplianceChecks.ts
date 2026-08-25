import type { CandidateProfile } from "@/lib/match/types";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";
import { extractCanonicalSkillsFromText, resolveSkillForReview } from "./skillAliases";
import { isCapabilityGroundedForCandidate } from "../jdRequirementReconciler";

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

  // PHASE 6.4A — SHARED CANONICAL CAPABILITY-GROUNDING CONTRACT.
  //
  // A name Phase 2's own literal-identity taxonomy (candidateAuthoritativeSkillSet, built from
  // skillAliases.ts's SKILL_TAXONOMY) does not find directly authoritative gets a second check
  // against jdRequirementReconciler.ts's isCapabilityGroundedForCandidate before being reported
  // ungrounded. This matters specifically for a canonical CAPABILITY/ARCHITECTURE name — e.g. "Data
  // Governance" — that Phase 2's taxonomy correctly treats as distinct from its own evidence products
  // (Microsoft Purview, RBAC are genuinely different things there, not aliases), but that Phase 6.2's
  // JD reconciler already determined is grounded via those exact products' broader evidence
  // relationship. Without this, the SAME candidate evidence could be "supported" for the JD
  // reconciler/writer and "ungrounded" for this reviewer — the two disagreeing about one candidate's
  // one piece of evidence. A name absent from BOTH taxonomies still correctly fails here.
  const ungroundedTechnologies = [...claimed]
    .filter((skill) => !authoritative.has(skill))
    .filter((skill) => !isCapabilityGroundedForCandidate(skill, masterResumeProfile).supported)
    .sort();

  return { ungroundedTechnologies, insufficientProfileData: false };
}
