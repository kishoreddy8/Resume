// Content contract for the resume/cover-letter rendering engine. The LLM (Claude Code, running
// the tailor-resume skill) decides everything about the CONTENT — what to rewrite, how to order
// bullets and skill groups by relevance to the JD — and hands the final result to this engine as
// plain data. The engine's only job is turning that data into correctly, consistently formatted
// ATS-safe .docx files. Keeping this split means a formatting fix never requires re-deciding
// content, and a content change never requires touching formatting code.

export interface ExperienceEntry {
  title: string;
  company: string;
  /** Stage 31 — "Dallas, TX" style employer location, rendered after the company name.
   *  OPTIONAL and never inferred: CandidateProfile records no employer locations, so on a profile
   *  that does not state one this stays undefined and the company line simply renders without it,
   *  rather than the renderer or the writer guessing a city. */
  location?: string;
  /** e.g. "Feb 2025 – Present" — pass through exactly as it should render. */
  dates: string;
  /**
   * Stage 31 — the reference resume's `Project:` line: one sentence naming what this role's work
   * WAS, so a reader knows the scope before reading the bullets.
   *
   * This is a restatement, never an addition. It may only describe systems, domains and
   * technologies this same role's own bullets already establish; it may not introduce a new
   * employer, system, client, domain or metric. checkPresentationAttribution() in
   * src/lib/resumeQuality/reviewers/truthfulnessChecks.ts enforces exactly that, so a writer
   * cannot smuggle an unevidenced claim in through this field.
   */
  projectDescription?: string;
  /** Already rewritten and ordered by relevance to the target JD, most relevant first. */
  bullets: string[];
  /**
   * Stage 31 — the reference resume's `Environment:` line: the technology stack of THIS role.
   *
   * Employer-scoped, not global. A technology the candidate genuinely knows but used at a
   * different employer may not appear here (see employerEvidence.ts's supported /
   * notEvidencedHere split), which is the multi-project attribution rule the reference format
   * makes it very easy to violate.
   */
  environment?: string[];
}

/**
 * Stage 31 — the reference resume's KEY PROJECTS section.
 *
 * Optional in every sense: CandidateProfile has no projects field at all, so for a candidate with
 * no recorded project evidence this stays undefined and the section is omitted entirely. An empty
 * section is correct; an invented one is not.
 */
export interface KeyProject {
  name: string;
  description: string;
  /** Rendered in parentheses after the description, as the reference does. */
  technologies?: string[];
  /** A real repository/demo URL if — and only if — the Master Resume records one. */
  url?: string;
}

export interface SkillGroup {
  label: string;
  /** Already ordered by relevance to the target JD within the group. */
  items: string[];
}

export interface ResumeContent {
  name: string;
  /** One-line headline under the name, e.g. "Data Engineer | Azure Data Platform | Databricks".
   *  Must lead with the candidate's own professional identity — see professionalIdentity.ts. */
  tagline: string;
  location: string;
  phone: string;
  email: string;
  linkedin?: string;
  /** Optional. Rendered in the header beside LinkedIn only when supplied. */
  github?: string;
  /** Each string is one summary paragraph/sentence-cluster, rendered as its own paragraph. */
  summary: string[];
  /** Groups already ordered by relevance to the target JD, most relevant first. */
  skillGroups: SkillGroup[];
  certifications?: string[];
  /** Already ordered — current/most relevant role first, matching the source resume's ordering intent. */
  experience: ExperienceEntry[];
  /** Stage 31 — rendered between Professional Experience and Education when present, omitted
   *  entirely when the candidate has no recorded project evidence. */
  keyProjects?: KeyProject[];
  /**
   * One string per entry. Deliberately still strings and not a structured record: the truthfulness
   * reviewer verifies these lines against the Master Resume as text
   * (truthfulnessChecks.ts's checkEducationAndCertifications), and splitting them into fields
   * would have moved that verification onto a second, unreviewed representation of the same fact.
   *
   * The renderer lays each line out in the reference's two-line shape by PARSING the conventional
   * "<Degree>, <Institution> — <Dates>" form (see splitEducationLine in resume-template.ts). A
   * line it cannot parse confidently renders whole, on one line — never truncated or rearranged.
   */
  education: string[];
}

export interface CoverLetterContent {
  name: string;
  location: string;
  phone: string;
  email: string;
  linkedin?: string;
  /** Optional. Rendered in the header beside LinkedIn only when supplied. */
  github?: string;
  salutation: string;
  /** Each string is one paragraph. */
  paragraphs: string[];
  closing: string;
}
