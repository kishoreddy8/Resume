import pLimit from "p-limit";
import { extractSalaryText } from "@/lib/extractSalary";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { classifyJobLocation } from "@/lib/jobLocationScope";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface PaycomPreview {
  jobId: number;
  jobTitle: string;
  positionType?: string | null;
  remoteType?: string | null;
  locations?: string | null;
  postedOn?: string | null;
}

interface PaycomPreviewResponse {
  jobPostingPreviews?: PaycomPreview[];
  jobPostingPreviewsCount?: number;
}

interface PaycomJobPosting {
  jobId: number;
  jobTitle: string;
  location?: string | null;
  secondaryLocations?: string[];
  remoteType?: string | null;
  salaryRange?: string | null;
  startDate?: string | null;
  positionType?: string | null;
  jobCategory?: string | null;
  description?: string | null;
  qualifications?: string | null;
}

export interface FetchPaycomJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only board origin. The embedded API origin must match this value in tests. */
  hostOverride?: string;
  detailConcurrency?: number;
}

const PAGE_SIZE = 50;
const publicRequestLimit = pLimit(3);

export function normalizePaycomClientKey(value: string): string {
  const key = value.trim().toUpperCase();
  if (!/^[A-F0-9]{32}$/.test(key)) throw new Error("Invalid Paycom client key");
  return key;
}

export function canonicalPaycomUrl(clientKey: string): string {
  return `https://www.paycomonline.net/v4/ats/web.php/jobs?clientkey=${normalizePaycomClientKey(clientKey)}`;
}

function sessionConfig(html: string, boardUrl: string, hostOverride?: string): { token: string; apiOrigin: string } {
  const match = html.match(/var\s+configsFromHost\s*=\s*(\{[\s\S]*?\});/);
  if (!match) throw new Error("Paycom public board is missing its anonymous session configuration");
  let config: { sessionJWT?: string; libConfig?: string };
  try {
    config = JSON.parse(match[1]);
  } catch {
    throw new Error("Paycom anonymous session configuration is malformed");
  }
  if (!config.sessionJWT || !config.libConfig) throw new Error("Paycom public board did not issue an anonymous session token");
  let apiOrigin: string;
  try {
    const lib = JSON.parse(config.libConfig) as { atsPortalMantleServiceUrl?: string };
    apiOrigin = new URL(lib.atsPortalMantleServiceUrl ?? "").toString();
  } catch {
    throw new Error("Paycom public board returned an invalid API origin");
  }
  const api = new URL(apiOrigin);
  if (hostOverride) {
    if (api.origin !== new URL(hostOverride).origin) throw new Error("Paycom test API origin did not match the board origin");
  } else if (api.protocol !== "https:" || api.hostname !== "portal-applicant-tracking.us-cent.paycomonline.net") {
    throw new Error(`Paycom public board returned an untrusted API origin for ${boardUrl}`);
  }
  return { token: config.sessionJWT, apiOrigin: apiOrigin.replace(/\/$/, "") };
}

function listingJob(clientKey: string, preview: PaycomPreview): NormalizedJob {
  return {
    externalId: String(preview.jobId),
    title: preview.jobTitle,
    location: preview.locations?.trim() || null,
    department: null,
    url: `${canonicalPaycomUrl(clientKey)}#!/jobs/${preview.jobId}`,
    descriptionHtml: null,
    descriptionText: "",
    employmentType: preview.positionType?.trim() || null,
    workplaceType: preview.remoteType?.trim() || null,
    salaryText: null,
    postedAt: preview.postedOn?.trim() || null,
    raw: preview,
  };
}

function enoughBoundedJobs(previews: PaycomPreview[], maxJobs: number | undefined, usOnly: boolean | undefined): boolean {
  if (!maxJobs) return false;
  if (!usOnly) return previews.length >= maxJobs;
  return previews.reduce((count, preview) => count + (classifyJobLocation(preview.locations) === "US" ? 1 : 0), 0) >= maxJobs;
}

/** Paycom issues a short-lived anonymous token from each public client-key board. Listing requests
 * use explicit skip/take pagination and an exact count. Production exhausts that count; U.S.
 * filtering happens before selected full-detail calls. */
