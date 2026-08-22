import { SKILL_TAXONOMY } from "@/lib/jobIntel/skillsTaxonomy";
import { escapeRegExp } from "@/lib/jobIntel/textUtils";
import { deriveCriticality } from "./requirementCriticality";
import { isExperienceDepthRequired } from "./handsOnCues";
import { extractTechnologySpecificYears } from "./technologyDuration";
import type { RequirementUnit } from "./types";

/**
 * Finds meaningful Required/Preferred JD lines not already represented by job_skills,
 * job_certifications, or the education requirement — and converts them into UNRESOLVED
 * Requirement Units. This is the mechanism that keeps a taxonomy gap from silently producing
 * 100% requirement coverage: a real requirement line with no structured extraction still counts
 * against coverage, instead of vanishing.
 *
 * NOT a competing Job Intelligence extractor: input is exactly `description_sections`'
 * requiredQualifications/preferredQualifications text (the same two sections job_skills already
 * scans), and requirement-level classification comes only from which section a line is in — no new
 * text-mining beyond that.
 *
 * DUPLICATE-ACCOUNTING: a line is "already claimed" (excluded) in two ways:
 *  1. Skills — reuses the EXACT SAME SKILL_TAXONOMY alias set job_skills extraction
 *     (src/lib/jobIntel/skills.ts) already matches against. A line containing a taxonomy alias is
 *     guaranteed to be a line job_skills already has a row for, because both this detector and
 *     extractSkills() run identical alias matching over identical source text — one shared alias
 *     list, two call sites, zero risk of drift between "was this claimed" and "would extraction
 *     have found it".
 *  2. Certifications/education — a direct normalized-substring-overlap check against the evidence
 *     snippets those extractors already produced (job_certifications.evidence_snippet,
 *     jobs.education_evidence) — the same evidence-grounding technique jobDetailEnrichment.ts's
 *     isEvidenceGrounded already uses elsewhere in this codebase.
 * Both checks are deliberately generous toward "already claimed" — a false negative here (missing a
 * real gap) is the safe failure direction, same principle used throughout this codebase's AI-output
 * grounding checks; a false positive (a phantom duplicate UNRESOLVED unit) would unfairly deflate
 * coverage or manufacture a fake critical gap.
 */

const UNCLAIMED_REQUIREMENT_CAP = 5;
const MIN_LINE_LENGTH = 15;
const MAX_LINE_LENGTH = 220;

const BOILERPLATE_LINE_PATTERNS: RegExp[] = [
  /equal opportunity employer/i,
  /\bEEO\b/,
  /competitive (salary|compensation|benefits)/i,
  /health insurance|401\(k\)|paid time off|\bPTO\b/i,
  /\bwe (offer|provide)\b/i,
  /about (us|the company|our team)\b/i,
  /diversity,?\s*equity,?\s*and\s*inclusion/i,
  /reasonable accommodation/i,
  /background check/i,
  /^(requirements?|qualifications?|responsibilities|nice to have|preferred|required)\s*:?\s*$/i,
  // STAGE 25B — defence in depth for the context-aware section termination in parseSections.ts.
  // That change deliberately keeps a qualifications section open across sub-headings and
  // heading-shaped requirement bullets, which means a JD that never emits a recognized closing
  // heading can trail compensation/EEO/benefit prose into the requirement text. Measured on the
  // real 14,584-job corpus, only 64 jobs (0.44%) gained any boilerplate-matching requirement unit —
  // these patterns cover exactly the classes that audit surfaced, so a leaked line is filtered here
  // even when the section boundary itself could not be resolved. A false negative (dropping a real
  // requirement) is the safe direction; a fabricated requirement is not.
  /\b(base|annual|starting) (salary|pay)\b|\bsalary range\b|\bpay range\b|\btotal (rewards|compensation)\b/i,
  /\bon target earnings\b|\bOTE\b|\bbonus (potential|program|opportunit)/i,
  /\b(dental|vision|life|disability) insurance\b|\bflexible spending\b|\bstock (purchase|option|grant)\b/i,
  /\bequity\b.*\b(award|grant|package)\b/i,
  /\bwithout regard to (race|color|religion)\b|\baffirmative action\b|\be-?verify\b|\bprotected veteran/i,
  /\brecruitment fraud\b|\bstaffing agenc|\bunsolicited resumes?\b|\bthird[- ]party recruiters?\b/i,
  /\bapplication deadline\b|\bhow to apply\b|\bsubmit your application\b/i,
  /\bdrug[- ]free workplace\b|\bE-Verify\b/i,
];

