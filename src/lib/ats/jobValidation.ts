import type { NormalizedJob } from "@/types";

/**
 * Positive-evidence job-candidate and normalized-job validation for CareerOps — see AGENTS.md §15/§16.
 *
 * The architecture separates two distinct responsibilities:
 * 1. ATS Adapter: proves "This record came from the ATS."
 * 2. Real-Job Validation: proves "This record represents an actual individual job opening."
 *
 * High-confidence negative evidence (pseudo-job calls-to-action such as "Talent Community",
 * "Join Our Team", "General Application", "Future Opportunities", "Search Jobs") are combined
 * with positive evidence (stable requisition ID, specific title, job-detail URL, substantive
 * description, explicit location metadata).
 *
 * Edge cases like "Talent Acquisition Partner", "Community Manager", "Career Development Manager",
 * "General Counsel", and "General Manager" are protected through targeted semantic matching.
 */

export interface JobValidationInput {
  url: string;
  text: string;
  /** Best-effort surrounding text from the link's listing container (location/department/date
   *  badges, an "Apply" button, etc.) — optional; validation still runs without it, just with less
   *  to go on. */
  contextText?: string;
}

export interface JobValidationResult {
  valid: boolean;
  positiveSignals: string[];
  negativeSignals: string[];
  reason: string;
}

// Requisition-ID-shaped URL/token — strong link-level positive signal
const REQUISITION_ID_PATTERNS: RegExp[] = [
  /[?&](gh_jid|req(?:uisition)?[_-]?id|job[_-]?id|jid|jobid|posting[_-]?id)=[a-z0-9-]+/i,
  /\/(jobs?|careers?|positions?|openings?|postings?|roles?)\/[a-z0-9-]*\d{3,}(?:[/?#]|$)/i,
  /\/(jobs?|careers?|positions?|openings?|postings?|roles?)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /-req-?\d{3,}/i,
  /(?<![A-Za-z0-9])R-?\d{4,}\b/, // Workday-style requisition numbers, e.g. R1559, R-1559, Title_R1559
];

// Semantic high-confidence non-job / pseudo-job patterns for titles
export const PSEUDO_JOB_TITLE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: "talent_community",
    regex: /\b(?:talent|candidate|alumni)\s+(?:community|network|pool|pipeline|collective)\b/i,
  },
  {
    name: "call_to_action",
    regex: /\b(?:join\s+(?:our\s+)?(?:team|talent|crew|family|us)|stay\s+connected|keep\s+in\s+touch)\b/i,
  },
  {
    name: "general_application",
    regex: /\b(?:general|open|spontaneous|unsolicited)\s+(?:application|interest|consideration|inquiry|opportunities|opportunity|submissions?|resume\s+submissions?)\b/i,
  },
  {
    name: "future_opportunities",
    regex: /\b(?:future|upcoming)\s+(?:opportunities|openings|possibilities|roles|positions)\b/i,
  },
  {
    name: "job_alerts_search",
    regex: /\b(?:job\s+alerts?|email\s+alerts?|get\s+job\s+alerts?|search\s+jobs?|search\s+openings|browse\s+jobs?|view\s+all\s+jobs?|all\s+jobs|all\s+openings|all\s+positions)\b/i,
  },
  {
    name: "expression_of_interest",
    regex: /\b(?:expression\s+of\s+interest|register\s+(?:your\s+)?interest|submit\s+(?:your\s+)?(?:resume|cv)|send\s+(?:your\s+)?(?:resume|cv)|drop\s+(?:your\s+)?(?:resume|cv)|resume\s+drop)\b/i,
  },
  {
    name: "generic_portal_heading",
    regex: /^(?:careers?|career\s+opportunities|job\s+openings|open\s+positions|employment\s+opportunities|home|about|about\s+us|contact|contact\s+us|faq|faqs|login|sign\s+in|apply|apply\s+now|benefits|locations|culture|life\s+at\s+.*|working\s+at\s+.*|careers?@.*)$/i,
  },
];

