import pLimit from "p-limit";
import { extractSalaryText } from "@/lib/extractSalary";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface SmartRecruitersPosting {
  id: string;
  name: string;
  releasedDate?: string;
  location?: {
    city?: string;
    region?: string;
    country?: string;
    fullLocation?: string;
    remote?: boolean;
    hybrid?: boolean;
  };
  department?: { label?: string };
  typeOfEmployment?: { label?: string };
}

interface SmartRecruitersListResponse {
  offset: number;
  limit: number;
  totalFound: number;
  content: SmartRecruitersPosting[];
}

interface SmartRecruitersDetail extends SmartRecruitersPosting {
  jobAd?: {
    companyDescription?: string;
    jobDescription?: string;
    qualifications?: string;
    additionalInformation?: string;
  };
}

export interface FetchSmartRecruitersJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override; production always uses the official public Posting API. */
  hostOverride?: string;
  detailConcurrency?: number;
}

export function normalizeSmartRecruitersToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("SmartRecruiters company identifier cannot be empty");
  }
  // Reject template placeholders, invalid syntax, or generic strings
  if (/^\$\{.*\}$/.test(trimmed) || /^(?:null|undefined|company|default)$/i.test(trimmed)) {
    throw new Error(`Invalid SmartRecruiters company identifier template/placeholder: ${trimmed}`);
  }
  if (!/^[a-z0-9_-]+$/i.test(trimmed)) {
    throw new Error(`Invalid SmartRecruiters company identifier: ${trimmed}`);
  }
  return trimmed;
}

export function canonicalSmartRecruitersUrl(token: string): string {
  return `https://careers.smartrecruiters.com/${normalizeSmartRecruitersToken(token)}`;
}

function locationText(job: SmartRecruitersPosting): string | null {
  if (job.location?.fullLocation) return job.location.fullLocation;
  const parts = [job.location?.city, job.location?.region, job.location?.country]
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : null;
}

function descriptionHtml(detail: SmartRecruitersDetail): string | null {
  const blocks = [
    detail.jobAd?.jobDescription,
    detail.jobAd?.qualifications,
    detail.jobAd?.additionalInformation,
  ].filter((value): value is string => Boolean(value?.trim()));
  return blocks.length > 0 ? blocks.join("\n") : null;
}

/** Official SmartRecruiters public Posting API adapter. Offset/totalFound pagination is exhausted
 * for production scans; country=us is requested server-side and the shared explicit U.S. filter is
 * still applied defensively before any job reaches persistence. */
export async function fetchSmartRecruitersJobs(
  companyIdentifier: string,
  options: FetchSmartRecruitersJobsOptions = {}
): Promise<NormalizedJob[]> {
  const normalizedCompany = normalizeSmartRecruitersToken(companyIdentifier);
  const {
    hostOverride,
    maxJobs,
    detailConcurrency = 5,
    usOnly,
    existingExternalIds,
    onLocationFiltered,
    ...retryOptions
  } = options;
  const origin = hostOverride ?? "https://api.smartrecruiters.com";
  const company = encodeURIComponent(normalizedCompany);
  const postings: SmartRecruitersPosting[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  let authoritativeTotalFound: number | null = null;
  const pageLimit = maxJobs ? Math.min(100, Math.max(1, maxJobs)) : 100;

  for (;;) {
    const params = new URLSearchParams({ offset: String(offset), limit: String(pageLimit) });
    if (usOnly) params.set("country", "us");
    const url = `${origin}/v1/companies/${company}/postings?${params}`;
    const response = await fetchWithRetry(url, { headers: { Accept: "application/json" } }, retryOptions);
    const page = await parseJsonOrThrow<SmartRecruitersListResponse>(response, url);
    if (!Array.isArray(page.content)) throw new Error("SmartRecruiters postings response has no content array");

    if (typeof page.totalFound !== "number" || isNaN(page.totalFound) || page.totalFound < 0) {
      throw new Error(`SmartRecruiters response missing valid numeric totalFound at offset ${offset}`);
    }

    if (authoritativeTotalFound === null) {
      authoritativeTotalFound = page.totalFound;
    } else if (page.totalFound !== authoritativeTotalFound) {
      throw new Error(
        `SmartRecruiters totalFound mutated during pagination: initial ${authoritativeTotalFound}, got ${page.totalFound}`
      );
    }

    if (page.content.length === 0 && offset < authoritativeTotalFound) {
      throw new Error(
        `SmartRecruiters pagination returned empty content at offset ${offset} before reaching totalFound ${authoritativeTotalFound}`
      );
    }

    for (const posting of page.content) {
      if (!posting.id || typeof posting.id !== "string") {
        throw new Error("SmartRecruiters posting missing valid string id");
      }
      if (seenIds.has(posting.id)) {
        throw new Error(`Duplicate posting ID detected in SmartRecruiters snapshot: ${posting.id}`);
      }
      seenIds.add(posting.id);
      postings.push(posting);
    }

    if (maxJobs && postings.length >= maxJobs) break;
    offset += page.content.length;
    if (page.content.length === 0 || offset >= authoritativeTotalFound) break;
  }

  const selected = maxJobs ? postings.slice(0, maxJobs) : postings;
  const limit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  const normalized = await Promise.all(selected.map((posting) => limit(async (): Promise<NormalizedJob> => {
    const detailUrl = `${origin}/v1/companies/${company}/postings/${encodeURIComponent(posting.id)}`;
    const response = await fetchWithRetry(detailUrl, { headers: { Accept: "application/json" } }, retryOptions);
    const detail = await parseJsonOrThrow<SmartRecruitersDetail>(response, detailUrl);
    const html = descriptionHtml(detail);
    const text = stripHtml(html);
    const location = locationText(detail) ?? locationText(posting);
    const workplaceType = detail.location?.remote
      ? "Remote"
      : detail.location?.hybrid
        ? "Hybrid"
        : null;
    return {
      externalId: String(detail.id ?? posting.id),
      title: detail.name ?? posting.name,
      location,
      department: detail.department?.label ?? posting.department?.label ?? null,
      url: `https://jobs.smartrecruiters.com/${encodeURIComponent(normalizedCompany)}/${encodeURIComponent(posting.id)}`,
      descriptionHtml: html,
      descriptionText: text,
      employmentType: detail.typeOfEmployment?.label ?? posting.typeOfEmployment?.label ?? null,
      workplaceType,
      salaryText: extractSalaryText(text),
      postedAt: detail.releasedDate ?? posting.releasedDate ?? null,
      raw: detail,
    };
  })));

  return filterJobsToUs(normalized, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
}
