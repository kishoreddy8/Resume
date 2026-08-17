import { normalizeBuiltInResult, normalizeGoogleJobsResult, normalizeIndeedResult, type RawBuiltInResult, type RawGoogleJobsResult, type RawIndeedResult } from "./normalize";
import { FIXTURE_GOOGLE_JOBS_RESULTS, FIXTURE_INDEED_RESULTS } from "./fixtures";
import type { ExternalHiringSignalProvider, NormalizedExternalJob, SearchQuery } from "./types";

/**
 * Stage 8 audit finding, fixed in Stage 9: a source is FREE only if the intended ongoing production
 * mechanism doesn't require payment — credentials existing is not evidence of that. Mirrors the exact
 * existing convention in src/lib/ai/provider.ts's isAiEnabled() (explicit env-var opt-in, checked
 * BEFORE any credential lookup, default OFF) rather than inventing a second configuration framework.
 */
export type ProviderCostClass = "FREE_DIRECT" | "FREE_OFFICIAL_API" | "FREE_BROWSER" | "OPTIONAL_PAID" | "MANUAL_ONLY" | "UNSUPPORTED";

export const PROVIDER_COST_CLASS: Record<"google_jobs" | "indeed" | "built_in", ProviderCostClass> = {
  // Both run through pay-per-result Apify actors (see runActorSync below) — genuinely OPTIONAL_PAID,
  // never the zero-cost default. See Stage 8's audit for the full provider cost survey.
  google_jobs: "OPTIONAL_PAID",
  indeed: "OPTIONAL_PAID",
  // Stage 11: a plain local fetch() against builtin.com's own public pages — no paid scraping
  // service, no Apify, no proxy. Genuinely FREE_DIRECT, and unlike google_jobs/indeed this never
  // checks isLiveProviderConfigured()/CAREER_OPS_ALLOW_PAID_EXTERNAL/APIFY_API_TOKEN at all — there
  // is no paid path here to gate in the first place. See Stage 10's feasibility investigation for
  // why builtin.com specifically (no login, no CAPTCHA, clean schema.org JobPosting on every
  // detail page, direct employer/ATS apply links on the majority of listings sampled).
  built_in: "FREE_DIRECT",
};

/** Deployment-level opt-in for ANY paid external provider — same shape as CAREER_OPS_AI_ENABLED:
 *  absent/anything-but-"true" = disabled, the single safe default. This is a billing decision, not a
 *  per-user preference, so it belongs in process environment configuration, not Settings/SQLite —
 *  exactly where isAiEnabled() already draws that line. */
function isPaidExternalAllowed(): boolean {
  return process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL === "true";
}

/**
 * Whether the RUNNING PROCESS (not this coding session's own tool access) may make a real, billing-
 * capable Apify call right now. BOTH the explicit opt-in AND a token must be present — credentials
 * alone must never enable paid behavior (Stage 8's exact finding). Stage 7's Phase 4 investigation
 * confirmed both actors below are real, live, and correctly-shaped using the agent's own Apify tool
 * access — but that access does not extend to CareerOps' own deployed code, which can only reach
 * Apify if an operator explicitly enables AND configures it.
 */
export function isLiveProviderConfigured(): boolean {
  return isPaidExternalAllowed() && Boolean(process.env.APIFY_API_TOKEN);
}

const APIFY_BASE_URL = "https://api.apify.com/v2";

// Actor IDs verified live during Stage 7 Phase 4 (real bounded probe calls, ~$0.05 total spend):
// borderline/indeed-scraper and johnvc/google-jobs-scraper---pay-per-result. The other Google Jobs
// actor tried first (gio21/google-jobs-scraper) returns MOCK data on the current Apify plan tier —
// deliberately not used here.
const INDEED_ACTOR_ID = "MXLpngmVpE8WTESQr";
const GOOGLE_JOBS_ACTOR_ID = "J0ulz8eoVqej6oqIf";

async function runActorSync(actorId: string, input: Record<string, unknown>): Promise<unknown[]> {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error("APIFY_API_TOKEN not configured");
  const url = `${APIFY_BASE_URL}/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`Apify actor ${actorId} run failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as unknown[];
}

