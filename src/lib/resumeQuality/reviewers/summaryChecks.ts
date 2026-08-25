import type { RequirementUnit } from "@/lib/match/types";
import { findBannedLanguage } from "./bannedLanguage";
import { extractCanonicalSkillsFromText, extractCanonicalSkillsWithCategoryFromText } from "./skillAliases";
import { dynamicSummaryTechnologyCeiling } from "../summaryTechnologyBudget";

const CLOUD_PROVIDERS = ["AWS", "Azure", "GCP"] as const;
type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

/** Deterministic, curated detector for vague, subject-driven summary framing — an abstract noun
 *  ("pipeline ownership", "platform design", "engineering practice", "capabilities", "delivery
 *  footprint", "architecture practice") paired with a vague linking verb ("spans", "encompasses",
 *  "pairs", "extends across/into") that names no concrete action. Deliberately narrow (curated
 *  phrase pairs, not a generic style-grader) so it never flags legitimate concrete sentences that
 *  happen to use one of these verbs about a real, named technology (e.g. "extends into Azure
 *  Synapse Analytics" naming a real technology right after is fine — this only fires when the
 *  SUBJECT itself is one of the abstract nouns below, which a concrete "Built X..." sentence never
 *  has). SUMMARY QUALITY V2 (2026-08-23) — see canonicalInstructions.ts's PROFESSIONAL SUMMARY
 *  STRUCTURE for the corresponding writer-facing rule this check enforces deterministically. */
const ABSTRACT_FRAMING_PATTERNS: RegExp[] = [
  /\b(pipeline ownership|platform design|engineering practice|delivery footprint|architecture practice|technical footprint)\s+(spans|encompasses|pairs|extends across|extends into)\b/gi,
  /\bcapabilities\s+(encompass|span)\b/gi,
];

/** Every distinct abstract-framing phrase matched, in the order found — deterministic, not a
 *  subjective judgment of "does this read well". */
function detectAbstractFraming(text: string): string[] {
  const found: string[] = [];
  for (const pattern of ABSTRACT_FRAMING_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const m of matches) found.push(m[0]);
  }
  return found;
}

/** Words that describe seniority/level rather than the role's actual domain — stripped before
 *  comparing a target role title's own words against the summary, since a summary need not repeat
 *  "Senior"/"Lead" verbatim to be correctly positioned for the role. */
const ROLE_TITLE_LEVEL_WORDS = new Set([
  "senior", "sr", "junior", "jr", "lead", "principal", "staff", "associate", "i", "ii", "iii", "iv",
]);

function significantRoleTitleWords(targetRoleTitle: string): string[] {
  return targetRoleTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, " ")
    .split(/[\s/-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !ROLE_TITLE_LEVEL_WORDS.has(w));
}

/** A canonical skill set "implies" a cloud provider either by naming it directly (bare "AWS") or by
 *  naming one of its branded sub-products (e.g. "AWS Glue", "Azure Data Factory") — the
 *  non-overlapping-span matching in extractCanonicalSkillsFromText() credits the MORE specific
 *  canonical name (e.g. "AWS Glue") rather than double-crediting the shorter "AWS" too, so a
 *  provider-level check must look at prefixes, not just exact provider-name membership. */
function impliedCloudProviders(canonicalSkills: ReadonlySet<string>): CloudProvider[] {
  return CLOUD_PROVIDERS.filter((provider) => [...canonicalSkills].some((skill) => skill === provider || skill.startsWith(`${provider} `)));
}

export interface SummaryCheckResult {
  summaryIssues: string[];
  insufficientRequirementData: boolean;
  /** Banned AI-sounding phrases found in the Professional Summary — previously only bulletChecks.ts
   *  scanned Experience bullets for these; the summary is prose text under the exact same guardrail
   *  and was silently exempt. Kept as its own field (not folded into summaryIssues) so callers that
   *  care about banned-language specifically (instructionCompliance.ts's bannedLanguage check) don't
   *  need to string-match summaryIssues text. */
  bannedLanguageFound: string[];
  /** SUMMARY QUALITY V2 (2026-08-23): the subset of summaryIssues that are real, deterministic
   *  quality defects — not merely a structural line-count nudge — and so are folded into
   *  instructionCompliance.ts's bannedLanguage soft-gate count (same plumbing already used for
   *  third-person narration / summary-technology-dumping, see deterministicReviewer.ts). Distinct
   *  from summaryIssues (all human-facing, advisory-only prose) so a caller that needs to know
   *  specifically "does this gate READY" doesn't have to string-match summaryIssues text. */
  styleIssuesFound: string[];
}

