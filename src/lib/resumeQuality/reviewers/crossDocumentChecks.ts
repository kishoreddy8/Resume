import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";
import type { ComplianceStatus } from "../types";
import { extractCanonicalSkillsFromText } from "./skillAliases";

/**
 * CROSS-DOCUMENT CONSISTENCY LOCK — "a technology attributed to a project in the cover letter must
 * not contradict the resume" (canonicalInstructions.ts). Scoped deliberately to TECHNOLOGY claims,
 * not employer/company-name matching: a cover letter is SUPPOSED to name the target company (which
 * never appears in the resume's own employer list), so a naive "every company name in the cover
 * letter must also be in the resume" check would false-positive on every single cover letter. The
 * technology axis is the one the canonical rule can actually be checked against without that
 * confound — if the cover letter claims a specific technology as part of the candidate's experience,
 * that technology must be traceable somewhere in the resume itself.
 */

export interface CrossDocumentCheckResult {
  status: ComplianceStatus;
  contradictions: string[];
}

function resumeTechnologySet(resume: ResumeContent): Set<string> {
  const text = [...resume.summary, ...resume.skillGroups.flatMap((g) => g.items), ...resume.experience.flatMap((e) => e.bullets)].join("\n");
  return extractCanonicalSkillsFromText(text);
}

export function evaluateCrossDocumentConsistency(resume: ResumeContent, coverLetter: CoverLetterContent | undefined): CrossDocumentCheckResult {
  // No cover letter for this run at all -> nothing to be inconsistent WITH, so the guardrail is
  // vacuously satisfied, matching the canonical text's own scoping ("if other generated application
  // material exists, ensure consistency where supported") — absence of the artifact is not the same
  // as an unverified/ambiguous claim (contrast deepRewriteCheck.ts, where REVIEW is the deliberately
  // correct response to genuinely ambiguous evidence).
  if (!coverLetter) {
    return { status: "PASS", contradictions: [] };
  }

  const resumeSkills = resumeTechnologySet(resume);
  const coverLetterSkills = extractCanonicalSkillsFromText(coverLetter.paragraphs.join("\n"));

  const contradictions = [...coverLetterSkills]
    .filter((skill) => !resumeSkills.has(skill))
    .map((skill) => `Cover letter claims "${skill}" but this technology does not appear anywhere in the resume.`);

  return { status: contradictions.length > 0 ? "FAIL" : "PASS", contradictions };
}
