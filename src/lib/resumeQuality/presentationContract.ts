import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import { extractCanonicalSkillsFromText } from "./reviewers/skillAliases";
import { normalizeRoleTitle } from "./professionalIdentity";
import { SUMMARY_MAX_TECHNOLOGIES, dynamicSummaryTechnologyCeiling } from "./summaryTechnologyBudget";
import type { CoverLetterContent, ResumeContent } from "../../../tools/tailoring-engine/types";

// PHASE 6.5 — re-exported for backward compatibility: both were originally defined here, and moved
// to summaryTechnologyBudget.ts to break a circular import with professionalIdentity.ts (which also
// needs the dynamic ceiling, and this file already imports normalizeRoleTitle FROM
// professionalIdentity.ts). Every existing importer of these two names from this file is unaffected.
export { SUMMARY_MAX_TECHNOLOGIES, dynamicSummaryTechnologyCeiling };

/**
 * Stage 31.1 — the resume presentation contract.
 *
 * Everything here is a deterministic, pure check on already-generated content: no database, no
 * filesystem, no AI. These are WRITING and PRESENTATION rules — none of them is a truthfulness
 * finding, and none of them changes Stage 21, the quality gate, or any disposition semantics. They
 * cost formatting score and produce concrete corrections, which is the lever that changes what the
 * writer produces next.
 */

export type ContractIssueKind =
  | "HEADLINE_CONTAINS_TECHNOLOGY"
  | "HEADLINE_TOO_MANY_SEGMENTS"
  | "HEADLINE_ROLE_NOT_EVIDENCED"
  | "SUMMARY_SENTENCE_COUNT"
  | "SUMMARY_TECHNOLOGY_DUMP"
  | "SUMMARY_FORMULAIC"
  | "SUMMARY_TOO_LONG"
  | "AI_DASH_PUNCTUATION"
  | "SKILLS_JD_ONLY";

export interface ContractIssue {
  kind: ContractIssueKind;
  severity: "HIGH" | "MEDIUM" | "LOW";
  message: string;
}

// -----------------------------------------------------------------------------------------------
// Headline — role identities only
// -----------------------------------------------------------------------------------------------

/** Words that make a headline segment a ROLE rather than a domain or a technology. */
const ROLE_NOUNS = /\b(engineer|developer|analyst|scientist|architect|consultant|specialist|administrator|manager|lead)\b/i;

export const MAX_HEADLINE_SEGMENTS = 3;

export function splitHeadline(headline: string): string[] {
  return headline
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The line under the name names WHO THE CANDIDATE IS — one to three evidence-backed professional
 * role identities. It is not a place for a technology stack: "Data Engineer | Cloud Data Ingestion
 * & Distributed Batch Processing | Spark, PySpark, Python, Azure Databricks, Delta Lake, Snowflake"
 * says less about the candidate than "Data Engineer | AI Engineer" does, and buries the identity a
 * recruiter is scanning for under a keyword list that the Technical Skills section already carries.
 *
 * A role is "evidenced" when it matches a title the candidate actually held, compared on the
 * normalised title so seniority and level markers never decide the question. A JD's own title can
 * therefore influence WHICH evidenced identity leads, but can never introduce one.
 */
export function checkHeadline(headline: string, profile: CandidateProfile | undefined): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const segments = splitHeadline(headline);
  if (segments.length === 0) return issues;

  const technologies = [...extractCanonicalSkillsFromText(headline)];
  if (technologies.length > 0) {
    issues.push({
      kind: "HEADLINE_CONTAINS_TECHNOLOGY",
      severity: "HIGH",
      message:
        `The headline names technologies (${technologies.join(", ")}). The line under the candidate's name must ` +
        `carry professional ROLE IDENTITIES only — for example "Data Engineer | AI Engineer". Technologies belong ` +
        `in Technical Skills and in each role's Environment line, not here.`,
    });
  }

  if (segments.length > MAX_HEADLINE_SEGMENTS) {
    issues.push({
      kind: "HEADLINE_TOO_MANY_SEGMENTS",
      severity: "MEDIUM",
      message:
        `The headline has ${segments.length} segments. Use at most ${MAX_HEADLINE_SEGMENTS} evidence-backed role ` +
        `identities so the line stays scannable.`,
    });
  }

  if (profile) {
    const evidenced = new Set(
      profile.experience
        .map((e) => normalizeRoleTitle(e.title ?? "").toLowerCase())
        .filter((t) => t.length > 0)
    );
    for (const segment of segments) {
      if (!ROLE_NOUNS.test(segment)) continue; // not a role claim; the technology rule already covers it
      const normalized = normalizeRoleTitle(segment).toLowerCase();
      const supported = [...evidenced].some((title) => title === normalized || title.includes(normalized) || normalized.includes(title));
      if (supported) continue;
      issues.push({
        kind: "HEADLINE_ROLE_NOT_EVIDENCED",
        severity: "HIGH",
        message:
          `The headline claims the role identity "${segment}", which matches none of the titles the candidate has ` +
          `actually held (${profile.experience.map((e) => e.title).join("; ")}). A job description mentioning a role ` +
          `is not evidence that the candidate holds it.`,
      });
    }
  }

  return issues;
}

