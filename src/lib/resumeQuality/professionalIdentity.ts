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

/**
 * Openings that describe nobody in particular.
 *
 * Stage 31 correction. The Stage 30 list was anchored on the BARE identity noun — `^engineer with`,
 * `^professional with` — so it caught "Engineer with…" and missed "Data engineer with…", which is
 * the form the real corpus actually produced (workflow 6: "Data engineer with nearly five years…").
 * Qualifying the noun defeated the whole list.
 *
 * IDENTITY_THEN_WITH below closes that: it matches an identity noun ANYWHERE in the opening clause
 * when the very next word is "with", however the noun is qualified. That is precisely the shape the
 * rule is about — leading with who the candidate is and then immediately quantifying them, instead
 * of leading with who they are and what they specialise in.
 *
 * It deliberately does NOT match "with" used later in a real sentence ("…pipelines with Terraform"),
 * because the identity noun must be the word immediately before it.
 */
const IDENTITY_NOUNS = "engineer|developer|analyst|scientist|architect|professional|candidate|consultant|specialist|administrator";

/** "<anything> <identity noun> with …" — "Data Engineer with", "Senior Cloud Architect with". */
const IDENTITY_THEN_WITH = new RegExp(`^[^.]{0,60}?\\b(?:${IDENTITY_NOUNS})s?\\s+with\\b`, "i");