function dominantStackFrom(jobRequirements: RequirementUnit[]): Set<string> {
  const critical = jobRequirements.filter(
    (u) => (u.kind === "skill" || u.kind === "skill_group") && (u.criticality === "CRITICAL" || u.criticality === "REQUIRED")
  );
  return new Set(critical.flatMap((u) => u.memberSkillNames).slice(0, 8));
}

/** Whether AI/ML mentions in the summary crowd out the candidate's primary domain for a target
 *  role that is not itself AI/ML-focused. Deliberately conservative: only fires when (a) the target
 *  role title itself gives no AI/ML signal, AND (b) AI/ML-category mentions are NOT a minority of
 *  the summary's technology mentions (i.e. they tie or outnumber every other category combined) —
 *  a summary that mentions AI/ML once or twice alongside a larger core-domain stack is exactly the
 *  "secondary differentiator" the canonical instructions explicitly allow, not a violation. */
function detectSecondaryDifferentiatorDominance(
  summarySkillsWithCategory: ReadonlyMap<string, string>,
  targetRoleTitle: string | null | undefined
): string | null {
  const roleSignalsAiMl = /\b(ai|ml|machine learning|genai|gen-ai|data scientist)\b/i.test(targetRoleTitle ?? "");
  if (roleSignalsAiMl) return null;

  const categories = [...summarySkillsWithCategory.values()];
  if (categories.length < 2) return null; // too little signal to call anything "dominant"

  const aiMlCount = categories.filter((c) => c === "AI / ML").length;
  const otherCount = categories.length - aiMlCount;
  if (aiMlCount > 0 && aiMlCount >= otherCount) {
    return `Summary lets AI/ML technologies dominate (${aiMlCount} of ${categories.length} named technologies) for a target role ("${targetRoleTitle}") that is not itself AI/ML-focused — AI/ML should read as a secondary differentiator, not the primary positioning.`;
  }
  return null;
}

/** A summary that names many distinct technologies relative to its length reads as a keyword dump
 *  rather than positioning prose — the same failure mode SUMMARY_TECHNOLOGY_DUMP already catches in
 *  presentationContract.ts, computed independently here (deterministic word-count / distinct-skill
 *  ratio) so summaryChecks.ts doesn't need to import that module's internals. Threshold chosen
 *  loosely (more than 1 distinct technology per 6 words) so a normal, technology-dense-but-readable
 *  summary sentence never trips it — only a genuine comma-separated list does. */
function detectKeywordStuffing(summaryText: string, summarySkills: ReadonlySet<string>): string | null {
  const wordCount = summaryText.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) return null;
  const density = summarySkills.size / wordCount;
  if (summarySkills.size >= 8 && density > 1 / 6) {
    return `Summary names ${summarySkills.size} distinct technologies in ${wordCount} words — reads as a keyword list rather than positioning prose; keep the strongest few and let bullets/skills carry the rest.`;
  }
  return null;
}

/** Deterministic-only: word overlap with the JD's dominant stack, an explicit cloud-provider
 *  contradiction check, abstract-framing/keyword-stuffing/secondary-differentiator-dominance
 *  detection, and target-role clarity. Never a semantic "is this summary compelling" judgment —
 *  every check here is a curated pattern match or a count/ratio threshold, not an LLM opinion. */