// -----------------------------------------------------------------------------------------------
// Summary — voice and shape
// -----------------------------------------------------------------------------------------------

/**
 * Stage 31.1, fourth pass — first-person pronouns are ALLOWED.
 *
 * An earlier pass prohibited "I / me / my / mine / we / our" outright, on the ordinary resume
 * convention that a summary carries no pronouns. The candidate has since specified the register
 * they want, twice and verbatim, and it closes in the first person: "My dual expertise in both the
 * engineering and infrastructural realms of data means that I don't just patch together solutions;
 * I craft pipelines that are as strategic as they are systematic." That is a deliberate voice
 * choice for the differentiating sentence, not an error, and it is theirs to make about their own
 * resume. The check is removed rather than softened, so nothing silently re-flags it later.
 *
 * The THIRD-PERSON narration rule is unaffected and still enforced (see findThirdPersonNarration):
 * "Owns ETL delivery…" reads as someone else describing the candidate, which is a different defect
 * from the candidate speaking as themselves.
 */

export const SUMMARY_MIN_SENTENCES = 3;
export const SUMMARY_MAX_SENTENCES = 4;

export function countSentences(text: string): number {
  return text
    .split(/[.!?]+(?:\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

export function checkSummaryShape(summaryParagraphs: string[]): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const joined = summaryParagraphs.map((s) => s.trim()).filter((s) => s.length > 0).join(" ");
  if (joined.length === 0) return issues;

  const sentences = countSentences(joined);
  if (sentences < SUMMARY_MIN_SENTENCES || sentences > SUMMARY_MAX_SENTENCES) {
    issues.push({
      kind: "SUMMARY_SENTENCE_COUNT",
      severity: "LOW",
      message:
        `The summary has ${sentences} sentence(s). Aim for ${SUMMARY_MIN_SENTENCES}-${SUMMARY_MAX_SENTENCES} strong ` +
        `sentences in ONE paragraph: professional identity, core competencies, the strongest evidence-backed result ` +
        `where one exists, and the JD's domain language.`,
    });
  }

  return issues;
}

// -----------------------------------------------------------------------------------------------
// Em/en dash prose punctuation
// -----------------------------------------------------------------------------------------------

const EM_DASH = "—";
const EN_DASH = "–";

/**
 * A date range is the ONE legitimate use of an en dash in these documents ("Feb 2025 – Present",
 * "Jan 2022 – May 2023"), so it is exempted rather than the whole field being skipped — an em dash
 * in a role's date field would still be wrong, and prose smuggled into a date field is still prose.
 */
const DATE_RANGE_EN_DASH = /(\d{4}|present)\s*–\s*(\w)/i;

/**
 * Education lines carry ONE structural dash by convention — "<Degree>, <Institution> - <Dates>" —
 * which splitEducationLine() consumes to lay the entry out over two lines. That separator is
 * layout, not prose, so it is normalised away before the prose scan; a SECOND dash in the same
 * line is still prose and is still reported.
 */
const EDUCATION_SEPARATOR = /\s+[—–]\s+/;

function dashIssuesIn(label: string, text: string, allowDateRange: boolean): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (text.includes(EM_DASH)) {
    issues.push({
      kind: "AI_DASH_PUNCTUATION",
      severity: "MEDIUM",
      message:
        `${label} contains an em dash (—). Use ordinary punctuation instead: a comma, semicolon, colon, full stop, ` +
        `or parentheses. Example: "Built scalable pipelines, improving processing reliability."`,
    });
  }
  if (text.includes(EN_DASH)) {
    const onlyDateRange = allowDateRange && text.replace(DATE_RANGE_EN_DASH, "$1-$2").indexOf(EN_DASH) === -1;
    if (!onlyDateRange) {
      issues.push({
        kind: "AI_DASH_PUNCTUATION",
        severity: "MEDIUM",
        message:
          `${label} contains an en dash (–) used as prose punctuation. Use a comma, semicolon, colon, full stop, or ` +
          `parentheses instead. Ordinary hyphens inside terms such as "end-to-end" or "real-time" remain correct.`,
      });
    }
  }
  return issues;
}

/**
 * Scans every piece of PROSE in both documents. Hyphens (U+002D) are never touched: "end-to-end",
 * "real-time" and "cloud-native" are correct English and correct technical usage.
 */
export function findAiDashPunctuation(resume: ResumeContent, coverLetter?: CoverLetterContent): ContractIssue[] {
  const issues: ContractIssue[] = [];
  issues.push(...dashIssuesIn("The headline", resume.tagline, false));
  resume.summary.forEach((s, i) => issues.push(...dashIssuesIn(`Summary sentence group ${i + 1}`, s, false)));
  for (const group of resume.skillGroups) {
    issues.push(...dashIssuesIn(`Skill group "${group.label}"`, [group.label, ...group.items].join(", "), false));
  }
  for (const role of resume.experience) {
    if (role.projectDescription) issues.push(...dashIssuesIn(`${role.company}'s Project line`, role.projectDescription, false));
    role.bullets.forEach((b, i) => issues.push(...dashIssuesIn(`${role.company} bullet ${i + 1}`, b, false)));
    if (role.environment) issues.push(...dashIssuesIn(`${role.company}'s Environment line`, role.environment.join(", "), false));
    issues.push(...dashIssuesIn(`${role.company}'s dates`, role.dates, true));
  }
  resume.education.forEach((e, i) =>
    issues.push(...dashIssuesIn(`Education entry ${i + 1}`, e.replace(EDUCATION_SEPARATOR, " - "), true))
  );
  for (const project of resume.keyProjects ?? []) {
    issues.push(...dashIssuesIn(`Key project "${project.name}"`, project.description, false));
  }
  if (coverLetter) {
    issues.push(...dashIssuesIn("The cover letter salutation", coverLetter.salutation, false));
    coverLetter.paragraphs.forEach((p, i) => issues.push(...dashIssuesIn(`Cover letter paragraph ${i + 1}`, p, false)));
    issues.push(...dashIssuesIn("The cover letter closing", coverLetter.closing, false));
  }
  return issues;
}

// -----------------------------------------------------------------------------------------------
// Technical Skills breadth
// -----------------------------------------------------------------------------------------------

/**
 * The Technical Skills section must show a credible ECOSYSTEM for the candidate's domain, not a
 * transcription of the job description. The JD decides ORDER; the candidate's evidence decides
 * membership.
 *
 * The check is one-directional on purpose: it flags a section that has collapsed to JD-only, and
 * says nothing about which extra technologies were chosen. Deciding that is the writer's job with
 * the evidence in front of it, and a checker that second-guessed the selection would be inventing a
 * relevance judgement it has no basis for.
 */
export function checkSkillsBreadth(
  resume: ResumeContent,
  jobRequirements: RequirementUnit[] | undefined
): ContractIssue[] {
  if (!jobRequirements || jobRequirements.length === 0) return [];
  const listed = resume.skillGroups.flatMap((g) => g.items.map((i) => i.trim().toLowerCase())).filter((i) => i.length > 0);
  if (listed.length === 0) return [];

  const jdSkills = new Set(
    jobRequirements.flatMap((u) => u.memberSkillNames).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)
  );
  if (jdSkills.size === 0) return [];

  const beyondJd = listed.filter((skill) => !jdSkills.has(skill));
  if (beyondJd.length > 0) return [];

  return [
    {
      kind: "SKILLS_JD_ONLY",
      severity: "MEDIUM",
      message:
        `Every one of the ${listed.length} technologies in Technical Skills also appears in the job description. The ` +
        `section reads as a transcription of the posting rather than as this candidate's technical ecosystem. Keep the ` +
        `JD-required skills first, then add the other evidence-backed technologies from the same domain that the ` +
        `Master Skills Inventory supports.`,
    },
  ];
}


