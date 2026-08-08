// Content contract for the resume/cover-letter rendering engine. The LLM (Claude Code, running
// the tailor-resume skill) decides everything about the CONTENT — what to rewrite, how to order
// bullets and skill groups by relevance to the JD — and hands the final result to this engine as
// plain data. The engine's only job is turning that data into correctly, consistently formatted
// ATS-safe .docx files. Keeping this split means a formatting fix never requires re-deciding
// content, and a content change never requires touching formatting code.

export interface ExperienceEntry {
  title: string;
  company: string;
  /** e.g. "Feb 2025 – Present" — pass through exactly as it should render. */
  dates: string;
  /** Already rewritten and ordered by relevance to the target JD, most relevant first. */
  bullets: string[];
}

export interface SkillGroup {
  label: string;
  /** Already ordered by relevance to the target JD within the group. */
  items: string[];
}

export interface ResumeContent {
  name: string;
  /** One-line title under the name, e.g. "Senior Data Engineer | ..." */
  tagline: string;
  location: string;
  phone: string;
  email: string;
  linkedin?: string;
  /** Each string is one summary paragraph/sentence-cluster, rendered as its own paragraph. */
  summary: string[];
  /** Groups already ordered by relevance to the target JD, most relevant first. */
  skillGroups: SkillGroup[];
  certifications?: string[];
  /** Already ordered — current/most relevant role first, matching the source resume's ordering intent. */
  experience: ExperienceEntry[];
  education: string[];
}

export interface CoverLetterContent {
  name: string;
  location: string;
  phone: string;
  email: string;
  linkedin?: string;
  salutation: string;
  /** Each string is one paragraph. */
  paragraphs: string[];
  closing: string;
}
