/**
 * Positive-evidence job-candidate validation for the generic (non-ATS) career-page scraper — see
 * AGENTS.md §15/§16. The bug this replaces: genericPlaywright.ts's old fallback treated any link
 * whose text didn't EXACTLY match one of ~10 blocklisted nav words as a job — "Jobs By Business
 * Area", "MyDisneyCareer", "French", "Privacy", "Benefits", "Locations", "Talent Network" all sailed
 * through. A bigger blocklist can never be complete (it's an open-ended, company-specific set of
 * navigation labels); it isn't the fix.
 *
 * The fix: require genuine POSITIVE evidence that a candidate is an actual job posting before
 * accepting it at all. When no positive evidence is found, the candidate is rejected — "when
 * uncertain, ingest nothing" (a missed real job is recoverable; a fabricated fake job silently
 * pollutes the database).
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

// Requisition-ID-shaped URL/token — the strongest link-level positive signal, since a real ATS-style
// or requisition-tracked posting URL is expensive for a nav link to accidentally resemble.
const REQUISITION_ID_PATTERNS: RegExp[] = [
  /[?&](gh_jid|req(?:uisition)?[_-]?id|job[_-]?id|jid|jobid|posting[_-]?id)=[a-z0-9-]+/i,
  /\/(jobs?|careers?|positions?|openings?|postings?|roles?)\/[a-z0-9-]*\d{3,}(?:[/?#]|$)/i,
  /\/(jobs?|careers?|positions?|openings?|postings?|roles?)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /-req-?\d{3,}/i,
  /(?<![A-Za-z0-9])R-?\d{4,}\b/, // Workday-style requisition numbers, e.g. R1559, R-1559, Title_R1559
];

// Exact-match navigation/non-job phrases — kept intentionally small. This is a confidence booster
// and an always-disqualifying override, NOT the primary gate (see the module doc comment above for
// why an exhaustive blocklist is the wrong approach).
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
  ].map((s) => s.toLowerCase())
);

const LOCATION_SIGNAL_PATTERN = /\b(remote|hybrid|on-?site|worldwide|multiple locations)\b|,\s*[A-Z]{2}\b|,\s*[A-Za-z][A-Za-z.\s]{2,}$/i;
const APPLY_ACTION_PATTERN = /\bapply(?:\s+now)?\b|\bview\s+(job|details|posting|opening)\b|\blearn\s+more\b/i;

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function isNegativeNavText(text: string): boolean {
  return NEGATIVE_NAV_PHRASES.has(normalizeText(text).toLowerCase());
}

/** Titles are almost never a single bare word and are rarely extremely short/long — this is a shape
 *  check, not a semantic one; it only screens out obvious non-titles, never asserts a positive. */
function looksLikeTitleShaped(text: string): boolean {
  const trimmed = normalizeText(text);
  if (trimmed.length < 6 || trimmed.length > 120) return false;
  if (isNegativeNavText(trimmed)) return false;
  const wordCount = trimmed.split(" ").filter(Boolean).length;
  return wordCount >= 2;
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
 * Validates one candidate (an anchor's href/text/surrounding context) against the positive-evidence
 * model. `valid: true` requires at least one real positive signal AND no exact nav-phrase match —
 * absence of evidence is a rejection, never a coin-flip acceptance.
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

// --- JSON-LD JobPosting extraction — the strongest possible signal when present -----------------
// Structured data a page publishes about itself for search-engine job indexing; when it's there, it
// is authoritative and needs no anchor-text heuristics at all.

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