// -----------------------------------------------------------------------------------------------
// Summary quality — the difference between a professional summary and a prose skills section
// -----------------------------------------------------------------------------------------------

/**
 * Stage 31.1 correction, second pass.
 *
 * The first pass banned third-person narration and handed the writer a menu of approved openings
 * ("Experienced in…", "Hands-on experience with…", "Skilled in…"). The writer did exactly as told
 * and opened EVERY sentence with one, producing a summary that was mechanically uniform and, worse,
 * a list of thirteen product names spread across four sentences — the Technical Skills section
 * rewritten as prose. Prohibiting one bad register without describing the good one just replaced a
 * bad pattern with a rigid one.
 *
 * These three checks constrain what a summary must NOT be, leaving the writer free to compose real
 * sentences: a summary is positioning, not inventory.
 */

/** Openings that are fine once, mechanical when stacked. */
const CAPABILITY_STEMS = [
  /^specializ(?:ing|es)\b/i,
  /^experienced\b/i,
  /^expertise\b/i,
  /^hands-on\b/i,
  /^proven\b/i,
  /^skilled\b/i,
  /^brings\b/i,
  /^background\b/i,
  /^adept\b/i,
  /^strong\b/i,
];

/** Above this the paragraph stops fitting the layout comfortably. Raised in Stage 31.1's third pass:
 *  a richly-written 650-700 character summary is a good summary, and the real length problem was a
 *  795-character technology list, not prose. */
