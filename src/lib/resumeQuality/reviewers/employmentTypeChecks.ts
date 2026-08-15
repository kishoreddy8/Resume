import type { CoverLetterContent, ExperienceEntry } from "../../../../tools/tailoring-engine/types";
import type { ComplianceStatus } from "../types";

/**
 * EMPLOYMENT-TYPE HANDLING — PRIVATE. The canonical instructions ban asserting direct employment
 * ("hired directly by", "employee of", "joined as a full-time employee") for a client engagement
 * "unless the Master Resume/source material explicitly supports it." CandidateProfile carries no
 * employment-type/staffing flag at all (Phase 2's data model has no such field — see
 * src/lib/match/types.ts's CandidateExperienceEntry), so there is no authoritative way to confirm
 * support for such a claim for ANY employer. The only safe, honest rule this reviewer can enforce
 * without that field is therefore: these phrases are never acceptable, for any employer, because
 * "explicitly supported by the Master Resume" can never be verified from the data available here —
 * flagging their presence is a real, provable check even without a staffing-type field; it is simply
 * scoped to "never assert what cannot be verified," not "detect exactly which employers are staffing
 * arrangements."
 */

const DIRECT_EMPLOYMENT_PHRASES = [
  /\bhired\s+directly\s+by\b/i,
  /\bdirect\s+(?:hire|employee)\s+(?:of|at)\b/i,
  /\bemployee\s+of\b/i,
  /\bjoined\s+(?:as\s+)?(?:a\s+)?full[\s-]?time\s+employee\b/i,
  /\bpermanent\s+employee\s+of\b/i,
];

export interface EmploymentTypeCheckResult {
  status: ComplianceStatus;
  flaggedPhrases: string[];
}

function scanText(text: string): string[] {
  const found: string[] = [];
  for (const re of DIRECT_EMPLOYMENT_PHRASES) {
    const match = re.exec(text);
    if (match) found.push(match[0]);
  }
  return found;
}

export function evaluateEmploymentTypeHandling(experience: ExperienceEntry[], coverLetter: CoverLetterContent | undefined): EmploymentTypeCheckResult {
  const flaggedPhrases: string[] = [];

  for (const role of experience) {
    for (const bullet of role.bullets) {
      flaggedPhrases.push(...scanText(bullet).map((p) => `${role.company}: "${p}"`));
    }
  }
  if (coverLetter) {
    for (const paragraph of coverLetter.paragraphs) {
      flaggedPhrases.push(...scanText(paragraph).map((p) => `Cover letter: "${p}"`));
    }
  }

  return { status: flaggedPhrases.length > 0 ? "FAIL" : "PASS", flaggedPhrases };
}
