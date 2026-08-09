import { MAX_DISCOVERY_DEPTH, MAX_DISCOVERY_PAGES, MAX_REDIRECTS, MAX_RESPONSE_BYTES, DISCOVERY_TIMEOUT_MS } from "@/lib/ats/discoveryConfig";
import { detectAtsFromUrlString } from "@/lib/ats/detect";
import { safeFetch, SafeFetchError, type SafeFetchErrorReason } from "@/lib/net/safeFetch";
import type { CompanyResolutionStatus, SourceType } from "@/types";

/**
 * Bounded company -> career page -> ATS discovery chain (see AGENTS.md §9-13). Root-cause fix for
 * the "branded site hides its ATS behind a second hop" problem: src/lib/ats/detect.ts's
 * detectAtsFromUrl only ever inspects ONE page with an unbounded raw fetch(); this module follows a
 * short, deterministic chain of likely careers/jobs links through safeFetch, revalidating every hop,
 * and never crawls further than discoveryConfig's bounds allow.
 *
 * Reuses detectAtsFromUrlString (Tier 1 of the existing detector) at every hop instead of
 * duplicating provider regexes — this module's only new logic is "which page to look at next" and
 * "is this a job-ish page," not "which ATS is this."
 */

export interface DiscoveryResult {
  status: CompanyResolutionStatus;
  sourceType: Exclude<SourceType, "career_link"> | null;
  atsBoardToken: string | null;
  /** Best known jobs-ish URL: the exact ATS URL when VERIFIED, the deepest successfully-fetched
   *  careers/jobs page when GENERIC_SUPPORTED, otherwise null. Never fabricated. */
  discoveredJobsUrl: string | null;
  reason: string;
  /** Set only for NEEDS_ADAPTER — a recognized-but-unsupported ATS signature. Never guessed. */
  suspectedAts: string | null;
}

