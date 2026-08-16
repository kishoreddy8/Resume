import { normalizeGoogleJobsResult, normalizeIndeedResult, type RawGoogleJobsResult, type RawIndeedResult } from "./normalize";
import { FIXTURE_GOOGLE_JOBS_RESULTS, FIXTURE_INDEED_RESULTS } from "./fixtures";
import type { ExternalHiringSignalProvider, NormalizedExternalJob, SearchQuery } from "./types";

/**
 * Stage 8 audit finding, fixed in Stage 9: a source is FREE only if the intended ongoing production
 * mechanism doesn't require payment — credentials existing is not evidence of that. Mirrors the exact
 * existing convention in src/lib/ai/provider.ts's isAiEnabled() (explicit env-var opt-in, checked
 * BEFORE any credential lookup, default OFF) rather than inventing a second configuration framework.
 */
export type ProviderCostClass = "FREE_DIRECT" | "FREE_OFFICIAL_API" | "FREE_BROWSER" | "OPTIONAL_PAID" | "MANUAL_ONLY" | "UNSUPPORTED";

export const PROVIDER_COST_CLASS: Record<"google_jobs" | "indeed", ProviderCostClass> = {
  // Both run through pay-per-result Apify actors (see runActorSync below) — genuinely OPTIONAL_PAID,
  // never the zero-cost default. See Stage 8's audit for the full provider cost survey.
  google_jobs: "OPTIONAL_PAID",
  indeed: "OPTIONAL_PAID",
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

export function getProvider(source: "google_jobs" | "indeed"): ExternalHiringSignalProvider {
  return source === "indeed" ? indeedProvider : googleJobsProvider;
}