export const indeedProvider: ExternalHiringSignalProvider = {
  source: "indeed",
  async search(query: SearchQuery): Promise<unknown[]> {
    if (!isLiveProviderConfigured()) return FIXTURE_INDEED_RESULTS;
    return runActorSync(INDEED_ACTOR_ID, {
      query: query.role,
      location: query.location ?? "United States",
      country: "us",
      maxRows: Math.max(1, Math.min(query.limit ?? 10, 50)),
      sort: "date",
    });
  },
  normalize(rawResult: unknown): NormalizedExternalJob {
    return normalizeIndeedResult(rawResult as RawIndeedResult);
  },
};

export const googleJobsProvider: ExternalHiringSignalProvider = {
  source: "google_jobs",
  async search(query: SearchQuery): Promise<unknown[]> {
    if (!isLiveProviderConfigured()) return FIXTURE_GOOGLE_JOBS_RESULTS;
    // This actor's num_results has a provider-enforced minimum of 10 regardless of what's requested.
    return runActorSync(GOOGLE_JOBS_ACTOR_ID, {
      query: query.role,
      location: query.location ?? "United States",
      country: "us",
      num_results: Math.max(10, Math.min(query.limit ?? 10, 100)),
    });
  },
  normalize(rawResult: unknown): NormalizedExternalJob {
    return normalizeGoogleJobsResult(rawResult as RawGoogleJobsResult);
  },
};

// --- Built In (public builtin.com pages — FREE_DIRECT, Stage 11) ---------------------------------
// A plain local fetch() against builtin.com's own public search/detail pages. No Apify, no paid
// service, no isLiveProviderConfigured()/fixture-fallback gate at all — this always makes a real,
// bounded HTTP request, matching Stage 10's confirmed feasibility (no login, no CAPTCHA).

const BUILT_IN_ORIGIN = "https://builtin.com";
/** Every bound below is deliberately small and independent of the caller's requested limit —
 *  Section 14's "sensible bounds... no infinite pagination... no recursive crawling" requirement.
 *  Never fetches a second search-results page. */
const BUILT_IN_MAX_RESULTS = 20;
const BUILT_IN_DETAIL_CONCURRENCY = 3;
const BUILT_IN_SEARCH_TIMEOUT_MS = 15_000;
const BUILT_IN_DETAIL_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { Accept: "text/html" }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface BuiltInListItem {
  name: string;
  url: string;
}

/** Decodes the small, fixed set of HTML entities builtin.com uses inside HTML attribute values (e.g.
 *  "&amp;" between query-string params on the Apply link) — without this, the extracted URL is
 *  malformed. Deterministic decode of known named/numeric entities only; never guesses. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

/** Parses the search-results page's own schema.org ItemList (@graph -> ItemList -> itemListElement)
 *  — the exact structure confirmed live during Stage 10. Never throws on a malformed/missing block;
 *  an empty result here just means zero candidates for this search, not a fatal error. */
export function parseBuiltInSearchResults(html: string): BuiltInListItem[] {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld(?:\+|&#x2B;|&#43;)json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1]) as { "@graph"?: Array<Record<string, unknown>> };
      const itemList = parsed["@graph"]?.find((node) => node["@type"] === "ItemList");
      const elements = itemList?.itemListElement;
      if (!Array.isArray(elements)) continue;
      return elements
        .map((el) => ({ name: String((el as Record<string, unknown>).name ?? ""), url: String((el as Record<string, unknown>).url ?? "") }))
        .filter((item) => item.name && item.url);
    } catch {
      continue;
    }
  }
  return [];
}

/** Parses one job-detail page: the schema.org JobPosting JSON-LD (@graph -> JobPosting) plus the
 *  Apply button's raw href, extracted from the surrounding HTML exactly as observed in Stage 10
 *  ('<a href="...">... @click="applyClick"'). Never fabricates a field; anything not present on the
 *  real page is left undefined, matching Section 4's "do not fabricate missing values." */