const ALL_ALIAS_REGEXES = SKILL_TAXONOMY.flatMap((entry) =>
  entry.aliases.map((alias) => new RegExp(`(?<![\\w-])${escapeRegExp(alias)}(?![\\w-])`, "i"))
);

function lineContainsKnownSkill(line: string): boolean {
  return ALL_ALIAS_REGEXES.some((regex) => regex.test(line));
}

function normalizeForOverlap(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function lineAlreadyClaimed(line: string, alreadyClaimedEvidence: string[]): boolean {
  const normalizedLine = normalizeForOverlap(line);
  return alreadyClaimedEvidence.some((snippet) => {
    const normalizedSnippet = normalizeForOverlap(snippet);
    if (normalizedSnippet.length < MIN_LINE_LENGTH) return false;
    return normalizedLine.includes(normalizedSnippet) || normalizedSnippet.includes(normalizedLine);
  });
}

function isMeaningfulLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < MIN_LINE_LENGTH || trimmed.length > MAX_LINE_LENGTH) return false;
  return !BOILERPLATE_LINE_PATTERNS.some((p) => p.test(trimmed));
}

export interface UnclaimedRequirementInput {
  jobTitle: string;
  requiredQualificationsText: string | null;
  preferredQualificationsText: string | null;
  /** Evidence already claimed by job_skills, job_certifications, and the education unit — the
   *  overlap-dedup anchor for (2) above. */
  alreadyClaimedEvidence: string[];
}

export function detectUnclaimedRequirements(input: UnclaimedRequirementInput): RequirementUnit[] {
  const candidateLines: { line: string; requirementLevel: "Required" | "Preferred" }[] = [];
  for (const line of (input.requiredQualificationsText ?? "").split("\n")) {
    if (line.trim()) candidateLines.push({ line: line.trim(), requirementLevel: "Required" });
  }
  for (const line of (input.preferredQualificationsText ?? "").split("\n")) {
    if (line.trim()) candidateLines.push({ line: line.trim(), requirementLevel: "Preferred" });
  }

  const unclaimed = candidateLines.filter(
    ({ line }) => isMeaningfulLine(line) && !lineContainsKnownSkill(line) && !lineAlreadyClaimed(line, input.alreadyClaimedEvidence)
  );

  const kept = unclaimed.slice(0, UNCLAIMED_REQUIREMENT_CAP);
  const overflow = unclaimed.length - kept.length;

  const units: RequirementUnit[] = kept.map(({ line, requirementLevel }) => {
    const evidenceSnippets = [line];
    const requestedYears = extractTechnologySpecificYears(evidenceSnippets);
    return {
      kind: "skill",
      memberSkillNames: [],
      categories: [],
      label: line.length > 80 ? `${line.slice(0, 80)}…` : line,
      requirementLevel,
      criticality: deriveCriticality({ requirementLevel, evidenceSnippets, jobTitle: input.jobTitle, memberSkillNames: [] }),
      evidenceSnippets,
      experienceDepthRequired: isExperienceDepthRequired(evidenceSnippets) || requestedYears !== null,
      requestedYears,
      fromUnclaimedText: true,
    };
  });

  if (overflow > 0) {
    units.push({
      kind: "skill",
      memberSkillNames: [],
      categories: [],
      label: `${overflow} additional unclassified requirement line(s)`,
      requirementLevel: "Required",
      criticality: "REQUIRED",
      evidenceSnippets: [],
      experienceDepthRequired: false,
      requestedYears: null,
      fromUnclaimedText: true,
    });
  }

  return units;
}
