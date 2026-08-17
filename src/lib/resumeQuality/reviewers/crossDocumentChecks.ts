import type { CoverLetterContent, ExperienceEntry, ResumeContent } from "../../../../tools/tailoring-engine/types";
import type { ComplianceStatus } from "../types";
import { extractCanonicalSkillsFromText } from "./skillAliases";

/**
 * CROSS-DOCUMENT CONSISTENCY LOCK — "a technology attributed to a project in the cover letter must
 * not contradict the resume" (canonicalInstructions.ts), extended by Stage 21 (Evidence-Grounded
 * Resume Quality V2) to catch the specific failure a real generated output exhibited: the cover
 * letter claimed "Snowflake + dbt at Comerica" and "Airflow at Fiserv" while the resume did not
 * support those claims AT THOSE EMPLOYERS — a defect the original resume-wide presence check could
 * not catch, since e.g. "dbt" mentioned anywhere on the resume (a different employer, or the generic
 * skills list) was enough to satisfy it even though the SPECIFIC employer attribution was fabricated.
 *
 * Two checks now run:
 *   1. EMPLOYER-SCOPED (new, precise): for any cover-letter sentence that names one of the resume's
 *      own employers AND a technology in the same sentence, that technology must be grounded in THAT
 *      employer's own resume bullets specifically — not merely present somewhere else on the resume.
 *   2. GENERAL (original, unchanged): every other cover-letter technology mention — not tied to a
 *      named employer in the same sentence — must still be traceable somewhere on the resume.
 * A cover letter naming the TARGET company (never one of the resume's own past employers) is
 * unaffected by check 1, since that name will never match an entry in resume.experience.
 */

export interface CrossDocumentCheckResult {
  status: ComplianceStatus;
  /** Merged view (employer-scoped + general) — unchanged shape, kept for existing consumers
   *  (instructionCompliance.ts's noContradictingTechnologies/crossDocumentConsistency checks). */
  contradictions: string[];
  /** A technology attributed to a NAMED resume employer in the same cover-letter sentence, but not
   *  grounded at that specific employer — Stage 21's EMPLOYER_CONTRADICTION taxonomy. */
  employerScopedContradictions: string[];
  /** A technology mentioned anywhere in the cover letter with no employer attribution, absent from
   *  the resume entirely — Stage 21's CROSS_ARTIFACT_CONTRADICTION taxonomy. */
  generalContradictions: string[];
}

function resumeTechnologySet(resume: ResumeContent): Set<string> {
  const text = [...resume.summary, ...resume.skillGroups.flatMap((g) => g.items), ...resume.experience.flatMap((e) => e.bullets)].join("\n");
  return extractCanonicalSkillsFromText(text);
}

function employerTechnologySet(entry: ExperienceEntry): Set<string> {
  return extractCanonicalSkillsFromText([entry.title, ...entry.bullets].join("\n"));
}

// Naive but adequate sentence splitter for this purpose: a false split mid-abbreviation only widens
// the window a technology/employer pair is searched within, which can only reduce false positives,
// never manufacture a false one (a real contradiction still requires both names to co-occur).
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

function normalizeForMatch(s: string): string {
  return s.trim().toLowerCase();
}

function sentenceMentionsEmployer(sentence: string, employerName: string): boolean {
  const a = normalizeForMatch(sentence);
  const b = normalizeForMatch(employerName);
  return b.length > 0 && a.includes(b);
}

function evaluateEmployerScopedContradictions(resume: ResumeContent, coverLetter: CoverLetterContent): string[] {
  const contradictions: string[] = [];
  const sentences = splitSentences(coverLetter.paragraphs.join(" "));

  for (const sentence of sentences) {
    for (const entry of resume.experience) {
      if (!sentenceMentionsEmployer(sentence, entry.company)) continue;
      const sentenceSkills = extractCanonicalSkillsFromText(sentence);
      if (sentenceSkills.size === 0) continue;
      const employerSkills = employerTechnologySet(entry);
      for (const skill of sentenceSkills) {
        if (!employerSkills.has(skill)) {
          contradictions.push(
            `Cover letter attributes "${skill}" to ${entry.company}, but the resume's ${entry.company} bullets do not support this — this technology is not evidenced at that specific employer.`
          );
        }
      }
    }
  }
  return contradictions;
}

export function evaluateCrossDocumentConsistency(resume: ResumeContent, coverLetter: CoverLetterContent | undefined): CrossDocumentCheckResult {
  // No cover letter for this run at all -> nothing to be inconsistent WITH, so the guardrail is
  // vacuously satisfied, matching the canonical text's own scoping ("if other generated application
  // material exists, ensure consistency where supported") — absence of the artifact is not the same
  // as an unverified/ambiguous claim (contrast deepRewriteCheck.ts, where REVIEW is the deliberately
  // correct response to genuinely ambiguous evidence).
  if (!coverLetter) {
    return { status: "PASS", contradictions: [], employerScopedContradictions: [], generalContradictions: [] };
  }

  const employerScopedContradictions = evaluateEmployerScopedContradictions(resume, coverLetter);

  const resumeSkills = resumeTechnologySet(resume);
  const coverLetterSkills = extractCanonicalSkillsFromText(coverLetter.paragraphs.join("\n"));
  const generalContradictions = [...coverLetterSkills]
    .filter((skill) => !resumeSkills.has(skill))
    .map((skill) => `Cover letter claims "${skill}" but this technology does not appear anywhere in the resume.`);

  const contradictions = [...employerScopedContradictions, ...generalContradictions];
  return { status: contradictions.length > 0 ? "FAIL" : "PASS", contradictions, employerScopedContradictions, generalContradictions };
}
