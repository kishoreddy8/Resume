import type { ResumeWriterOutput } from "./types";
import type { ResumeContent } from "../../../tools/tailoring-engine/types";

export const CURRENT_ROLE_BULLET_CAP = 8;
export const SECOND_ROLE_BULLET_CAP = 7;
export const OLDER_ROLE_BULLET_CAP = 6;
export const TOTAL_EXPERIENCE_BULLET_CAP = 21;
export const PROJECT_DESCRIPTION_MAX_SENTENCES = 2;
export const PROJECT_DESCRIPTION_MAX_TECHNOLOGIES = 4;
export const ENVIRONMENT_RECOMMENDED_MAX = 8;

export interface QualitySignal {
  dimension: "repeatedOpeningVerb" | "technologyDensity" | "environmentLength" | "summaryQuality" | "visibleSkillsRedundancy";
  severity: "WARNING" | "ADVISORY";
  description: string;
}

/** Writer-facing quality guidance for Phase 5. */
export function renderWriterOutputQualitySection(): string {
  return `## WRITER OUTPUT QUALITY & BULLET STANDARDS

**Summary standards (Iteration 1 publication quality).** The Professional Summary must be publication-ready on the first pass. Write 3-4 concise sentences: (1) Verified Professional Identity & target domain, (2) Core architecture ownership, (3) Concrete delivery impact, (4) Defining supported tools (max 7 total, max 4 per sentence). Do not use sentence fragments ("Design layered lakehouses...", "Work across Python..."). Write in polished executive resume register. Reject generic marketing fluff ("results-driven", "highly motivated", "seasoned professional", "proven track record"). Do not stack template stems ("Expertise spans...", "Proven ability to...", "Experienced in...").

**Experience bullets composition.** Communicate: Engineering Action + System/Architecture Context + Purpose/Outcome. Prefer 1 primary capability per bullet. Bullet caps: current role max ${CURRENT_ROLE_BULLET_CAP}, second role max ${SECOND_ROLE_BULLET_CAP}, older roles max ${OLDER_ROLE_BULLET_CAP} (total cap: ${TOTAL_EXPERIENCE_BULLET_CAP}) — ceilings, not targets: never pad to a cap. If a bullet is overloaded, split it only when each resulting bullet has its own evidenced accomplishment context. Otherwise simplify the original bullet. Vary opening action verbs across bullets (avoid repeating "Built", "Engineered", or "Implemented" 3+ times under the same role). Reject duplicate ideas, synonymous repeats, or redundant claims. Technologies should form coherent engineering pipelines (Source -> Ingestion -> Processing -> Storage/Warehouse -> Outcome); never stack competing un-migrated tools for keyword padding.

**Metric policy.** Use explicit verified metrics faithfully where present. Where no explicit metric exists, you MAY generate a conservative, defensible metric when existing CareerOps policy permits it, context supports it, and it strengthens the accomplishment. Never invent extreme scale or artificial precision, and reject fabricated metrics. Metrics are not mandatory in every bullet.

**Visible Skills & Environment.** Visible Technical Skills: target 15-22 distinct high-value skills; deduplicate obvious aliases (e.g. use Azure Data Factory, not both ADF and Azure Data Factory). Position technologies according to the Target Ecosystem Strategy and Approved Architecture Palettes. Keep Environment lines compact (target 5-8 defining technologies per employer; do not duplicate the entire skills section).

**Project Descriptions.** Exactly 1-2 concise sentences naming domain, business context, and architectural scope. Max ${PROJECT_DESCRIPTION_MAX_TECHNOLOGIES} named technologies.
`;
}

/**
 * Analyzes recruiter-facing quality signals (warnings/advisories, not hard blocking failures).
 */
