import crypto from "node:crypto";
import type { NormalizedJob, SourceType } from "@/types";

/**
 * Identity precedence for job deduplication (see AGENTS.md's Dedup & Repost Hardening task):
 *   1. provider + external job ID       -> dedupeKeyForAts (ATS-sourced postings always have one)
 *   2. canonical job URL                -> dedupeKeyForCareerLink, tier "url"
 *   3. company + normalized title + normalized location + reliable posting date
 *                                        -> dedupeKeyForCareerLink, tier "ld"
 *   4. conservative stable content fingerprint -> dedupeKeyForCareerLink, tier "fp"
 * Tier 1 never falls back to a lower tier when an external ID is present — a provider's own job ID
 * is authoritative on its own, so a changed title/location/description on the same external ID is
 * always a refresh, and a different external ID is always a new requisition (see upsertJob).
 */

export function dedupeKeyForAts(sourceType: SourceType, companyId: number, externalId: string): string {
  return `${sourceType}:${companyId}:${externalId}`;
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 24);
}

// --- URL canonicalization -------------------------------------------------------------------
// Blocklist, not an allowlist: an unrecognized query param is assumed to be identity-bearing
// (Greenhouse's gh_jid on an embed URL, a requisition id, a slug variant) and is kept rather than
// stripped, per "strip tracking parameters without removing parameters required to identify the
// job." Only well-known analytics/attribution params are stripped.
const TRACKING_PARAM_EXACT = new Set([
  "gclid", "fbclid", "msclkid", "dclid", "twclid", "yclid", "igshid",
  "mc_cid", "mc_eid", "ref", "referrer", "referer", "source", "src", "trk",
  "si", "spm", "click_id", "clickid", "_hsenc", "_hsmi", "wickedid", "icid",
  "mkt_tok", "campaignid", "adgroupid", "gad_source", "gbraid", "wbraid",
]);
const TRACKING_PARAM_PREFIXES = ["utm_", "_ga", "_gl"];

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  return TRACKING_PARAM_EXACT.has(lower) || TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p));
}

interface CanonicalUrl {
  canonical: string;
  pathname: string;
}

/**
 * Canonicalizes a job URL for identity purposes: lowercases scheme/host, drops the fragment,
 * strips a trailing slash, strips known tracking params, and sorts the remaining query params for
 * stable ordering regardless of the order the page/API emitted them in. Falls back to a
 * trimmed/lowercased copy of the raw string when it isn't a parseable absolute URL — dedupe must
 * degrade gracefully on a malformed link, never throw and take down a scan.
 */
export function canonicalizeJobUrl(rawUrl: string): CanonicalUrl {
  try {
    const parsed = new URL(rawUrl);
    const kept = Array.from(parsed.searchParams.entries()).filter(([key]) => !isTrackingParam(key));
    kept.sort(([a], [b]) => a.localeCompare(b));
    const query = kept.length > 0 ? `?${kept.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}` : "";
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return { canonical: `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${query}`, pathname };
  } catch {
    const trimmed = rawUrl.trim().toLowerCase();
    return { canonical: trimmed, pathname: trimmed };
  }
}

/** Canonical URL string only — used wherever a full identity tuple isn't needed (e.g. the ATS
 *  externalId-missing fallback in src/lib/scan.ts). */
export function normalizeJobUrl(rawUrl: string): string {
  return canonicalizeJobUrl(rawUrl).canonical;
}

// A path with no job-specific segment (the career page root, or a generic landing section like
// "/careers") can't anchor identity on its own — unrelated postings could easily share it, so it's
// treated as "no reliable URL identity" and pushed down to tiers 3/4 instead.
const GENERIC_PATH_PATTERNS = [
  /^\/?$/,
  /^\/(careers?|jobs?|openings?|positions?|opportunities|join-us|work-with-us|about|company)\/?$/i,
];

function isGenericPath(pathname: string): boolean {
  return GENERIC_PATH_PATTERNS.some((re) => re.test(pathname));
}

// --- Title/location normalization for the lower identity tiers ------------------------------
function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type CareerLinkIdentityInput = Pick<NormalizedJob, "title" | "url" | "location" | "postedAt" | "descriptionText">;

/**
 * Identity for career_link (generic career-page scrape) postings, which never carry a
 * provider-issued external ID. Tries tiers 2-4 in order; see the module doc comment above.
 */
export function dedupeKeyForCareerLink(companyId: number, job: CareerLinkIdentityInput): string {
  const { canonical, pathname } = canonicalizeJobUrl(job.url);

  // Tier 2: the canonical URL is specific enough to be a reliable per-job identifier on its own.
  // This is what makes tracking-parameter variants of the same link (utm_*, gclid, a referral
  // source tag, ...) resolve to the same identity instead of duplicating.
  if (!isGenericPath(pathname)) {
    return `career_link:${companyId}:url:${sha256Hex(canonical)}`;
  }

  // Tier 3: company + normalized title + normalized location + a reliable posting date. Not
  // reachable with today's generic scraper (src/lib/ats/genericPlaywright.ts never populates
  // location/postedAt), but kept as a real code path — not dead code, since a future career-page
  // scraper that captures those fields activates it automatically without another dedupe.ts change.
  if (job.location && job.postedAt) {
    const key = [companyId, normalizeText(job.title), normalizeText(job.location), job.postedAt].join("|");
    return `career_link:${companyId}:ld:${sha256Hex(key)}`;
  }

  // Tier 4: conservative content fingerprint. Combines every signal actually available — never
  // title alone — so two unrelated postings that happen to share a title, or share a generic
  // landing-page URL, are not merged.
  const fingerprint = [
    normalizeText(job.title),
    job.location ? normalizeText(job.location) : "",
    job.descriptionText ? normalizeText(job.descriptionText).slice(0, 500) : "",
    canonical,
  ].join("|");
  return `career_link:${companyId}:fp:${sha256Hex(fingerprint)}`;
}