export const PROHIBITED_SUMMARY_OPENINGS: readonly RegExp[] = [
  IDENTITY_THEN_WITH,
  /^\s*experienced\s+professional\b/i,
  /^\s*results[- ]driven\s+professional\b/i,
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
/**
 * "Data Engineer with 6 years of hands-on experience in…" — the identity followed by an
 * AUTHORITATIVE years figure.
 *
 * Stage 31.1, third pass. The blanket ban on "<identity> with…" was written to stop two real
 * failures: an unverifiable years claim ("Data Engineer with nearly five years") and a vacuous one
 * ("Data Engineer with deep Azure experience"). It also caught the one construction that is both
 * standard and fully evidenced — leading with a years figure the Master Resume itself states — and
 * that is the opening this candidate's own master resume uses. A rule that rejects the source
 * document's own wording is over-broad, so the carve-out is narrow and conditional: the figure must
 * already be verified, which is exactly what statedYearsOfExperience being non-null means.
 */
const IDENTITY_WITH_VERIFIED_YEARS = new RegExp(
  `^[^.]{0,60}?\\b(?:${IDENTITY_NOUNS})s?\\s+with\\s+(?:over|more than|nearly|almost|about|around|roughly|approximately)?\\s*\\d+\\+?\\s*years?\\b`,
  "i"
);

export function checkSummaryOpening(
  summaryFirstParagraph: string,
  statedYearsOfExperience: number | null
): SummaryOpeningIssue[] {
  const issues: SummaryOpeningIssue[] = [];
  const text = summaryFirstParagraph.trim();

  // An evidenced years-led opening is allowed; everything else in the list still is not.
  if (statedYearsOfExperience !== null && IDENTITY_WITH_VERIFIED_YEARS.test(text)) {
    return issues;
  }

  for (const pattern of PROHIBITED_SUMMARY_OPENINGS) {
    if (pattern.test(text)) {
      issues.push({
        kind: "GENERIC_OPENING",
        detail:
          `The summary opens "${text.slice(0, 60)}…". It must lead with the candidate's profession AND the ` +
          `specialization this JD needs — for example "Data Engineer specializing in Azure Databricks, PySpark ` +
          `and Delta Lake…" — never with the profession followed immediately by "with".`,
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
    "**Headline rule.** The line under the name carries **professional ROLE IDENTITIES ONLY** — one to " +
    "three of them, separated by pipes, each supported by a title the candidate actually held " +
    "(e.g. `Senior Data Engineer | Analytics Engineer`). **Never put technologies in it.** " +
    "The job's title never replaces the candidate's own, and never invent seniority the evidence does not show.\n\n";
  out +=
    "**Summary rule: POSITIONING, not inventory.** Write ONE continuous paragraph (3-4 sentences, ~650 chars). " +
    "Lead with the candidate's professional identity and JD specialization. " +
    "NEVER open with the identity followed immediately by \"with\" (e.g. \"Data Engineer with…\", \"Candidate with…\"). " +
    "Name at most SEVEN technologies in the entire summary. Avoid stock capability stems (\"Expertise spans…\", \"Proven ability to…\"); " +
    "lead with the work, its context, or a supported outcome.\n\n" +
    "- **Weak — a keyword dump:** \"Data Engineer specializing in Spark, Python, SQL, Databricks, Delta Lake, Snowflake, CDC, SCD...\"\n" +
    "- **Strong — the register to aim for:** \"Data Engineer building governed cloud data platforms for banking and payments platforms, scaling pipeline execution while maintaining end-to-end data quality controls.\"\n\n" +
    "Write in confident implied first person without turning the summary into a product list or marketing pitch. " +
    "Never narrate in third person (\"Owns...\", \"Builds...\"). Do not use em or en dashes.\n\n";
  out +=
    statedYearsOfExperience === null
      ? "**Years of experience.** CareerOps computed no verified total for this candidate, so do NOT state one. " +
        "Do not add up dates yourself or approximate with phrases like \"close to five years\". Describe the depth of the work instead.\n\n"
      : `**Years of experience.** The only verified figure is ${statedYearsOfExperience}. If you state years at all, ` +
        `state that number and nothing else — never your own arithmetic over employment dates.\n\n`;
  return out;
}

/**
 * Stage 31.1 — third-person narration of the candidate.
 *
 * A resume summary is written in implied first person: the reader already knows whose resume this
 * is, so the subject is elided. "Owns ETL delivery end to end" and "Works directly with product,
 * finance, and reporting stakeholders" instead read as a third party describing the candidate,
 * which is the one register a resume should never use about its own author.
 *
 * The check is deliberately narrow. A verb only counts when it OPENS a sentence, because that is
 * exactly the position where the elided subject is the candidate. The same words are perfectly
 * ordinary elsewhere — "Frameworks", "networks", "how Spark works", "Working knowledge of Azure" —
 * and flagging those would produce constant false positives on truthful, well-written text.
 *
 * Verbs are the caller-specified set. "Brings" is deliberately NOT among them: "Brings hands-on
 * experience across…" is an accepted capability construction, not narration.
 */
const THIRD_PERSON_NARRATION_VERBS = [
  "owns",
  "works",
  "builds",
  "develops",
  "manages",
  "leads",
  "creates",
  "implements",
  "maintains",
  "collaborates",
];

/** Sentence starts: the beginning of the paragraph, or the position after a sentence terminator. */
const SENTENCE_START = /(?:^|[.!?;]\s+)([A-Za-z]+)/g;

export interface SummaryNarrationIssue {
  /** The offending word, exactly as written, so the correction can quote it. */
  verb: string;
  /** The sentence it opens, trimmed for the correction message. */
  sentence: string;
}

/**
 * Scans EVERY summary paragraph, not just the first. The real corpus produced a compliant opening
 * paragraph and then slid into narration in paragraphs 2 and 4, which a first-paragraph-only check
 * would have passed.
 */
export function findThirdPersonNarration(summaryParagraphs: string[]): SummaryNarrationIssue[] {
  const issues: SummaryNarrationIssue[] = [];
  for (const paragraph of summaryParagraphs) {
    const text = paragraph.trim();
    if (text.length === 0) continue;
    SENTENCE_START.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SENTENCE_START.exec(text)) !== null) {
      const word = match[1];
      if (!THIRD_PERSON_NARRATION_VERBS.includes(word.toLowerCase())) continue;
      const from = match.index + match[0].length - word.length;
      issues.push({ verb: word, sentence: text.slice(from, from + 80).trim() });
    }
  }
  return issues;
}

/** The correction text shown to the writer for one narration finding. */
export function describeNarrationIssue(issue: SummaryNarrationIssue): string {
  return (
    `The summary sentence "${issue.sentence}…" opens with "${issue.verb}", which narrates the candidate ` +
    `in the third person. Resume summaries are written in implied first person: use a capability ` +
    `construction instead — "Experienced in…", "Specializing in…", "Expertise in…", "Hands-on experience ` +
    `with…", "Proven experience delivering…", "Brings experience across…", "Skilled in…". Do not fix this ` +
    `by putting the whole summary in the past tense; current capabilities stay current.`
  );
}