export const SUMMARY_MAX_CHARS = 720;
/** ...and within any single sentence. */
export const SUMMARY_MAX_TECHNOLOGIES_PER_SENTENCE = 4;
/** Sentences that may open with a capability stem before the paragraph reads as a template. */
export const SUMMARY_MAX_STEM_OPENINGS = 2;

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * @param technologyCeiling PHASE 6.5 — the dynamic ceiling (see dynamicSummaryTechnologyCeiling)
 *   when the caller has canonical-reconciliation data available. Defaults to the fixed
 *   SUMMARY_MAX_TECHNOLOGIES for any caller that doesn't pass one — fully backward compatible.
 */
export function checkSummaryQuality(summaryParagraphs: string[], technologyCeiling: number = SUMMARY_MAX_TECHNOLOGIES): ContractIssue[] {
  const joined = summaryParagraphs.map((s) => s.trim()).filter((s) => s.length > 0).join(" ");
  if (joined.length === 0) return [];
  const issues: ContractIssue[] = [];
  const sentences = splitSentences(joined);

  if (joined.length > SUMMARY_MAX_CHARS) {
    issues.push({
      kind: "SUMMARY_TOO_LONG",
      severity: "MEDIUM",
      message:
        `The summary is ${joined.length} characters, roughly ${Math.round(joined.length / 105)} rendered lines. Keep it to ` +
        `about ${SUMMARY_MAX_CHARS} characters (3-5 lines) so a recruiter reads it before deciding whether to keep going. ` +
        `Cut the technology lists first, not the substance.`,
    });
  }

  const total = extractCanonicalSkillsFromText(joined);
  if (total.size > technologyCeiling) {
    issues.push({
      kind: "SUMMARY_TECHNOLOGY_DUMP",
      severity: "HIGH",
      message:
        `The summary names ${total.size} distinct technologies (${[...total].slice(0, 10).join(", ")}…). A professional ` +
        `summary is POSITIONING, not inventory: name at most ${technologyCeiling} that genuinely define the ` +
        `candidate, and let Technical Skills and the Environment lines carry the rest. Say what the candidate builds, ` +
        `at what scale, in what domain, and what it achieved.`,
    });
  }
  for (const [index, sentence] of sentences.entries()) {
    const perSentence = extractCanonicalSkillsFromText(sentence);
    if (perSentence.size <= SUMMARY_MAX_TECHNOLOGIES_PER_SENTENCE) continue;
    issues.push({
      kind: "SUMMARY_TECHNOLOGY_DUMP",
      severity: "HIGH",
      message:
        `Summary sentence ${index + 1} names ${perSentence.size} technologies and reads as a list rather than a ` +
        `statement. Rewrite it to say something about the work, keeping at most ` +
        `${SUMMARY_MAX_TECHNOLOGIES_PER_SENTENCE} technology names.`,
    });
  }

  const stemOpenings = sentences.filter((s) => CAPABILITY_STEMS.some((stem) => stem.test(s.replace(/^[A-Z][a-z]+ Engineer\s+/, "")) || stem.test(s)));
  if (stemOpenings.length > SUMMARY_MAX_STEM_OPENINGS) {
    issues.push({
      kind: "SUMMARY_FORMULAIC",
      severity: "HIGH",
      message:
        `${stemOpenings.length} of ${sentences.length} summary sentences open with a capability stem ` +
        `("${stemOpenings.map((s) => s.split(" ").slice(0, 2).join(" ")).join('", "')}"), which reads as a filled-in ` +
        `template rather than as writing. Vary the construction: lead a sentence with the work itself, or with its ` +
        `result, instead of another stem.`,
    });
  }

  return issues;
}