export function parseBuiltInDetailPage(html: string, listingUrl: string): RawBuiltInResult | null {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld(?:\+|&#x2B;|&#43;)json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let posting: Record<string, unknown> | null = null;
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1]) as { "@graph"?: Array<Record<string, unknown>> };
      const found = parsed["@graph"]?.find((node) => node["@type"] === "JobPosting");
      if (found) {
        posting = found;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!posting) return null;

  const identifier = posting.identifier as { value?: unknown } | undefined;
  const hiringOrganization = posting.hiringOrganization as { name?: unknown } | undefined;
  const jobLocation = posting.jobLocation as { address?: Record<string, unknown> } | undefined;
  const address = jobLocation?.address;
  const baseSalary = posting.baseSalary as { value?: { minValue?: unknown; maxValue?: unknown; unitText?: unknown } } | undefined;
  const salaryValue = baseSalary?.value;
  const baseSalaryText = salaryValue?.minValue
    ? `$${Number(salaryValue.minValue).toLocaleString()}${salaryValue.maxValue && salaryValue.maxValue !== salaryValue.minValue ? ` - $${Number(salaryValue.maxValue).toLocaleString()}` : ""}`
    : undefined;

  const applyMatch = html.match(/<a href="(https?:\/\/[^"]+)"[^>]*@click="applyClick"/);

  return {
    identifierValue: identifier?.value !== undefined ? String(identifier.value) : undefined,
    title: typeof posting.title === "string" ? posting.title : undefined,
    hiringOrganizationName: typeof hiringOrganization?.name === "string" ? hiringOrganization.name : undefined,
    datePosted: typeof posting.datePosted === "string" ? posting.datePosted : undefined,
    description: typeof posting.description === "string" ? posting.description : undefined,
    addressLocality: typeof address?.addressLocality === "string" ? address.addressLocality : undefined,
    addressRegion: typeof address?.addressRegion === "string" ? address.addressRegion : undefined,
    addressCountry: typeof address?.addressCountry === "string" ? address.addressCountry : undefined,
    jobLocationType: typeof posting.jobLocationType === "string" ? posting.jobLocationType : undefined,
    employmentType: typeof posting.employmentType === "string" ? posting.employmentType : undefined,
    baseSalaryText,
    listingUrl,
    // href attribute values are HTML-attribute-encoded on the page (e.g. "&amp;" between query
    // params) — decode so the extracted URL is actually usable, not fabricated content.
    applyHref: applyMatch?.[1] ? decodeHtmlEntities(applyMatch[1]) : undefined,
  };
}

export const builtInProvider: ExternalHiringSignalProvider = {
  source: "built_in",
  async search(query: SearchQuery): Promise<unknown[]> {
    const limit = Math.max(1, Math.min(query.limit ?? 10, BUILT_IN_MAX_RESULTS));
    const searchUrl = new URL("/jobs", BUILT_IN_ORIGIN);
    searchUrl.searchParams.set("search", query.role);
    searchUrl.searchParams.set("country", "USA");
    // Optimization only, never a substitute for the mandatory local <=20-day check every result
    // still goes through in classify.ts (see CANONICAL_INGESTION_MAX_AGE_DAYS).
    searchUrl.searchParams.set("daysSinceUpdated", "20");

    let searchHtml: string;
    try {
      const res = await fetchWithTimeout(searchUrl.toString(), BUILT_IN_SEARCH_TIMEOUT_MS);
      if (!res.ok) return [];
      searchHtml = await res.text();
    } catch {
      // A failed search request yields zero external candidates for this role — never throws, so a
      // Built In outage can never abort the caller's broader multi-role search loop.
      return [];
    }

    const items = parseBuiltInSearchResults(searchHtml).slice(0, limit);
    const results: RawBuiltInResult[] = [];
    let index = 0;
    async function worker() {
      while (index < items.length) {
        const item = items[index++];
        try {
          const res = await fetchWithTimeout(item.url, BUILT_IN_DETAIL_TIMEOUT_MS);
          if (!res.ok) continue;
          const detailHtml = await res.text();
          const parsed = parseBuiltInDetailPage(detailHtml, item.url);
          // One broken/unparseable listing must never abort the batch (Section 14) — just skipped.
          if (parsed) results.push(parsed);
        } catch {
          continue;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(BUILT_IN_DETAIL_CONCURRENCY, items.length || 1) }, worker));
    return results;
  },
  normalize(rawResult: unknown): NormalizedExternalJob {
    return normalizeBuiltInResult(rawResult as RawBuiltInResult);
  },
};

export function getProvider(source: "google_jobs" | "indeed" | "built_in"): ExternalHiringSignalProvider {
  if (source === "indeed") return indeedProvider;
  if (source === "built_in") return builtInProvider;
  return googleJobsProvider;
}
