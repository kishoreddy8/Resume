import type { RequirementUnit } from "@/lib/match/types";
import { findBannedLanguage } from "./bannedLanguage";
import { extractCanonicalSkillsFromText, extractCanonicalSkillsWithCategoryFromText } from "./skillAliases";

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
