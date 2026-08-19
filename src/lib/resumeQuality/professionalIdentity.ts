import type { CandidateProfile } from "@/lib/match/types";

/**
 * Stage 30 — the candidate's own professional identity, derived from their evidence.
 *
 * THE DEFECT. The writer's output schema described the resume headline as "Target Job Title /
 * Specialization", which is an instruction to put the JOB's title where the CANDIDATE's identity
 * belongs. On the real corpus that produced the headline "Software Engineer - Python, SQL,
 * Databricks, Java | Banking & Payments Data Platforms" for a candidate whose every role is a data
 * engineering role — the JD title had simply been copied over the person.
 *
 * A tailored resume may absolutely lead with JD-relevant specialization. What it may not do is
 * change who the candidate is. This module supplies the identity the writer must start from, taken
 * from the titles the candidate actually held, so that decision stops being the model's to make.
 *
 * Nothing here invents a title, a seniority, or a specialization: with no usable experience entry it
 * returns null and the prompt simply omits the guidance rather than asserting something unfounded.
 */

export interface ProfessionalIdentity {
  /** The identity to lead with — the candidate's most recent role title, normalised of seniority. */
  identity: string;
  /** The exact titles it was derived from, most recent first, for the prompt to show its working. */
  evidenceTitles: string[];
}

/** Seniority words are removed from the derived identity so it names a PROFESSION, not a level —
 *  the writer must not inherit "Lead"/"Senior" from a JD, and must not lose it from real evidence
 *  either, so the raw titles travel alongside for the writer to reason about. */
const SENIORITY_PREFIXES = [
  "senior lead",
  "senior staff",
  "principal",
  "senior",
  "lead",
  "staff",
  "junior",
  "associate",
  "sr.",
  "sr",
  "jr.",
  "jr",
];

/** Trailing level markers ("III", "II", "I", "2", "3") that grade a role rather than name it. */
const LEVEL_SUFFIX = /\s+(?:[IVX]{1,4}|\d)\s*$/i;

export function normalizeRoleTitle(title: string): string {
  let value = title.trim().replace(/\s+/g, " ");
  // Titles frequently carry a technology tail after a dash or pipe ("Data Engineer - Databricks").
  // The identity is the part before it; the tail is specialization, handled separately.
  value = value.split(/\s+[|–—-]\s+/)[0].trim();
  let changed = true;
  while (changed) {
    changed = false;
    const lower = value.toLowerCase();
    for (const prefix of SENIORITY_PREFIXES) {
      if (lower.startsWith(`${prefix} `)) {
        value = value.slice(prefix.length).trim();
        changed = true;
        break;
      }
    }
  }
  value = value.replace(LEVEL_SUFFIX, "").trim();
  return value;
}

/**
 * The identity to lead the headline and summary with: the most recent role the candidate actually
 * held, with seniority and level markers removed. Most recent wins because a resume states who the
 * candidate IS now, not who they were first.
 */
export function deriveProfessionalIdentity(profile: CandidateProfile): ProfessionalIdentity | null {
  const entries = profile.experience.filter((e) => typeof e.title === "string" && e.title.trim().length > 0);
  if (entries.length === 0) return null;

  // Most recent first: a null endDate means "current", otherwise compare the stated end dates.
  const ordered = [...entries].sort((a, b) => {
    if (a.endDate === null && b.endDate !== null) return -1;
    if (b.endDate === null && a.endDate !== null) return 1;
    return (b.endDate ?? "").localeCompare(a.endDate ?? "");
  });

  const identity = normalizeRoleTitle(ordered[0].title);
  if (identity.length === 0) return null;
  return { identity, evidenceTitles: ordered.map((e) => e.title.trim()) };
}

/** Openings that describe nobody in particular. The real corpus produced the first of these. */
export const PROHIBITED_SUMMARY_OPENINGS: readonly RegExp[] = [
  /^\s*engineer\s+with\b/i,
  /^\s*professional\s+with\b/i,
  /^\s*experienced\s+professional\b/i,
  /^\s*results[- ]driven\s+professional\b/i,
  /^\s*candidate\s+with\b/i,
  /^\s*seasoned\s+professional\b/i,
  /^\s*motivated\s+professional\b/i,
  /^\s*dynamic\s+professional\b/i,
];