export async function fetchPaycomJobs(
  clientKeyValue: string,
  options: FetchPaycomJobsOptions = {}
): Promise<NormalizedJob[]> {
  const clientKey = normalizePaycomClientKey(clientKeyValue);
  const {
    hostOverride,
    maxJobs,
    detailConcurrency = 3,
    usOnly,
    existingExternalIds,
    onLocationFiltered,
    ...retryOptions
  } = options;
  const boardOrigin = (hostOverride ?? "https://www.paycomonline.net").replace(/\/$/, "");
  const boardUrl = `${boardOrigin}/v4/ats/web.php/jobs?clientkey=${clientKey}`;
  const boardResponse = await fetchWithRetry(boardUrl, { headers: { Accept: "text/html" } }, retryOptions);
  const session = sessionConfig(await boardResponse.text(), boardUrl, hostOverride);
  const headers = {
    Authorization: session.token,
    Locale: "en-US",
    "Translation-Highlights": "false",
    "Portal-Host-Referrer": boardUrl,
    "Content-Type": "application/json",
  };
  const previews: PaycomPreview[] = [];
  const seenIds = new Set<number>();
  let expectedTotal = Number.POSITIVE_INFINITY;

  for (let skip = 0; skip < expectedTotal; skip += PAGE_SIZE) {
    const listUrl = `${session.apiOrigin}/api/ats/job-posting-previews/search`;
    const body = {
      skip,
      take: PAGE_SIZE,
      filtersForQuery: {
        distanceFrom: 0, workEnvironments: [], positionTypes: [], educationLevels: [], categories: [],
        travelTypes: [], shiftTypes: [], otherFilters: [], keywordSearchText: "", location: "", sortOption: "",
      },
    };
    const response = await fetchWithRetry(listUrl, { method: "POST", headers, body: JSON.stringify(body) }, retryOptions);
    const data = await parseJsonOrThrow<PaycomPreviewResponse>(response, listUrl);
    if (!Array.isArray(data.jobPostingPreviews) || !Number.isInteger(data.jobPostingPreviewsCount)) {
      throw new Error("Paycom listing response is missing previews or exact count");
    }
    if (!Number.isFinite(expectedTotal)) expectedTotal = data.jobPostingPreviewsCount!;
    else if (data.jobPostingPreviewsCount !== expectedTotal) throw new Error("Paycom listing count changed during the scan");
    for (const preview of data.jobPostingPreviews) {
      if (!Number.isInteger(preview.jobId) || !preview.jobTitle?.trim() || seenIds.has(preview.jobId)) continue;
      seenIds.add(preview.jobId);
      previews.push(preview);
    }
    if (enoughBoundedJobs(previews, maxJobs, usOnly)) break;
    if (data.jobPostingPreviews.length === 0 && previews.length < expectedTotal) {
      throw new Error(`Paycom listing stopped early: expected ${expectedTotal}, received ${previews.length}`);
    }
  }
  if (!maxJobs && previews.length !== expectedTotal) {
    throw new Error(`Paycom listing is incomplete: expected ${expectedTotal}, received ${previews.length}`);
  }
  const selected = filterJobsToUs(previews.map((preview) => listingJob(clientKey, preview)),
    { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const perCallLimit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 5)));
  return Promise.all(selected.map((listing) => {
    if (listing.lifecycleOnly) return listing;
    return perCallLimit(() => publicRequestLimit(async (): Promise<NormalizedJob> => {
      const detailUrl = `${session.apiOrigin}/api/ats/job-postings/${listing.externalId}`;
      const response = await fetchWithRetry(detailUrl, { headers }, retryOptions);
      const data = await parseJsonOrThrow<{ jobPosting?: PaycomJobPosting }>(response, detailUrl);
      const detail = data.jobPosting;
      if (!detail || String(detail.jobId) !== listing.externalId) throw new Error(`Paycom job ${listing.externalId} detail identity did not match`);
      const descriptionHtml = [detail.description, detail.qualifications].map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)).join("\n");
      if (!descriptionHtml) throw new Error(`Paycom job ${listing.externalId} has no full description`);
      const descriptionText = stripHtml(descriptionHtml);
      const locations = [detail.location, ...(detail.secondaryLocations ?? [])].filter((value): value is string => Boolean(value?.trim()));
      return {
        ...listing,
        title: detail.jobTitle?.trim() || listing.title,
        location: locations.length ? [...new Set(locations)].join("; ") : listing.location,
        department: detail.jobCategory?.trim() || null,
        descriptionHtml,
        descriptionText,
        employmentType: detail.positionType?.trim() || listing.employmentType,
        workplaceType: detail.remoteType?.trim() || listing.workplaceType,
        salaryText: detail.salaryRange?.trim() || extractSalaryText(descriptionText),
        postedAt: detail.startDate?.trim() || listing.postedAt,
        raw: { listing: listing.raw, detail },
      };
    }));
  }));
}
