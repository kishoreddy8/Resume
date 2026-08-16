import pLimit from "p-limit";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { degradeMissingDescription } from "@/lib/ats/jobContentFailure";
import { extractSalaryText } from "@/lib/extractSalary";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface ApplicantProListing {
  id: number;
  title: string;
  subdomain: string;
  siteId: number;
  domainName: string;
  jobUrl: string;
  jobLocation?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  stateName?: string | null;
  abbreviation?: string | null;
  iso3?: string | null;
  orgTitle?: string | null;
  parentTitle?: string | null;
  workplaceType?: string | null;
  employmentType?: string | null;
  startDateRef?: string | null;
  minSalary?: string | null;
  maxSalary?: string | null;
  payTypeFrame?: string | null;
}

interface ApplicantProListingResponse {
  success?: boolean;
  data?: { jobCount?: number; jobs?: ApplicantProListing[] };
}

interface ApplicantProDetailResponse {
  success?: boolean;
  data?: {
    id?: number;
    siteId?: number;
    title?: string;
    description?: string;
    advertisingDescriptionHtml?: string;
    startDateRef?: string | null;
  };
}

export interface FetchApplicantProJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production uses the tenant's applicantpro.com origin. */
  hostOverride?: string;
  detailConcurrency?: number;
}

const publicRequestLimit = pLimit(5);

export function normalizeApplicantProTenant(value: string): string {
  const tenant = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(tenant) || tenant === "www") throw new Error("Invalid ApplicantPro tenant");
  return tenant;
}

export function canonicalApplicantProUrl(tenant: string): string {
  return `https://${normalizeApplicantProTenant(tenant)}.applicantpro.com/jobs/`;
}

function parseBoardIdentity(html: string, tenant: string): number {
  const canonical = html.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i)?.[1]
    ?? html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:url["']/i)?.[1];
  if (canonical !== `https://www.applicantpro.com/openings/${tenant}/jobs`) {
    throw new Error("ApplicantPro board canonical identity does not match the requested tenant");
  }
  const component = html.match(/componentData\s*:\s*\{[\s\S]*?organizationId\s*:\s*\d+\s*,\s*domainId\s*:\s*(\d+)[\s\S]*?domainName\s*:\s*["']applicantpro\.com["'][\s\S]*?subdomainName\s*:\s*["']([a-z0-9-]+)["']/i);
  if (!component || component[2].toLowerCase() !== tenant) throw new Error("ApplicantPro board is missing its exact component identity");
  return Number(component[1]);
}

function listingLocation(job: ApplicantProListing): string | null {
  if (job.jobLocation?.trim()) return job.jobLocation.trim();
  const parts = [job.streetAddress, job.city, job.abbreviation || job.stateName, job.iso3].map((value) => value?.trim()).filter(Boolean);
  return parts.length ? [...new Set(parts)].join(", ") : null;
}

function listingJob(job: ApplicantProListing): NormalizedJob {
  const department = [job.parentTitle, job.orgTitle].map((value) => value?.trim()).filter(Boolean).join(" - ") || null;
  const salary = [job.minSalary, job.maxSalary].filter((value) => value?.trim()).join(" - ");
  return {
    externalId: String(job.id),
    title: job.title.trim(),
    location: listingLocation(job),
    department,
    url: job.jobUrl,
    descriptionHtml: null,
    descriptionText: "",
    employmentType: job.employmentType?.trim() || null,
    workplaceType: job.workplaceType?.trim() || null,
    salaryText: salary ? `${salary}${job.payTypeFrame ? ` ${job.payTypeFrame}` : ""}` : null,
    postedAt: job.startDateRef?.trim() || null,
    raw: job,
  };
}

function parseListings(payload: ApplicantProListingResponse, tenant: string, domainId: number, origin: string): NormalizedJob[] {
  if (payload.success !== true || !payload.data || !Array.isArray(payload.data.jobs) || !Number.isInteger(payload.data.jobCount)) {
    throw new Error("ApplicantPro listing response has an invalid shape");
  }
  if (payload.data.jobs.length !== payload.data.jobCount) throw new Error("ApplicantPro listing response is incomplete");
  const seen = new Set<number>();
  return payload.data.jobs.map((job) => {
    let url: URL;
    try { url = new URL(job.jobUrl); } catch { throw new Error("ApplicantPro listing contains an invalid job URL"); }
    const match = url.pathname.match(/^\/jobs\/(\d+)(?:\.html)?\/?$/);
    if (!Number.isInteger(job.id) || job.id <= 0 || seen.has(job.id) || String(job.id) !== match?.[1]
      || job.siteId !== domainId || job.subdomain?.toLowerCase() !== tenant
      || job.domainName?.toLowerCase() !== "applicantpro.com" || url.origin !== origin || !job.title?.trim()) {
      throw new Error("ApplicantPro listing contains a mismatched identity or duplicate job ID");
    }
    seen.add(job.id);
    return listingJob(job);
  });
}

/** ApplicantPro exposes a complete count-matched public listing. Structured locations are filtered
 * before identity-matched JobPosting detail pages are fetched. */
export async function fetchApplicantProJobs(tenantValue: string, options: FetchApplicantProJobsOptions = {}): Promise<NormalizedJob[]> {
  const tenant = normalizeApplicantProTenant(tenantValue);
  const { hostOverride, maxJobs, detailConcurrency = 5, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = (hostOverride ?? `https://${tenant}.applicantpro.com`).replace(/\/$/, "");
  const boardResponse = await fetchWithRetry(`${origin}/jobs/`, { headers: { Accept: "text/html" } }, retryOptions);
  const domainId = parseBoardIdentity(await boardResponse.text(), tenant);
  const listResponse = await fetchWithRetry(`${origin}/core/jobs/${domainId}?getParams=${encodeURIComponent("{}")}`,
    { headers: { Accept: "application/json" } }, retryOptions);
  const selected = filterJobsToUs(parseListings(await listResponse.json() as ApplicantProListingResponse, tenant, domainId, origin),
    { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const perCallLimit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  return Promise.all(selected.map((listing) => {
    if (listing.lifecycleOnly) return listing;
    return perCallLimit(() => publicRequestLimit(async (): Promise<NormalizedJob> => {
      const response = await fetchWithRetry(`${origin}/core/jobs/${domainId}/${listing.externalId}/job-details`,
        { headers: { Accept: "application/json" } }, retryOptions);
      const payload = await response.json() as ApplicantProDetailResponse;
      const detail = payload.data;
      if (payload.success !== true || !detail || String(detail.id) !== listing.externalId || detail.siteId !== domainId) {
        throw new Error(`ApplicantPro job ${listing.externalId} has a mismatched public detail identity`);
      }
      const descriptionHtml = detail.description?.trim() || detail.advertisingDescriptionHtml?.trim();
      if (!descriptionHtml) return degradeMissingDescription(listing);
      const descriptionText = stripHtml(descriptionHtml);
      return {
        ...listing,
        title: detail.title?.trim() || listing.title,
        location: listing.location,
        descriptionHtml,
        descriptionText,
        employmentType: listing.employmentType,
        salaryText: listing.salaryText ?? extractSalaryText(descriptionText),
        postedAt: detail.startDateRef?.trim() || listing.postedAt,
        raw: { listing: listing.raw, detail },
      };
    }));
  }));
}
