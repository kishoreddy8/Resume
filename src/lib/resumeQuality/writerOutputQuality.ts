import type { ResumeWriterOutput } from "./types";

export const CURRENT_ROLE_BULLET_CAP = 8;
export const SECOND_ROLE_BULLET_CAP = 7;
export const OLDER_ROLE_BULLET_CAP = 6;
// Deliberately >= CURRENT_ROLE_BULLET_CAP + SECOND_ROLE_BULLET_CAP + OLDER_ROLE_BULLET_CAP (21) so a
// three-role resume can legitimately reach every individual role cap at once without the total cap
// contradicting them; a resume with more roles is still bounded here, just not by the per-role sum.
export const TOTAL_EXPERIENCE_BULLET_CAP = 21;
export const PROJECT_DESCRIPTION_MAX_SENTENCES = 2;
export const PROJECT_DESCRIPTION_MAX_TECHNOLOGIES = 4;

/** Writer-facing quality guidance. Evidence still decides membership; this section only controls
 * selection, emphasis, and readable decomposition of already-supported material. */
export function renderWriterOutputQualitySection(): string {
  return `## WRITER OUTPUT QUALITY & BULLET STANDARDS

**Summary standards.** Write 3-4 concise sentences. Do not stack template stems such as "Data Engineer specializing...", "Expertise spans...", or "Proven ability...".

**Bullet limits & caps.** Current role: max ${CURRENT_ROLE_BULLET_CAP}; second role: max ${SECOND_ROLE_BULLET_CAP}; older roles: max ${OLDER_ROLE_BULLET_CAP}; total experience: max ${TOTAL_EXPERIENCE_BULLET_CAP} bullets. These are ceilings, not targets: never pad to a cap.

**Bullet composition & evidence.** Prefer 1 primary capability per bullet. When a sentence is overloaded, split it only when each resulting bullet has its own employer-scoped evidence; Otherwise simplify the original bullet. For every added bullet, record the employer and exact evidence source in writerValidation.notes. If evidence cannot support an employer attribution, do not create the bullet. Reject duplicate ideas, synonymous repeats, keyword stuffing, and fabricated metrics.

**JD-driven skill order.** Prioritize supported JD skills naturally. Never rewrite an Azure employer claim as AWS (or the reverse) unless that same employer's evidence permits it.

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
