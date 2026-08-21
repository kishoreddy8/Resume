import type { ResumeWriterOutput } from "./types";

export const CURRENT_ROLE_BULLET_CAP = 7;
export const SECOND_ROLE_BULLET_CAP = 6;
export const OLDER_ROLE_BULLET_CAP = 5;
export const TOTAL_EXPERIENCE_BULLET_CAP = 18;
export const PROJECT_DESCRIPTION_MAX_SENTENCES = 2;
export const PROJECT_DESCRIPTION_MAX_TECHNOLOGIES = 4;

/** Writer-facing quality guidance. Evidence still decides membership; this section only controls
 * selection, emphasis, and readable decomposition of already-supported material. */
export function renderWriterOutputQualitySection(): string {
  return `## WRITER OUTPUT QUALITY — JD TARGETING WITHOUT EVIDENCE DRIFT

**Professional Summary.** Write one paragraph of 3-4 concise sentences: (1) the candidate's real role
identity, (2) the strongest evidence-backed platform/domain for this JD, (3) core engineering strengths,
and (4) concrete delivery context. Vary sentence construction. Do not stack template stems such as
"Data Engineer specializing...", "Expertise spans...", or "Proven ability...". Keep the closing sentence
professional and factual, not conversational or promotional. Avoid passionate, results-driven, seasoned,
dynamic, and other vague marketing language.

**Project descriptions.** Use one sentence, or two short sentences only when one would be hard to scan.
State the platform/system and business or data purpose, naming at most ${PROJECT_DESCRIPTION_MAX_TECHNOLOGIES}
defining technologies. Detailed tools belong in bullets and Environment; Project is never a technology inventory.

**Bullets and limited expansion.** Current role: at most ${CURRENT_ROLE_BULLET_CAP}; second role: at most
${SECOND_ROLE_BULLET_CAP}; older roles: at most ${OLDER_ROLE_BULLET_CAP} each; at most
${TOTAL_EXPERIENCE_BULLET_CAP} experience bullets total. These are ceilings, not targets: never pad to a cap.
Add a bullet only when ALL are true: it is JD-relevant; the Master Resume or MSI policy permits it at that
employer; it adds a distinct capability not already represented; separating it improves readability; and the
role and total caps still hold. For every added bullet, record the employer and exact evidence source in
writerValidation.notes. If evidence cannot support an employer attribution, do not create the bullet.

Prefer one primary capability per bullet. When a sentence mixes ingestion, transformation, security,
governance, CI/CD, and reporting, split it only when each resulting bullet has its own employer-scoped evidence
and distinct responsibility. Otherwise simplify the original bullet. Reject duplicate ideas, synonymous repeats,
keyword stuffing, fabricated metrics, and repeated environment-list content.

**JD-driven skill order.** The recommended skill order below is evidence-only. Move the group containing the
strongest supported JD skills earlier, and reorder items within each group so supported P1/P2 skills lead.
Retain useful supported depth later; never add an unsupported JD term. For an AWS-heavy JD, supported AWS skills
may rise above less-relevant Azure skills, and vice versa for an Azure-heavy JD. Never rewrite an Azure employer
claim as AWS (or the reverse) unless that same employer's evidence permits it. Inventory-only knowledge may be
shown only where the existing MSI evidence policy permits it; it is not employer evidence by itself.

**Text cleanup.** Use ordinary ATS-safe text: "Dallas, TX" comma spacing, normal spaces, standard ASCII hyphens
inside compounds, and clean punctuation. Remove zero-width or malformed encoding characters. Never alter an
employer, title, date, certification, degree, metric, or other hard fact while cleaning presentation text.

`;
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