export function evaluateSummaryAlignment(
  summary: string[],
  jobRequirements: RequirementUnit[] | undefined,
  targetRoleTitle?: string | null
): SummaryCheckResult {
  const summaryText = summary.join(" ");
  const summaryIssues: string[] = [];
  const styleIssuesFound: string[] = [];
  const bannedLanguageFound = findBannedLanguage(summaryText);
  if (bannedLanguageFound.length > 0) {
    summaryIssues.push(`Banned AI-sounding language in Professional Summary: ${bannedLanguageFound.join(", ")}`);
  }

  if (summaryText.trim().length === 0) {
    summaryIssues.push("Professional Summary is empty.");
    return {
      summaryIssues,
      insufficientRequirementData: !jobRequirements || jobRequirements.length === 0,
      bannedLanguageFound,
      styleIssuesFound,
    };
  }
  if (summaryText.trim().split(/\s+/).length < 12) {
    summaryIssues.push("Professional Summary is very short/generic — likely missing role-specific detail.");
  }

  // Professional Summary Structure guardrail (canonicalInstructions.ts): a recruiter should be able
  // to read the positioning in about 5-8 seconds, which the canonical standard targets as roughly
  // 4-6 sentences/lines. `summary` is already stored one entry per line/sentence, so its length is
  // the direct signal. Wide tolerance and advisory wording only: this is a structural nudge, not a
  // truthfulness finding — a genuinely strong summary just outside the range is never fabricated or
  // unsafe, so it must never be treated as a blocking issue.
  if (summary.length > 0 && summary.length < 3) {
    summaryIssues.push(
      `Professional Summary is only ${summary.length} line(s) — aim for roughly 4-6 concise sentences so a recruiter can place this candidate in about 5-8 seconds.`
    );
  } else if (summary.length > 8) {
    summaryIssues.push(
      `Professional Summary is ${summary.length} lines — condense toward roughly 4-6 concise sentences so a recruiter can scan it in about 5-8 seconds.`
    );
  }

  // Abstract, subject-driven framing ("Platform design spans...") — a curated pattern match, not a
  // style opinion. Real quality defect: promoted into styleIssuesFound so it gates, not just advises.
  const abstractFraming = detectAbstractFraming(summaryText);
  if (abstractFraming.length > 0) {
    const msg = `Summary uses abstract, subject-driven framing instead of concrete action verbs: ${[...new Set(abstractFraming)].join(", ")}.`;
    summaryIssues.push(msg);
    styleIssuesFound.push(msg);
  }

  // Target-role clarity: the summary's own text should name or align with the target role somewhere
  // — a summary that never mentions any significant word of the role title is a genuine positioning
  // defect, not a stylistic nitpick. Conservative: only fires when the role title actually has
  // significant words to check against (a one-word/generic title never trips this).
  if (targetRoleTitle) {
    const roleWords = significantRoleTitleWords(targetRoleTitle);
    if (roleWords.length > 0) {
      const normalizedSummary = summaryText.toLowerCase();
      // Word-boundary match, not raw substring containment — a bare .includes("data") would
      // false-positive on "Databricks"/"metadata", crediting role alignment the summary never
      // actually stated.
      const anyMatch = roleWords.some((w) => new RegExp(`(?<![a-z0-9])${w}(?![a-z0-9])`, "i").test(normalizedSummary));
      if (!anyMatch) {
        const msg = `Summary never names or clearly aligns with the target role ("${targetRoleTitle}") — a recruiter should be able to place the candidate against this role from the summary alone.`;
        summaryIssues.push(msg);
        styleIssuesFound.push(msg);
      }
    }
  }

  const summarySkills = extractCanonicalSkillsFromText(summaryText);

  const keywordStuffing = detectKeywordStuffing(summaryText, summarySkills);
  if (keywordStuffing) {
    summaryIssues.push(keywordStuffing);
    styleIssuesFound.push(keywordStuffing);
  }

  const summarySkillsWithCategory = extractCanonicalSkillsWithCategoryFromText(summaryText);
  const dominance = detectSecondaryDifferentiatorDominance(summarySkillsWithCategory, targetRoleTitle);
  if (dominance) {
    summaryIssues.push(dominance);
    styleIssuesFound.push(dominance);
  }

  if (!jobRequirements || jobRequirements.length === 0) {
    return { summaryIssues, insufficientRequirementData: true, bannedLanguageFound, styleIssuesFound };
  }

  const dominantStack = dominantStackFrom(jobRequirements);

  if (dominantStack.size > 0) {
    const overlap = [...dominantStack].filter((s) => summarySkills.has(s));
    if (overlap.length === 0) {
      // A real, JD-grounded failure to surface strongly-evidenced P1/P2 technology — not a style
      // nitpick — so this one is promoted into styleIssuesFound too (previously advisory-only,
      // meaning a summary could silently omit every JD-critical technology and still pass).
      const msg = `Summary does not mention any of the JD's dominant required technologies (${[...dominantStack].slice(0, 5).join(", ")}).`;
      summaryIssues.push(msg);
      styleIssuesFound.push(msg);
    }
  }

  // Explicit cloud-provider contradiction: summary names a provider the JD's dominant stack never
  // mentions, and the JD DOES have an unambiguous dominant provider.
  const jdProviders = impliedCloudProviders(dominantStack);
  const summaryProviders = impliedCloudProviders(summarySkills);
  if (jdProviders.length === 1 && summaryProviders.length > 0 && !summaryProviders.includes(jdProviders[0])) {
    summaryIssues.push(`Summary emphasizes ${summaryProviders.join("/")} while the JD's dominant cloud platform is ${jdProviders[0]}.`);
  }

  return { summaryIssues, insufficientRequirementData: false, bannedLanguageFound, styleIssuesFound };
}