// Exact-match navigation/non-job phrases for raw link validation
const NEGATIVE_NAV_PHRASES = new Set(
  [
    "home",
    "about",
    "about us",
    "contact",
    "contact us",
    "privacy",
    "privacy policy",
    "terms",
    "terms of use",
    "terms of service",
    "cookie policy",
    "cookies",
    "login",
    "log in",
    "sign in",
    "sign up",
    "careers",
    "career",
    "jobs",
    "job search",
    "search",
    "search jobs",
    "apply",
    "apply now",
    "benefits",
    "our benefits",
    "locations",
    "our locations",
    "talent network",
    "talent community",
    "join our talent network",
    "join our talent community",
    "join our team",
    "general application",
    "future opportunities",
    "job alerts",
    "candidate community",
    "diversity",
    "diversity & inclusion",
    "our culture",
    "life at",
    "faq",
    "faqs",
    "help",
    "accessibility",
    "language",
    "select language",
    "english",
    "french",
    "español",
    "spanish",
    // STAGE 25A — skip-navigation link text. Unambiguous at BOTH levels: no real posting link is
    // ever labelled "Skip to content", so this can safely reject a candidate link outright.
    // Observed active in the live corpus: "Skip to content" 35, "Skip to main content" 17,
    // "Skip to Content" 10. Exact-match only.
    "skip to content",
    "skip to main content",
    "skip to navigation",
    "skip navigation",
    "skip to primary content",
  ].map((s) => s.toLowerCase())
);

/**
 * STAGE 25A — phrases that are never a JOB TITLE, but MAY legitimately be the anchor text of a real
 * posting link ("Learn More" pointing at /careers/jobs/software-engineer-482913). They are therefore
 * checked only by validateNormalizedJob, where the string is being asserted as the posting's title —
 * validateJobCandidate's link-level contract (a requisition-shaped URL outweighs generic link text,
 * see its own tests) is deliberately left untouched.
 *
 * Observed active in the live corpus at audit time: "Learn more" 11, "View & Apply" 6,
 * "Get directions" 5, "View Case Study" 4, "Explore opportunities" 3, "Take me there" 3,
 * "READ MORE" 1 — every one of them stored as a job title. Exact-match only, so a real title that
 * merely CONTAINS one of these words ("Read More Media Buyer") is unaffected.
 */
const NON_TITLE_PHRASES = new Set(
  [
    "read more",
    "learn more",
    "explore opportunities",
    "explore opportunity",
    "get directions",
    "take me there",
    "view & apply",
    "view and apply",
    "view all",
    "view case study",
    "view details",
    "view job",
    "view posting",
  ].map((s) => s.toLowerCase())
);

const LOCATION_SIGNAL_PATTERN = /\b(remote|hybrid|on-?site|worldwide|multiple locations)\b|,\s*[A-Z]{2}\b|,\s*[A-Za-z][A-Za-z.\s]{2,}$/i;
const APPLY_ACTION_PATTERN = /\bapply(?:\s+now)?\b|\bview\s+(job|details|posting|opening)\b|\blearn\s+more\b/i;

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function isNegativeNavText(text: string): boolean {
  const norm = normalizeText(text).toLowerCase();
  if (NEGATIVE_NAV_PHRASES.has(norm)) return true;
  return PSEUDO_JOB_TITLE_PATTERNS.some((p) => p.regex.test(norm));
}

function matchesPseudoJobTitle(title: string): string | null {
  const trimmed = normalizeText(title);
  for (const pattern of PSEUDO_JOB_TITLE_PATTERNS) {
    if (pattern.regex.test(trimmed)) {
      return pattern.name;
    }
  }
  return null;
}

/** Titles are almost never a single bare word and are rarely extremely short/long — this is a shape
 *  check, not a semantic one; it only screens out obvious non-titles, never asserts a positive. */
function looksLikeTitleShaped(text: string): boolean {
  const trimmed = normalizeText(text);
  if (trimmed.length < 4 || trimmed.length > 180) return false;
  if (isNegativeNavText(trimmed)) return false;
  return true;
}

function hasRequisitionShapedUrl(url: string): boolean {
  return REQUISITION_ID_PATTERNS.some((pattern) => pattern.test(url));
}

function hasLocationSignal(text: string): boolean {
  return LOCATION_SIGNAL_PATTERN.test(text);
}

function hasApplyActionSignal(text: string): boolean {
  return APPLY_ACTION_PATTERN.test(text);
}

/**
 * STAGE 25A DEFECT. A bare `#fragment` used to count as posting identity, because the guard was
 * `!url.search && !url.hash` — i.e. a root URL was only "without posting identity" when it had
 * NEITHER a query NOR a hash. A same-page anchor is the exact opposite of posting identity, and on
 * the real corpus that let the generic career-page scraper ingest skip-navigation links as jobs:
 * 72 active career_link rows had fragment-only URLs, including 62 titled "Skip to content" /
 * "Skip to main content" (e.g. https://aws.amazon.com/#aws-page-content-main), plus "READ MORE",
 * "Explore opportunities" and "Get directions". Each passed validateNormalizedJob with
 * specific_job_title + valid_job_url and nothing to reject it.
 *
 * Hash-ROUTED postings are still honoured: some boards address a requisition entirely in the
 * fragment (".../careers#/job/R12345"). The distinguisher is whether the fragment itself carries a
 * requisition-shaped identifier, tested with the same REQUISITION_ID_PATTERNS used everywhere else
 * in this module — never a new heuristic, and never a blanket "hashes are bad" rule.
 */