/** Vague quantity language used where a real number is not available — "close to five years". */
export const VAGUE_EXPERIENCE_PHRASES: readonly RegExp[] = [
  /\b(?:close to|nearly|almost|about|around|roughly|approximately|over|nearly)\s+\w+\s+years?\b/i,
  /\b\d+\+?\s*years?\b/i,
];

export interface SummaryOpeningIssue {
  kind: "GENERIC_OPENING" | "UNVERIFIED_YEARS";
  detail: string;
}

/**
 * Deterministic check on a proposed summary opening. Reported, never used to fail the Stage 21
 * quality gate — Stage 30 is a presentation correction and changes no gate semantics.
 *
 * `statedYearsOfExperience` is the value CareerOps itself computed (CandidateProfile
 * .totalYearsExperience). It is null whenever the interval-union math could not determine one
 * unambiguously, which is exactly the case on the real corpus — so any years figure in the summary
 * was arithmetic the writer performed itself, which is what this flags.
 */
export function checkSummaryOpening(
  summaryFirstParagraph: string,
  statedYearsOfExperience: number | null
): SummaryOpeningIssue[] {
  const issues: SummaryOpeningIssue[] = [];
  const text = summaryFirstParagraph.trim();

  for (const pattern of PROHIBITED_SUMMARY_OPENINGS) {
    if (pattern.test(text)) {
      issues.push({
        kind: "GENERIC_OPENING",
        detail: `The summary opens with a generic identity ("${text.slice(0, 60)}…"). It must lead with the candidate's actual profession.`,
      });
      break;
    }
  }

  if (statedYearsOfExperience === null) {
    for (const pattern of VAGUE_EXPERIENCE_PHRASES) {
      const match = text.match(pattern);
      if (match) {
        issues.push({
          kind: "UNVERIFIED_YEARS",
          detail: `The summary states "${match[0]}" but CareerOps computed no total years of experience for this candidate, so the figure is the writer's own arithmetic.`,
        });
        break;
      }
    }
  }

  return issues;
}

/**
 * True when a proposed headline still leads with the candidate's own profession. Compared on the
 * leading segment only, because everything after a separator is JD-relevant specialization and is
 * explicitly allowed.
 */
export function headlinePreservesIdentity(headline: string, identity: string): boolean {
  const leading = normalizeRoleTitle(headline.split(/\s*[|–—]\s*/)[0]);
  const a = leading.toLowerCase();
  const b = identity.toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}

/** The writer-facing section. States the identity as a constraint and the specialization as freedom. */
export function renderProfessionalIdentitySection(
  identity: ProfessionalIdentity | null,
  statedYearsOfExperience: number | null
): string {
  if (!identity) return "";
  let out = "## PROFESSIONAL IDENTITY — WHO THIS CANDIDATE IS\n\n";
  out += `**Derived identity: ${identity.identity}.** Taken from the roles actually held: ${identity.evidenceTitles.join("; ")}.\n\n`;
  out +=
    "**Headline rule.** The headline must LEAD with this professional identity. JD-relevant " +
    "specialization and technologies belong after it, separated by pipes. You may sharpen the identity " +
    "with a genuine specialization the evidence supports, but you may not replace it with the job's " +
    "title: a data engineer applying to a role titled differently is still a data engineer. Never " +
    "invent seniority the evidence does not show.\n\n";
  out +=
    "**Summary opening rule.** The summary must open by naming that same professional identity and the " +
    "specialization this JD cares about — never with a generic construction such as \"Engineer with…\", " +
    "\"Professional with…\", \"Experienced professional…\", \"Results-driven professional…\" or " +
    "\"Candidate with…\".\n\n";
  out +=
    statedYearsOfExperience === null
      ? "**Years of experience.** CareerOps computed no verified total for this candidate, so do NOT state one. " +
        "Do not add up employment dates yourself, and do not approximate with phrases like \"close to five years\" " +
        "or \"over four years\". Describe the depth of the work instead of counting it.\n\n"
      : `**Years of experience.** The only verified figure is ${statedYearsOfExperience}. If you state years at all, ` +
        "state that number and nothing else — never your own arithmetic over employment dates.\n\n";
  return out;
}