// =====================================================================================================
// PHASE 6.5 — RECRUITER-NATURAL SUMMARY POLICY (six checks, evaluated separately per the mission spec)
// =====================================================================================================

export interface SummaryPolicyCheckDetail {
  pass: boolean;
  message?: string;
}

export interface SummaryPolicyResult {
  /** Summary clearly establishes role and years of experience. */
  identityOpening: SummaryPolicyCheckDetail;
  /** Named technologies <= the dynamic ceiling (see presentationContract.ts's
   *  dynamicSummaryTechnologyCeiling) — a CEILING, never a required count. */
  technologyBudget: SummaryPolicyCheckDetail & { namedCount: number; ceiling: number };
  /** Detects obvious product/tool enumeration — comma-separated technology inventories, stacked
   *  parenthetical lists — independent of the raw count check above. */
  keywordInventoryRisk: SummaryPolicyCheckDetail;
  /** Reads as engineering identity/prose rather than a keyword list (abstract framing, list-shaped
   *  sentences). */
  recruiterNaturalness: SummaryPolicyCheckDetail;
  /** Still reflects the dominant target platform/ecosystem — never REQUIRES every P1/P2 keyword. */
  targetAlignment: SummaryPolicyCheckDetail;
  /** Summary does not substantially reproduce the Technical Skills section. */
  skillsDuplication: SummaryPolicyCheckDetail;
  /** PHASE 6.8 — summary never addresses the employer directly or writes in cover-letter/job-
   *  application voice (see detectApplicationLanguage below). */
  applicationLanguage: SummaryPolicyCheckDetail;
}

/**
 * PHASE 6.8 — cover-letter / job-application voice detector.
 *
 * A resume summary describes the CANDIDATE's own positioning; it must never speak TO the employer
 * or refer to the posting itself the way a cover letter does ("That experience lines up closely
 * with this role's emphasis on..."). Three narrow, semantically distinct pattern families catch
 * this class of language without depending on one exhaustive literal phrase list:
 *   1. Second-person address to the employer/reader ("your organization/team/requirements/company").
 *   2. Deictic reference to the specific posting ("this role/position/opportunity/job").
 *   3. First-person application voice ("I'm excited...", "I would bring...", "seeking this
 *      opportunity", "ideal candidate").
 * Deliberately narrow: legitimate engineering nouns ("this platform/system/data/pipeline") and JD-
 * derived domain words (company names, "banking", "payments") never match — only address to the
 * reader or the application itself trips this, which is exactly the SUMMARY-APPLICATION-LANGUAGE-04
 * false-positive protection (company/domain terminology alone must never trigger).
 */