function fragmentCarriesPostingIdentity(url: URL): boolean {
  if (!url.hash || url.hash === "#") return false;
  return REQUISITION_ID_PATTERNS.some((pattern) => pattern.test(url.hash));
}

function isCareersRootUrlWithoutPostingId(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    // Bare domain or root path
    if (!path || path === "") {
      return !url.search && !fragmentCarriesPostingIdentity(url);
    }
    // Generic top-level careers directory with no ID/slug or query
    if (/^\/(?:careers?|jobs?|positions?|openings?)$/i.test(path)) {
      return !url.search && !fragmentCarriesPostingIdentity(url);
    }
    return false;
  } catch {
    return true;
  }
}

function isNavigationOnlyDescription(text: string): boolean {
  const norm = normalizeText(text).toLowerCase();
  if (norm.length < 50) {
    const navWords = ["home", "about", "privacy", "terms", "careers", "contact", "login", "search", "cookies"];
    let matchCount = 0;
    for (const w of navWords) {
      if (norm.includes(w)) matchCount++;
    }
    if (matchCount >= 3) return true;
  }
  return false;
}

/**
 * Validates one raw candidate link (an anchor's href/text/surrounding context) against the
 * positive-evidence model.
 */
export function validateJobCandidate(input: JobValidationInput): JobValidationResult {
  const positiveSignals: string[] = [];
  const negativeSignals: string[] = [];

  if (hasRequisitionShapedUrl(input.url)) positiveSignals.push("requisition_id_shaped_url");

  const titleShaped = looksLikeTitleShaped(input.text);
  const combinedContext = `${input.text} ${input.contextText ?? ""}`;
  const locationSignal = hasLocationSignal(combinedContext);
  const applySignal = hasApplyActionSignal(combinedContext);

  if (titleShaped && locationSignal && applySignal) {
    positiveSignals.push("title_location_apply_combo");
  } else if (titleShaped && locationSignal) {
    positiveSignals.push("title_location_combo");
  }

  if (isNegativeNavText(input.text)) negativeSignals.push("nav_text_exact_match");
  if (!titleShaped) negativeSignals.push("not_title_shaped");
  if (!locationSignal && !applySignal && !hasRequisitionShapedUrl(input.url)) negativeSignals.push("no_supporting_context");

  const blockedByNegative = negativeSignals.includes("nav_text_exact_match");
  const valid = !blockedByNegative && positiveSignals.length > 0;

  const reason = blockedByNegative
    ? "Rejected: exact match against known navigation/non-job text"
    : valid
    ? `Accepted: ${positiveSignals.join(", ")}`
    : "Rejected: no positive evidence found (when uncertain, ingest nothing)";

  return { valid, positiveSignals, negativeSignals, reason };
}

/**
 * Validates a normalized ATS job record across all structured adapters.
 * Proves that the record represents an actual individual job posting rather than a pseudo-job,
 * talent community, general application, or navigation placeholder.
 */
