import pLimit from "p-limit";
import { extractSalaryText } from "@/lib/extractSalary";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface BambooLocation { country?: string | null; state?: string | null; city?: string | null }
interface BambooListing {
  id: string;
  jobOpeningName: string;
  departmentLabel?: string | null;
  employmentStatusLabel?: string | null;
  employmentType?: string | null;
  location?: { city?: string | null; state?: string | null } | null;
  atsLocation?: BambooLocation | null;
  isRemote?: boolean | null;
}
interface BambooDetail extends BambooListing {
  jobOpeningShareUrl?: string;
  description?: string | null;
  compensation?: string | null;
  datePosted?: string | null;
  locationType?: string | null;
}
interface BambooResponse<T> { meta?: { totalCount?: number }; result?: T }

export interface FetchBambooHrJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production uses the tenant's BambooHR host. */
  hostOverride?: string;
  detailConcurrency?: number;
}

const publicRequestLimit = pLimit(5);

export function normalizeBambooHrTenant(value: string): string {
  const tenant = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(tenant)) throw new Error("Invalid BambooHR tenant");
  return tenant;
}

export function canonicalBambooHrUrl(tenant: string): string {
  return `https://${normalizeBambooHrTenant(tenant)}.bamboohr.com/careers`;
}

function locationText(job: BambooListing): string | null {
  const location = job.atsLocation;
  const parts = [location?.city, location?.state, location?.country]
    .filter((value): value is string => Boolean(value?.trim()));
  if (parts.length > 0) return parts.join(", ");
  const fallback = [job.location?.city, job.location?.state]
    .filter((value): value is string => Boolean(value?.trim()));
  return fallback.length > 0 ? fallback.join(", ") : job.isRemote ? "Remote" : null;
}

function listingJob(job: BambooListing, tenant: string): NormalizedJob {
  return {
    externalId: String(job.id),
    title: job.jobOpeningName,
    location: locationText(job),
    department: job.departmentLabel?.trim() || null,
    url: `https://${tenant}.bamboohr.com/careers/${encodeURIComponent(job.id)}`,
    descriptionHtml: null,
    descriptionText: "",
    employmentType: job.employmentStatusLabel ?? job.employmentType ?? null,
    workplaceType: job.isRemote ? "Remote" : null,
    salaryText: null,
    postedAt: null,
    raw: job,
  };
}

/** BambooHR's public `/careers/list` response is the complete current listing. The shared U.S.
 * filter runs on its structured ATS location before `/careers/{id}/detail` is fetched. */
export async function fetchBambooHrJobs(
  tenantToken: string,
  options: FetchBambooHrJobsOptions = {}
): Promise<NormalizedJob[]> {
  const tenant = normalizeBambooHrTenant(tenantToken);
  const { hostOverride, maxJobs, detailConcurrency = 5, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = hostOverride ?? `https://${tenant}.bamboohr.com`;
  const listUrl = `${origin}/careers/list`;
  const response = await fetchWithRetry(listUrl, { headers: { Accept: "application/json" } }, retryOptions);
  const body = await parseJsonOrThrow<BambooResponse<BambooListing[]>>(response, listUrl);
  if (!Array.isArray(body.result)) throw new Error("BambooHR careers response has no result array");
  if (typeof body.meta?.totalCount === "number" && body.meta.totalCount !== body.result.length) {
    throw new Error(`BambooHR careers list is incomplete: expected ${body.meta.totalCount}, received ${body.result.length}`);
  }
  const listings = body.result.map((job) => listingJob(job, tenant));
  const selected = filterJobsToUs(listings, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const perCallLimit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  return Promise.all(selected.map((listing) => {
    if (listing.lifecycleOnly) return listing;
    return perCallLimit(() => publicRequestLimit(async (): Promise<NormalizedJob> => {
      const detailUrl = `${origin}/careers/${encodeURIComponent(listing.externalId!)}/detail`;
      const response = await fetchWithRetry(detailUrl, { headers: { Accept: "application/json" } }, retryOptions);
      const body = await parseJsonOrThrow<BambooResponse<{ jobOpening?: BambooDetail }>>(response, detailUrl);
      const detail = body.result?.jobOpening;
      if (!detail?.description?.trim()) throw new Error(`BambooHR job ${listing.externalId} has no full description`);
      const descriptionHtml = detail.description;
      const descriptionText = stripHtml(descriptionHtml);
      return {
        ...listing,
        title: detail.jobOpeningName?.trim() || listing.title,
        location: locationText(detail) ?? listing.location,
        department: detail.departmentLabel?.trim() || listing.department,
        descriptionHtml,
        descriptionText,
        employmentType: detail.employmentStatusLabel ?? detail.employmentType ?? listing.employmentType,
        workplaceType: detail.isRemote || /\bremote\b/i.test(locationText(detail) ?? "") ? "Remote" : listing.workplaceType,
        salaryText: detail.compensation?.trim() || extractSalaryText(descriptionText),
        postedAt: detail.datePosted ?? null,
        raw: { listing: listing.raw, detail },
      };
    }));
  }));
}