// Recognized-but-unsupported ATS URL signatures — informational only (drives NEEDS_ADAPTER +
// suspectedAts for the Companies UI), never scraped or connected to. Deliberately separate from
// detect.ts's SUPPORTED provider regexes (Workday/Greenhouse/Lever/Ashby) — this list must never be
// used to fetch/parse jobs, only to label "this looks like X, no connector yet" honestly instead of
// leaving the company silently UNRESOLVED when we actually recognize the platform.
const UNSUPPORTED_ATS_SIGNATURES: { pattern: RegExp; name: string }[] = [
  { pattern: /jobs\.smartrecruiters\.com/i, name: "SmartRecruiters" },
  { pattern: /\.icims\.com\//i, name: "iCIMS" },
  { pattern: /\.taleo\.net\//i, name: "Taleo" },
  { pattern: /successfactors\.com\//i, name: "SuccessFactors" },
  { pattern: /jobs\.jobvite\.com/i, name: "Jobvite" },
  { pattern: /apply\.workable\.com/i, name: "Workable" },
  { pattern: /[a-z0-9-]+\.bamboohr\.com\/careers/i, name: "BambooHR" },
  { pattern: /breezy\.hr\//i, name: "Breezy HR" },
  { pattern: /recruitee\.com\//i, name: "Recruitee" },
];

// Exported (unlike the rest of this module's private helpers) specifically so
// src/lib/ats/discoveryBrowser.ts (Tier 3, the bounded browser-rendered fallback) can reuse the
// EXACT SAME unsupported-ATS signature list, embedded-URL scanner, and careers-link scorer against
// rendered HTML instead of duplicating this detection logic — the only thing that differs for
// Tier 3 is where the HTML comes from (page.content() after JS execution vs. safeFetch's raw
// response body), never how it's interpreted. See AGENTS.md's "reuse, don't duplicate" precedent.
export function detectUnsupportedAts(text: string): string | null {
  for (const sig of UNSUPPORTED_ATS_SIGNATURES) {
    if (sig.pattern.test(text)) return sig.name;
  }
  return null;
}

const URL_TOKEN_RE = /https?:\/\/[^\s"'<>\\]+/gi;

function trimTrailingPunctuation(url: string): string {
  return url.replace(/[),.;'"]+$/, "");
}

/** Scans every URL-looking token anywhere in the HTML (href/src attributes, inline scripts, plain
 *  text alike) — same "whole-document regex" approach detect.ts's own Tier 2 already uses, just
 *  applied here so the exact matched URL (not only the sourceType) can be recorded. */
export function findEmbeddedAtsUrl(html: string): { sourceType: Exclude<SourceType, "career_link">; atsBoardToken: string; url: string } | null {
  const tokens = html.match(URL_TOKEN_RE) ?? [];
  for (const token of tokens) {
    const trimmed = trimTrailingPunctuation(token);
    const detection = detectAtsFromUrlString(trimmed);
    if (detection) return { ...detection, url: trimmed };
  }
  return null;
}

export function findEmbeddedUnsupportedAtsUrl(html: string): { name: string; url: string } | null {
  const tokens = html.match(URL_TOKEN_RE) ?? [];
  for (const token of tokens) {
    const trimmed = trimTrailingPunctuation(token);
    const name = detectUnsupportedAts(trimmed);
    if (name) return { name, url: trimmed };
  }
  return null;
}

const ANCHOR_RE = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLinks(html: string, baseUrl: string): { url: string; text: string }[] {
  const results: { url: string; text: string }[] = [];
  const re = new RegExp(ANCHOR_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const hrefRaw = match[1];
    if (/^(mailto:|tel:|javascript:|#)/i.test(hrefRaw)) continue;
    let url: string;
    try {
      url = new URL(hrefRaw, baseUrl).toString();
    } catch {
      continue;
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
    results.push({ url, text: stripTags(match[2]) });
  }
  return results;
}

// Deterministic anchor/path signals for "this link probably leads to a jobs listing" — see
// AGENTS.md §11. Multi-word phrases score higher than single generic words so "Search Jobs" beats a
// bare "Jobs" nav link when both are present.
const CAREERS_LINK_SIGNALS: { phrase: string; weight: number }[] = [
  { phrase: "search jobs", weight: 3 },
  { phrase: "view jobs", weight: 3 },
  { phrase: "view openings", weight: 3 },
  { phrase: "open positions", weight: 3 },
  { phrase: "open roles", weight: 3 },
  { phrase: "join our team", weight: 3 },
  { phrase: "join us", weight: 2 },
  { phrase: "opportunities", weight: 2 },
  { phrase: "work with us", weight: 2 },
  { phrase: "careers", weight: 1 },
  { phrase: "career", weight: 1 },
  { phrase: "jobs", weight: 1 },
];

export function scoreCareersLink(link: { url: string; text: string }): number {
  const haystack = `${link.text} ${link.url}`.toLowerCase();
  let score = 0;
  for (const { phrase, weight } of CAREERS_LINK_SIGNALS) {
    if (haystack.includes(phrase)) score += weight;
  }
  return score;
}

/** Highest-scoring distinct link that isn't the page we're already on. Ties break on first
 *  occurrence (HTML document order), a deterministic and reasonable proxy for visual prominence. */
export function findBestCareersLink(html: string, baseUrl: string, excludeUrl: string): string | null {
  const links = extractLinks(html, baseUrl);
  let best: { url: string; score: number } | null = null;
  for (const link of links) {
    if (link.url === excludeUrl) continue;
    const score = scoreCareersLink(link);
    if (score > 0 && (!best || score > best.score)) best = { url: link.url, score };
  }
  return best?.url ?? null;
}

// A hostname that's temporarily unreachable (network blip, DNS hiccup, slow server) is worth
// retrying later; a malformed/disallowed input URL is not — retrying it will never succeed.
const TRANSIENT_SAFE_FETCH_REASONS = new Set<SafeFetchErrorReason>(["timeout", "network_error", "dns_resolution_failed"]);

function verified(sourceType: Exclude<SourceType, "career_link">, atsBoardToken: string, discoveredJobsUrl: string, reason: string): DiscoveryResult {
  return { status: "VERIFIED", sourceType, atsBoardToken, discoveredJobsUrl, reason, suspectedAts: null };
}

function needsAdapter(name: string, discoveredJobsUrl: string, reason: string): DiscoveryResult {
  return { status: "NEEDS_ADAPTER", sourceType: null, atsBoardToken: null, discoveredJobsUrl, reason, suspectedAts: name };
}

/**
 * Runs the bounded discovery chain for one input URL (company homepage, careers page, branded jobs
 * page, or a direct ATS URL). Never throws — every failure mode resolves to a DiscoveryResult with
 * an honest status/reason, since "never silently drop a company because ATS discovery failed" is a
 * hard requirement (AGENTS.md §13).
 */
export interface DiscoverCompanySourceOptions {
  /** Test-only — see safeFetch's identical option. NEVER set true from production call sites. */
  allowPrivateNetworksForTests?: boolean;
}

export async function discoverCompanySource(inputUrl: string, options: DiscoverCompanySourceOptions = {}): Promise<DiscoveryResult> {
  // Tier 1 (existing detect.ts logic, no network): the input URL is itself a known/recognized ATS URL.
  const direct = detectAtsFromUrlString(inputUrl);
  if (direct) return verified(direct.sourceType, direct.atsBoardToken, inputUrl, `Direct ATS URL match (${direct.sourceType})`);

  const directUnsupported = detectUnsupportedAts(inputUrl);
  if (directUnsupported) return needsAdapter(directUnsupported, inputUrl, `Recognized ATS URL pattern with no connector yet: ${directUnsupported}`);

  let currentUrl = inputUrl;
  let pagesFetched = 0;
  let bestKnownJobsUrl: string | null = null;

  for (let depth = 0; depth <= MAX_DISCOVERY_DEPTH; depth++) {
    if (pagesFetched >= MAX_DISCOVERY_PAGES) break;

    let fetched;
    try {
      fetched = await safeFetch(currentUrl, {
        maxRedirects: MAX_REDIRECTS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        timeoutMs: DISCOVERY_TIMEOUT_MS,
        allowPrivateNetworksForTests: options.allowPrivateNetworksForTests,
      });
    } catch (err) {
      if (!(err instanceof SafeFetchError)) throw err;
      if (depth === 0) {
        const status: CompanyResolutionStatus = TRANSIENT_SAFE_FETCH_REASONS.has(err.reason) ? "FAILED_TEMPORARY" : "UNRESOLVED";
        return {
          status,
          sourceType: null,
          atsBoardToken: null,
          discoveredJobsUrl: null,
          reason: `Could not reach ${currentUrl}: ${err.message}`,
          suspectedAts: null,
        };
      }
      // A deeper hop failing just means discovery stops here with whatever was already found —
      // the seed URL itself was reachable, so this is not a "company unreachable" failure.
      break;
    }

    pagesFetched++;

    const finalUrlMatch = detectAtsFromUrlString(fetched.finalUrl);
    if (finalUrlMatch) return verified(finalUrlMatch.sourceType, finalUrlMatch.atsBoardToken, fetched.finalUrl, `Final URL after redirects is a known ATS (${finalUrlMatch.sourceType})`);

    const finalUnsupported = detectUnsupportedAts(fetched.finalUrl);
    if (finalUnsupported) return needsAdapter(finalUnsupported, fetched.finalUrl, `Final URL after redirects matches a recognized-but-unsupported ATS: ${finalUnsupported}`);

    const embeddedAts = findEmbeddedAtsUrl(fetched.bodyText);
    if (embeddedAts) return verified(embeddedAts.sourceType, embeddedAts.atsBoardToken, embeddedAts.url, `Found an embedded ${embeddedAts.sourceType} link on ${fetched.finalUrl}`);

    const embeddedUnsupported = findEmbeddedUnsupportedAtsUrl(fetched.bodyText);
    if (embeddedUnsupported) {
      return needsAdapter(embeddedUnsupported.name, embeddedUnsupported.url, `Found an embedded ${embeddedUnsupported.name} link on ${fetched.finalUrl} — no connector yet`);
    }

    // Only treat this page as a GENERIC_SUPPORTED candidate if we got here via a scored careers/jobs
    // link (depth > 0) or its own URL independently looks jobs-ish — a bare, unscored homepage must
    // never become the fallback target just because nothing better was found (that's UNRESOLVED).
    const looksLikeJobsUrl = depth > 0 || scoreCareersLink({ url: fetched.finalUrl, text: "" }) > 0;
    if (looksLikeJobsUrl) bestKnownJobsUrl = fetched.finalUrl;

    if (depth >= MAX_DISCOVERY_DEPTH || pagesFetched >= MAX_DISCOVERY_PAGES) break;

    const nextLink = findBestCareersLink(fetched.bodyText, fetched.finalUrl, fetched.finalUrl);
    if (!nextLink) break;
    currentUrl = nextLink;
  }

  if (bestKnownJobsUrl) {
    return {
      status: "GENERIC_SUPPORTED",
      sourceType: null,
      atsBoardToken: null,
      discoveredJobsUrl: bestKnownJobsUrl,
      reason: `No known ATS detected; best candidate jobs page found for the generic scraper: ${bestKnownJobsUrl}`,
      suspectedAts: null,
    };
  }

  return {
    status: "UNRESOLVED",
    sourceType: null,
    atsBoardToken: null,
    discoveredJobsUrl: null,
    reason: `Fetched ${inputUrl} but found no ATS link or careers/jobs page within the discovery bounds`,
    suspectedAts: null,
  };
}