export function validateNormalizedJob(job: NormalizedJob): JobValidationResult {
  const positiveSignals: string[] = [];
  const negativeSignals: string[] = [];

  // --- Title Evidence ---
  const trimmedTitle = job.title ? normalizeText(job.title) : "";
  if (!trimmedTitle) {
    negativeSignals.push("missing_title");
  } else if (trimmedTitle.length < 3) {
    negativeSignals.push("title_too_short");
  } else {
    const pseudoMatch = matchesPseudoJobTitle(trimmedTitle);
    if (pseudoMatch) {
      negativeSignals.push(`pseudo_job_title:${pseudoMatch}`);
    } else if (NEGATIVE_NAV_PHRASES.has(trimmedTitle.toLowerCase()) || NON_TITLE_PHRASES.has(trimmedTitle.toLowerCase())) {
      // STAGE 25A: the two validators disagreed. validateJobCandidate has always rejected an exact
      // navigation phrase (via looksLikeTitleShaped -> isNegativeNavText), but this record-level
      // validator only consulted PSEUDO_JOB_TITLE_PATTERNS, so the same text arriving as a
      // NormalizedJob.title was accepted as a "specific_job_title".
      negativeSignals.push("pseudo_job_title:navigation_phrase");
    } else {
      positiveSignals.push("specific_job_title");
    }
  }

  // --- URL & Posting Identity Evidence ---
  if (!job.url?.trim()) {
    negativeSignals.push("missing_url");
  } else {
    try {
      const parsedUrl = new URL(job.url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        negativeSignals.push("invalid_url_protocol");
      } else if (isCareersRootUrlWithoutPostingId(job.url)) {
        negativeSignals.push("careers_root_url_without_posting_identity");
      } else {
        positiveSignals.push("valid_job_url");
      }
    } catch {
      negativeSignals.push("malformed_url");
    }
  }

  if (job.externalId?.trim()) {
    positiveSignals.push("provider_external_id");
  }
  if (job.url && hasRequisitionShapedUrl(job.url)) {
    positiveSignals.push("requisition_id_shaped_url");
  }

  // --- Description Evidence ---
  const descText = job.descriptionText ? normalizeText(job.descriptionText) : "";
  if (descText) {
    if (isNavigationOnlyDescription(descText)) {
      negativeSignals.push("navigation_only_description");
    } else if (descText.length >= 30) {
      positiveSignals.push("substantive_description");
    }
  }

  // --- Location & Metadata Evidence ---
  if (job.location?.trim()) {
    positiveSignals.push("location_metadata");
  }
  if (job.department?.trim() || job.employmentType?.trim() || job.salaryText?.trim() || job.postedAt?.trim()) {
    positiveSignals.push("employment_metadata");
  }

  const blockedByNegative = negativeSignals.length > 0;
  const hasStrongPostingEvidence =
    positiveSignals.includes("specific_job_title") &&
    (positiveSignals.includes("provider_external_id") ||
      positiveSignals.includes("requisition_id_shaped_url") ||
      positiveSignals.includes("valid_job_url"));

  const valid = !blockedByNegative && hasStrongPostingEvidence;

  const reason = blockedByNegative
    ? `Rejected as non-job: ${negativeSignals.join(", ")}`
    : valid
    ? `Accepted real job: ${positiveSignals.join(", ")}`
    : "Rejected: insufficient posting evidence found";

  return { valid, positiveSignals, negativeSignals, reason };
}

/**
 * Boolean helper returning whether a normalized job record is a genuine individual job opening.
 */
export function isRealJobPosting(job: NormalizedJob): boolean {
  return validateNormalizedJob(job).valid;
}

/**
 * Filter an array of NormalizedJob records to only genuine individual job openings.
 */
export function filterRealJobs(jobs: NormalizedJob[]): NormalizedJob[] {
  return jobs.filter(isRealJobPosting);
}

// --- JSON-LD JobPosting extraction ----------------------------------------------------------------

export interface JsonLdJobPosting {
  title: string;
  url: string | null;
  location: string | null;
  datePosted: string | null;
  descriptionHtml: string | null;
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJsonLdLocation(jobLocation: unknown): string | null {
  const loc = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
  if (!loc || typeof loc !== "object") return null;
  const address = (loc as Record<string, unknown>).address;
  if (!address || typeof address !== "object") return null;
  const a = address as Record<string, unknown>;
  const parts = [a.addressLocality, a.addressRegion, a.addressCountry].filter((p): p is string => typeof p === "string" && p.length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

function collectJobPostings(node: unknown, out: JsonLdJobPosting[]): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  const isJobPosting = type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));

  if (isJobPosting) {
    const title = typeof obj.title === "string" ? obj.title : typeof obj.name === "string" ? obj.name : null;
    const url = typeof obj.url === "string" ? obj.url : null;
    if (title && url) {
      out.push({
        title,
        url,
        location: extractJsonLdLocation(obj.jobLocation),
        datePosted: typeof obj.datePosted === "string" ? obj.datePosted : null,
        descriptionHtml: typeof obj.description === "string" ? obj.description : null,
      });
    }
  }

  // JSON-LD sometimes nests postings under @graph or an ItemList's itemListElement.
  if (Array.isArray(obj["@graph"])) for (const child of obj["@graph"] as unknown[]) collectJobPostings(child, out);
  if (Array.isArray(obj.itemListElement)) for (const child of obj.itemListElement as unknown[]) collectJobPostings(child, out);
}

/** Extracts every JobPosting entry with a usable title+url from a page's <script type="application/
 *  ld+json"> blocks. Entries missing a url are dropped — a job we can't link to isn't ingestible. */
export function extractJsonLdJobPostings(html: string): JsonLdJobPosting[] {
  const results: JsonLdJobPosting[] = [];
  const scriptRe = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) collectJobPostings(item, results);
  }
  return results;
}

export { stripHtmlTags };