export function analyzeRecruiterQualitySignals(resume: ResumeContent): QualitySignal[] {
  const signals: QualitySignal[] = [];

  // 1. Repeated opening verbs check per employer
  for (const exp of resume.experience) {
    const verbCounts = new Map<string, number>();
    for (const bullet of exp.bullets) {
      const firstWord = bullet.trim().split(/\s+/)[0]?.replace(/[^a-zA-Z]/g, "").toLowerCase();
      if (firstWord && firstWord.length > 2) {
        verbCounts.set(firstWord, (verbCounts.get(firstWord) || 0) + 1);
      }
    }

    for (const [verb, count] of verbCounts.entries()) {
      if (count >= 3) {
        signals.push({
          dimension: "repeatedOpeningVerb",
          severity: "WARNING",
          description: `At ${exp.company}, ${count} bullets start with the same verb ("${verb}") — consider varying action verbs for stronger recruiter engagement.`,
        });
      }
    }

    // 2. Environment line length check
    if (exp.environment && exp.environment.length > ENVIRONMENT_RECOMMENDED_MAX) {
      signals.push({
        dimension: "environmentLength",
        severity: "ADVISORY",
        description: `At ${exp.company}, Environment has ${exp.environment.length} items (recommended: 5-8) — consider keeping it focused on defining stack technologies.`,
      });
    }
  }

  // 3. Summary technology density check
  if (resume.summary && resume.summary.length > 0) {
    const summaryText = resume.summary.join(" ");
    const sentences = summaryText.split(/(?<=[.!?])\s+/);
    for (const [i, s] of sentences.entries()) {
      const words = s.split(/\s+/);
      if (words.length > 45) {
        signals.push({
          dimension: "summaryQuality",
          severity: "ADVISORY",
          description: `Summary sentence ${i + 1} is long (${words.length} words) — aim for concise, crisp sentences.`,
        });
      }
    }
  }

  return signals;
}

const NONSTANDARD_SPACES = /[\u00a0\u2007\u2028\u2029\u202f]/g;
const ZERO_WIDTH_SPACE = /\u200b/g;
const ZERO_WIDTH_JOINERS = /[\u200c\u200d\u2060\ufeff]/g;
const NONSTANDARD_HYPHENS = /[\u2010\u2011\u2012\ufe58\ufe63\uff0d]/g;

export function normalizeWriterPresentationText(value: string): string {
  return value
    .replace(NONSTANDARD_SPACES, " ")
    .replace(ZERO_WIDTH_SPACE, " ")
    .replace(ZERO_WIDTH_JOINERS, "")
    .replace(/â(?:€“|€”|€‘)/g, "-")
    .replace(NONSTANDARD_HYPHENS, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,;:.!?])/g, "$1")
    .replace(/,([^\s\d])/g, ", $1")
    .trim();
}

export function normalizeWriterLocation(value: string): string {
  return normalizeWriterPresentationText(value).replace(/,\s*/g, ", ");
}

function normalizeLines(value: string): string {
  return value
    .split(/\r?\n/)
    .map(normalizeWriterPresentationText)
    .join("\n");
}

/** Presentation-only normalization applied after every writer implementation, before rendering and
 * deterministic review. Hard facts (name, employer, title, dates, education, certifications, metrics)
 * are deliberately not rewritten. */
export function normalizeResumeWriterOutput(output: ResumeWriterOutput): ResumeWriterOutput {
  const resume = output.resume;
  return {
    ...output,
    resume: {
      ...resume,
      tagline: normalizeWriterPresentationText(resume.tagline),
      location: normalizeWriterLocation(resume.location),
      summary: resume.summary.map(normalizeWriterPresentationText),
      skillGroups: resume.skillGroups.map((group) => ({
        label: normalizeWriterPresentationText(group.label),
        items: group.items.map(normalizeWriterPresentationText),
      })),
      experience: resume.experience.map((role) => ({
        ...role,
        ...(role.location !== undefined ? { location: normalizeWriterLocation(role.location) } : {}),
        ...(role.projectDescription !== undefined
          ? { projectDescription: normalizeWriterPresentationText(role.projectDescription) }
          : {}),
        bullets: role.bullets.map(normalizeWriterPresentationText),
        ...(role.environment !== undefined
          ? { environment: role.environment.map(normalizeWriterPresentationText) }
          : {}),
      })),
      ...(resume.keyProjects !== undefined
        ? {
            keyProjects: resume.keyProjects.map((project) => ({
              ...project,
              name: normalizeWriterPresentationText(project.name),
              description: normalizeWriterPresentationText(project.description),
              ...(project.technologies !== undefined
                ? { technologies: project.technologies.map(normalizeWriterPresentationText) }
                : {}),
            })),
          }
        : {}),
    },
    ...(output.coverLetter
      ? {
          coverLetter: {
            ...output.coverLetter,
            location: normalizeWriterLocation(output.coverLetter.location),
            salutation: normalizeWriterPresentationText(output.coverLetter.salutation),
            paragraphs: output.coverLetter.paragraphs.map(normalizeWriterPresentationText),
            closing: normalizeLines(output.coverLetter.closing),
          },
        }
      : {}),
  };
}