const APPLICATION_LANGUAGE_PATTERNS: RegExp[] = [
  /\byour\s+(organization|company|team|requirements|needs|mission)\b/gi,
  /\bthis\s+(role|position|opportunity|job)('s)?\b/gi,
  /\bi\s*(?:'m|am)\s+(excited|eager|thrilled)\b/gi,
  /\bi\s+would\s+(bring|love to)\b/gi,
  /\bseeking\s+this\s+opportunity\b/gi,
  /\bideal\s+(candidate|fit)\b/gi,
  /\b(align|aligns|aligned|match|matches|matched)\s+(closely\s+)?(with\s+)?(this|your)\b/gi,
];

/** Every distinct application-language phrase matched, in the order found. */
export function detectApplicationLanguage(text: string): string[] {
  const found: string[] = [];
  for (const pattern of APPLICATION_LANGUAGE_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const m of matches) found.push(m[0]);
  }
  return [...new Set(found)];
}

/** Shared writer-facing prose for the same rule, quoted verbatim by both the first-pass identity
 *  section (professionalIdentity.ts) and the targeted summary-repair guidance
 *  (repairContextCompiler.ts) so this policy exists in exactly one place, per Phase 6.8. */
export const SUMMARY_APPLICATION_LANGUAGE_GUARDRAIL_TEXT =
  'never address the employer directly or write as if this were a cover letter — no "your team/requirements", ' +
  '"this role/position/opportunity", "I\'m excited to...", or "ideal candidate"; describe the candidate\'s own ' +
  "positioning directly instead";

/** A sentence whose primary semantic content is a list of tools — 3+ comma/slash-separated
 *  capitalized-ish tokens strung together, the shape a raw technology inventory takes regardless of
 *  the surrounding verb. Distinct from detectKeywordStuffing's whole-summary density ratio: this
 *  catches a single list-shaped sentence even inside an otherwise-reasonable summary. */
const TOOL_ENUMERATION_PATTERN = /\b(?:[A-Z][\w.+#/-]*\s*,\s*){2,}(?:and\s+)?[A-Z][\w.+#/-]*/;

function detectToolEnumerationSentence(summaryText: string): string | null {
  for (const sentence of summaryText.split(/(?<=[.!?])\s+/)) {
    if (TOOL_ENUMERATION_PATTERN.test(sentence)) return sentence.trim();
  }
  return null;
}

/** "[Role words] with X+ years of experience..." or an equivalent clear identity opening — either an
 *  explicit years-of-experience mention, or a sentence that opens with a title-like phrase followed by
 *  an identity verb ("with", "specializing in", "who", "building"). Deliberately permissive: this is
 *  checking for the PRESENCE of a clear opening, not grading prose quality. */
function checkIdentityOpening(firstSentence: string): SummaryPolicyCheckDetail {
  const trimmed = firstSentence.trim();
  if (trimmed.length === 0) {
    return { pass: false, message: "Summary has no content to establish identity." };
  }
  const hasYearsPattern = /\b\d{1,2}\+?\s*years?\b/i.test(trimmed);
  const opensWithRoleLikePhrase = /^[A-Z][\w/&-]*(?:\s+[A-Z][\w/&-]*){0,4}\s+(with|specializing in|who|building|focused on)\b/.test(trimmed);
  if (hasYearsPattern || opensWithRoleLikePhrase) {
    return { pass: true };
  }
  return {
    pass: false,
    message:
      `Summary's opening sentence does not clearly establish role/experience identity (e.g. "[Role] with X+ years of ` +
      `experience..."). Recruiters should be able to place the candidate from the first sentence alone.`,
  };
}

/**
 * PHASE 6.5 — the six recruiter-natural summary checks, evaluated separately (never merged into one
 * pass/fail) so a caller can see exactly which dimension a summary fails, if any. Complements (never
 * replaces) evaluateSummaryAlignment above — that function's banned-language/length/role-clarity/
 * cloud-contradiction checks still run independently. A summary is NEVER failed here merely because a
 * supported JD technology is absent — detailed JD coverage belongs to evaluateCanonicalCoverage
 * (jdRequirementReconciler.ts), not this function.
 */
export function evaluateSummaryPolicy(params: {
  summary: string[];
  resumeSkillGroups: Array<{ label: string; items: string[] }>;
  /** Count of significant SUPPORTED canonical requirements after Phase 6.2 reconciliation — drives
   *  the dynamic technology ceiling. 0/undefined falls back to the most conservative ceiling (2). */
  significantSupportedTechnologyCount?: number;
  targetRoleTitle?: string | null;
}): SummaryPolicyResult {
  const summaryText = params.summary.join(" ").trim();
  const firstSentence = summaryText.split(/(?<=[.!?])\s+/)[0] ?? "";
  const ceiling = dynamicSummaryTechnologyCeiling(params.significantSupportedTechnologyCount ?? 0);

  const summarySkills = extractCanonicalSkillsFromText(summaryText);
  const namedCount = summarySkills.size;

  const identityOpening = checkIdentityOpening(firstSentence);

  const technologyBudget: SummaryPolicyResult["technologyBudget"] =
    namedCount <= ceiling
      ? { pass: true, namedCount, ceiling }
      : {
          pass: false,
          namedCount,
          ceiling,
          message: `Summary names ${namedCount} technologies, above the dynamic ceiling of ${ceiling} for this JD's ${
            (params.significantSupportedTechnologyCount ?? 0) || "unknown"
          } significant supported requirements. This is a ceiling, not a target — fewer is fine.`,
        };

  const enumerationSentence = detectToolEnumerationSentence(summaryText);
  const keywordInventoryRisk: SummaryPolicyCheckDetail = enumerationSentence
    ? {
        pass: false,
        message: `A sentence reads as a technology enumeration rather than positioning prose: "${enumerationSentence}".`,
      }
    : { pass: true };

  const abstractFraming = detectAbstractFraming(summaryText);
  const naturalnessIssues = [...abstractFraming, ...(enumerationSentence ? [enumerationSentence] : [])];
  const recruiterNaturalness: SummaryPolicyCheckDetail =
    naturalnessIssues.length === 0
      ? { pass: true }
      : {
          pass: false,
          message: `Summary reads as a keyword/framing list rather than engineering identity in at least one place: ${[
            ...new Set(naturalnessIssues),
          ].join("; ")}.`,
        };

  let targetAlignment: SummaryPolicyCheckDetail = { pass: true };
  if (params.targetRoleTitle) {
    const roleWords = significantRoleTitleWords(params.targetRoleTitle);
    if (roleWords.length > 0) {
      const normalizedSummary = summaryText.toLowerCase();
      const anyRoleMatch = roleWords.some((w) => new RegExp(`(?<![a-z0-9])${w}(?![a-z0-9])`, "i").test(normalizedSummary));
      if (!anyRoleMatch) {
        targetAlignment = {
          pass: false,
          message: `Summary never names or clearly aligns with the target role ("${params.targetRoleTitle}").`,
        };
      }
    }
  }

  const skillGroupSkills = extractCanonicalSkillsFromText(
    params.resumeSkillGroups.flatMap((g) => g.items).join("\n")
  );
  const overlap = [...summarySkills].filter((s) => skillGroupSkills.has(s));
  // A summary naming 1-2 of the same technologies as Technical Skills is normal and expected overlap
  // (both are honestly describing the same real candidate) — only heavy, near-total duplication of
  // the Skills section reads as the summary functioning as a second Skills list.
  const skillsDuplication: SummaryPolicyCheckDetail =
    overlap.length >= 3 && namedCount > 0 && overlap.length / namedCount >= 0.7
      ? {
          pass: false,
          message: `Summary substantially reproduces the Technical Skills section (${overlap.length}/${namedCount} named technologies also appear there verbatim: ${overlap.slice(0, 6).join(", ")}).`,
        }
      : { pass: true };

  const applicationLanguageMatches = detectApplicationLanguage(summaryText);
  const applicationLanguage: SummaryPolicyCheckDetail =
    applicationLanguageMatches.length === 0
      ? { pass: true }
      : {
          pass: false,
          message: `Summary uses cover-letter/job-application language instead of direct candidate positioning: ${applicationLanguageMatches.join(", ")}.`,
        };

  return {
    identityOpening,
    technologyBudget,
    keywordInventoryRisk,
    recruiterNaturalness,
    targetAlignment,
    skillsDuplication,
    applicationLanguage,
  };
}
