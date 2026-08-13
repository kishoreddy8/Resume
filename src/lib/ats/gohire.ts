import pLimit from "p-limit";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface GoHireListing {
  id: number;
  title: string;
  location: string;
  salary?: string | null;
  type?: string | null;
  date?: string | null;
}

interface GoHireListingResponse { jobs: GoHireListing[] }
interface GoHireDetail {
  id: number;
  title: string;
  description: string;
  city?: string | null;
  county?: string | null;
  country?: { code?: string | null; name?: string | null } | null;
  type?: { name?: string | null } | null;
  salary?: string | null;
  client?: { id?: number | null; name?: string | null } | null;
}

export interface FetchGoHireJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  listingOrigin?: string;
  detailOrigin?: string;
  detailConcurrency?: number;
}

export function normalizeGoHireToken(value: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9]{8}$/.test(token)) throw new Error("Invalid GoHire client hash");
  return token;
}

export function canonicalGoHireUrl(value: string): string {
  return `https://widget.gohire.io/widget/${normalizeGoHireToken(value)}`;
}

function parseDate(value?: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(`${value} 00:00:00 UTC`);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseListingPayload(payload: unknown, token: string): NormalizedJob[] {
  const response = payload as Partial<GoHireListingResponse>;
  if (!Array.isArray(response.jobs)) throw new Error("GoHire listing did not return a complete jobs array");
  const seen = new Set<string>();
  return response.jobs.map((listing) => {
    const externalId = String(listing.id);
    if (!/^\d+$/.test(externalId) || !listing.title?.trim() || !listing.location?.trim() || seen.has(externalId)) {
      throw new Error("GoHire listing has a duplicate ID or missing title/location");
    }
    seen.add(externalId);
    return {
      externalId,
      title: listing.title.trim(),
      location: listing.location.trim(),
      department: null,
      url: `https://app.gohire.io/widget/${token}/${externalId}`,
      descriptionHtml: null,
      descriptionText: "",
      employmentType: listing.type?.trim() || null,
      workplaceType: /\bremote\b/i.test(listing.location) ? "Remote" : null,
      salaryText: listing.salary?.trim() || null,
      postedAt: parseDate(listing.date),
      raw: listing,
    } satisfies NormalizedJob;
  });
}

function parseDetail(payload: unknown, listingJob: NormalizedJob): NormalizedJob {
  const detail = payload as Partial<GoHireDetail>;
  if (String(detail.id) !== listingJob.externalId || !detail.client?.id || !detail.client.name?.trim()
    || !detail.title?.trim() || detail.title.trim() !== listingJob.title || !detail.description?.trim()) {
    throw new Error(`GoHire job ${listingJob.externalId} has mismatched client/job identity or no full description`);
  }
  const descriptionHtml = detail.description.trim();
  const descriptionText = stripHtml(descriptionHtml);
  if (!descriptionText) throw new Error(`GoHire job ${listingJob.externalId} has an empty description`);
  const structuredLocation = [detail.city, detail.county, detail.country?.name].filter(Boolean).join(", ");
  return {
    ...listingJob,
    title: detail.title.trim(),
    location: structuredLocation || listingJob.location,
    descriptionHtml,
    descriptionText,
    employmentType: detail.type?.name?.trim() || listingJob.employmentType,
    salaryText: detail.salary?.trim() || listingJob.salaryText,
    raw: { listing: listingJob.raw, detail: { ...detail, description: undefined } },
  };
}

/** GoHire returns the complete tenant job array in one public listing response. U.S. filtering is
 * applied before the exact client-hash/job-ID detail endpoint is requested. */
export async function fetchGoHireJobs(tokenValue: string, options: FetchGoHireJobsOptions = {}): Promise<NormalizedJob[]> {
  const token = normalizeGoHireToken(tokenValue);
  const { maxJobs, listingOrigin = "https://api2.gohire.io", detailOrigin = "https://api.gohire.io",
    detailConcurrency = 5, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const headers = { Accept: "application/json", "User-Agent": "Mozilla/5.0" };
  const response = await fetchWithRetry(`${listingOrigin.replace(/\/$/, "")}/widget-jobs/${token}?remoteDdValue=&typeDdValue=`, { headers }, retryOptions);
  const jobs = parseListingPayload(await response.json(), token);
  const selected = filterJobsToUs(jobs, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const limit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  return Promise.all(selected.map((job) => job.lifecycleOnly ? job : limit(async () => {
    const detail = await fetchWithRetry(`${detailOrigin.replace(/\/$/, "")}/widget-job?clientHash=${token}&jobId=${job.externalId}`, { headers }, retryOptions);
    return parseDetail(await detail.json(), job);
  })));
}
