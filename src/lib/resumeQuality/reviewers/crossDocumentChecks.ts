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
 *   1. EMPLOYER-SCOPED: for any cover-letter clause that names one of the resume's own employers AND
 *      a technology, that technology must be grounded in THAT employer's own resume bullets — not
 *      merely present somewhere else on the resume. Multiple employer clauses in one sentence stay
 *      separate, so a later employer's stack is not attributed backward to an earlier employer.
 *   2. GENERAL: positive candidate technology claims must still be traceable somewhere on the
 *      resume. Negated comparisons and target-role/team noun phrases are context, not claims.
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

// Naive but adequate sentence splitter for this purpose: a false split mid-abbreviation only widens
// the window a technology/employer pair is searched within, which can only reduce false positives,
// never manufacture a false one (a real contradiction still requires both names to co-occur).
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

function targetContextMasked(text: string): string {
  // These are noun phrases naming the opportunity, not assertions about the candidate. Keep the
  // rule syntactic and bounded: only a determiner-led phrase ending in an explicit opportunity noun
  // is masked. "I used AWS" and similar candidate-assertive sentences remain fully visible.
  return text.replace(
    /\b(?:the|this|your|their|target)\s+(?:(?!(?:team|role|position|opening|job|posting)\b)[a-z0-9&/+.'-]+\s+){0,8}(?:team|role|position|opening|job|posting)\b/gi,
    " "
  );
}

function isJobContextOnly(text: string): boolean {
  return /\b(?:job description|job posting|posting|role|position|requirement)\b[^.!?]*\b(?:requires?|calls?\s+for|lists?|mentions?|seeks?|asks?\s+for)\b/i.test(
    text
  );
}

function negatedTechnologySet(text: string): Set<string> {
  const negated = new Set<string>();
  const marker = /\b(?:not|without|rather\s+than|instead\s+of)\b/gi;
  let match: RegExpExecArray | null;

  while ((match = marker.exec(text)) !== null) {
    const tail = text.slice(match.index + match[0].length);
    if (/^\s+only\b/i.test(tail)) continue;
    const boundary = tail.search(/[,;:.!?]|\b(?:but|yet|while|whereas)\b/i);
    const negatedObject = boundary >= 0 ? tail.slice(0, boundary) : tail;
    for (const skill of extractCanonicalSkillsFromText(negatedObject)) negated.add(skill);
  }
  return negated;
}

function positiveTechnologySet(text: string): Set<string> {
  if (isJobContextOnly(text)) return new Set();
  const claimText = targetContextMasked(text);
  const skills = extractCanonicalSkillsFromText(claimText);
  for (const negated of negatedTechnologySet(claimText)) skills.delete(negated);
  return skills;
}

function positiveTechnologySetAcrossSentences(text: string): Set<string> {
  const skills = new Set<string>();
  for (const sentence of splitSentences(text)) {
    for (const skill of positiveTechnologySet(sentence)) skills.add(skill);
  }
  return skills;
}

function evidenceSupportsSkill(skill: string, evidenceSkills: Set<string>, evidenceText: string): boolean {
  if (evidenceSkills.has(skill)) return true;
  if (skill !== "Azure") return false;

  // The shared taxonomy deliberately gives named Azure services their own canonical entries. Those
  // entries are stronger evidence for the generic Azure parent, not equivalents of one another.
  // ADLS Gen2 is explicitly documented there as Azure storage; Azure Databricks canonicalizes to
  // Databricks, so retain the brand check against the employer text for that one spelling.
  return (
    [...evidenceSkills].some((evidenced) => evidenced.startsWith("Azure ") || evidenced === "ADLS Gen2") ||
    /\bazure\s+databricks\b/i.test(evidenceText)
  );
}

interface EmployerEvidence {
  company: string;
  text: string;
  skills: Set<string>;
}

interface EmployerMention {
  evidence: EmployerEvidence;
  start: number;
  end: number;
}

function employerEvidenceByCompany(experience: ExperienceEntry[]): EmployerEvidence[] {
  const grouped = new Map<string, { company: string; entries: ExperienceEntry[] }>();
  for (const entry of experience) {
    const key = entry.company.trim().toLowerCase();
    if (!key) continue;
    const current = grouped.get(key);
    if (current) current.entries.push(entry);
    else grouped.set(key, { company: entry.company, entries: [entry] });
  }

  return [...grouped.values()].map(({ company, entries }) => {
    const text = entries.flatMap((entry) => [entry.title, ...entry.bullets]).join("\n");
    return { company, text, skills: extractCanonicalSkillsFromText(text) };
  });
}

function employerMentions(sentence: string, employers: EmployerEvidence[]): EmployerMention[] {
  const normalizedSentence = sentence.toLowerCase();
  const mentions: EmployerMention[] = [];

  for (const evidence of employers) {
    const employerName = evidence.company.trim().toLowerCase();
    let from = 0;
    while (employerName && from < normalizedSentence.length) {
      const start = normalizedSentence.indexOf(employerName, from);
      if (start < 0) break;
      mentions.push({ evidence, start, end: start + employerName.length });
      from = start + employerName.length;
    }
  }

  return mentions.sort((a, b) => a.start - b.start || b.end - a.end);
}

function employerSwitchBoundary(sentence: string, priorMentionEnd: number, nextMentionStart: number): number {
  const between = sentence.slice(priorMentionEnd, nextMentionStart);
  let boundary = Math.max(between.lastIndexOf(";"), between.lastIndexOf(","));
  const connector = /\b(?:and|while|whereas|earlier|previously|formerly)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = connector.exec(between)) !== null) boundary = Math.max(boundary, match.index);
  return boundary >= 0 ? priorMentionEnd + boundary : nextMentionStart;
}

function evaluateEmployerScopedContradictions(resume: ResumeContent, coverLetter: CoverLetterContent): string[] {
  const contradictions = new Set<string>();
  const sentences = splitSentences(coverLetter.paragraphs.join(" "));
  const employers = employerEvidenceByCompany(resume.experience);

  for (const sentence of sentences) {
    const mentions = employerMentions(sentence, employers);
    for (let index = 0; index < mentions.length; index += 1) {
      const mention = mentions[index];
      const start = index === 0 ? 0 : employerSwitchBoundary(sentence, mentions[index - 1].end, mention.start);
      const end = index === mentions.length - 1 ? sentence.length : employerSwitchBoundary(sentence, mention.end, mentions[index + 1].start);
      const clauseSkills = positiveTechnologySet(sentence.slice(start, end));

      for (const skill of clauseSkills) {
        if (!evidenceSupportsSkill(skill, mention.evidence.skills, mention.evidence.text)) {
          contradictions.add(
            `Cover letter attributes "${skill}" to ${mention.evidence.company}, but the resume's ${mention.evidence.company} bullets do not support this — this technology is not evidenced at that specific employer.`
          );
        }
      }
    }
  }
  return [...contradictions];
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
  const resumeText = [...resume.summary, ...resume.skillGroups.flatMap((g) => g.items), ...resume.experience.flatMap((e) => e.bullets)].join("\n");
  const coverLetterSkills = positiveTechnologySetAcrossSentences(coverLetter.paragraphs.join("\n"));
  const generalContradictions = [...coverLetterSkills]
    .filter((skill) => !evidenceSupportsSkill(skill, resumeSkills, resumeText))
    .map((skill) => `Cover letter claims "${skill}" but this technology does not appear anywhere in the resume.`);

  const contradictions = [...employerScopedContradictions, ...generalContradictions];
  return { status: contradictions.length > 0 ? "FAIL" : "PASS", contradictions, employerScopedContradictions, generalContradictions };
}