/** Every contract check in one call, for the reviewer. */
export function evaluatePresentationContract(input: {
  resume: ResumeContent;
  coverLetter?: CoverLetterContent;
  masterResumeProfile?: CandidateProfile;
  jobRequirements?: RequirementUnit[];
  /** PHASE 6.5 — count of significant SUPPORTED canonical requirements (technologies AND
   *  capabilities) after Phase 6.2 reconciliation, when the caller has it. Drives
   *  dynamicSummaryTechnologyCeiling instead of the fixed SUMMARY_MAX_TECHNOLOGIES. Omitted
   *  (undefined) falls back to the fixed ceiling exactly as before — no existing caller is affected. */
  significantSupportedTechnologyCount?: number;
}): ContractIssue[] {
  const technologyCeiling =
    input.significantSupportedTechnologyCount === undefined
      ? SUMMARY_MAX_TECHNOLOGIES
      : dynamicSummaryTechnologyCeiling(input.significantSupportedTechnologyCount);
  return [
    ...checkHeadline(input.resume.tagline, input.masterResumeProfile),
    ...checkSummaryShape(input.resume.summary),
    ...checkSummaryQuality(input.resume.summary, technologyCeiling),
    ...findAiDashPunctuation(input.resume, input.coverLetter),
    ...checkSkillsBreadth(input.resume, input.jobRequirements),
  ];
}
