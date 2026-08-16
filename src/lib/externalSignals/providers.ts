import { normalizeGoogleJobsResult, normalizeIndeedResult, type RawGoogleJobsResult, type RawIndeedResult } from "./normalize";
import { FIXTURE_GOOGLE_JOBS_RESULTS, FIXTURE_INDEED_RESULTS } from "./fixtures";
import type { ExternalHiringSignalProvider, NormalizedExternalJob, SearchQuery } from "./types";

/**
 * Whether the RUNNING PROCESS (not this coding session's own tool access) has a real Apify token
 * configured. Stage 7's Phase 4 investigation confirmed both actors below are real, live, and
 * correctly-shaped using the agent's own Apify tool access — but that access does not extend to
 * CareerOps' own deployed code, which can only reach Apify if an operator sets this env var.
 */
export function isLiveProviderConfigured(): boolean {
  return Boolean(process.env.APIFY_API_TOKEN);
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
