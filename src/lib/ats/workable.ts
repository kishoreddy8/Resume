import pLimit from "p-limit";
import { extractSalaryText } from "@/lib/extractSalary";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { degradeMissingDescription } from "@/lib/ats/jobContentFailure";
import { classifyJobLocation } from "@/lib/jobLocationScope";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface WorkableLocation {
  country?: string | null;
  countryCode?: string | null;
  city?: string | null;
  region?: string | null;
  display?: string | null;
  hidden?: boolean;
}

interface WorkableListing {
  id: number | string;
  shortcode: string;
  title: string;
  remote?: boolean;
  location?: WorkableLocation | null;
  locations?: WorkableLocation[];
  published?: string | null;
  type?: string | null;
  department?: string[];
  workplace?: string | null;
}

interface WorkableDetail extends WorkableListing {
  description?: string | null;
  requirements?: string | null;
  benefits?: string | null;
}

interface WorkableListResponse {
  total?: number;
  nextPage?: string | null;
  results?: WorkableListing[];
}

export interface FetchWorkableJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production uses apply.workable.com. */
  hostOverride?: string;
  detailConcurrency?: number;
}

const publicRequestLimit = pLimit(5);

export function normalizeWorkableSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug) || slug === "j" || slug === "api") {
    throw new Error("Invalid Workable account slug");
  }
  return slug;
}

export function canonicalWorkableUrl(slug: string): string {
  return `https://apply.workable.com/${normalizeWorkableSlug(slug)}/`;
}

function locationText(job: WorkableListing): string | null {
  const locations = job.locations?.length ? job.locations : job.location ? [job.location] : [];
  const values = locations.filter((location) => !location.hidden).map((location) => {
    if (location.display?.trim()) return location.display.trim();
    const parts = [location.city, location.region, location.country]
      .filter((value): value is string => Boolean(value?.trim()));
    return parts.join(", ");
  }).filter(Boolean);
  if (values.length > 0) return [...new Set(values)].join("; ");
  return job.remote ? "Remote" : null;
}

function employmentType(value: string | null | undefined): string | null {
  const labels: Record<string, string> = {
    full: "Full-time",
    part: "Part-time",
    contract: "Contract",
    temporary: "Temporary",
    other: "Other",
  };
  return value ? labels[value.toLowerCase()] ?? value : null;
}

function listingJob(slug: string, listing: WorkableListing): NormalizedJob {
  const location = locationText(listing);
  return {
    externalId: listing.shortcode,
    title: listing.title,
    location,
    department: listing.department?.filter(Boolean).join(" / ") || null,
    url: `https://apply.workable.com/${slug}/j/${encodeURIComponent(listing.shortcode)}/`,
    descriptionHtml: null,
    descriptionText: "",
    employmentType: employmentType(listing.type),
    workplaceType: listing.workplace?.trim() || (listing.remote ? "Remote" : null),
    salaryText: null,
    postedAt: listing.published ?? null,
    raw: listing,
  };
}

function fullDescription(detail: WorkableDetail): string {
  const sections = [detail.description, detail.requirements, detail.benefits]
    .map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return [...new Set(sections)].join("\n");
}

function enoughBoundedJobs(listings: WorkableListing[], maxJobs: number | undefined, usOnly: boolean | undefined): boolean {
  if (!maxJobs) return false;
  if (!usOnly) return listings.length >= maxJobs;
  return listings.reduce((count, listing) => count + (classifyJobLocation(locationText(listing)) === "US" ? 1 : 0), 0) >= maxJobs;
}

/** Workable's public careers client exposes an opaque-token paginated listing with an exact total.
 * Production scans follow every token; bounded validation stops only after enough eligible jobs.
 * The shared U.S. gate runs before full detail calls. */
export async function fetchWorkableJobs(
  accountSlug: string,
  options: FetchWorkableJobsOptions = {}
): Promise<NormalizedJob[]> {
  const slug = normalizeWorkableSlug(accountSlug);
  const {
    hostOverride,
    maxJobs,
    detailConcurrency = 5,
    usOnly,
    existingExternalIds,
    onLocationFiltered,
    ...retryOptions
  } = options;
  const origin = hostOverride ?? "https://apply.workable.com";
  const listUrl = `${origin}/api/v3/accounts/${encodeURIComponent(slug)}/jobs`;
  const listings: WorkableListing[] = [];
  const seenIds = new Set<string>();
  const seenTokens = new Set<string>();
  let token: string | null = null;
  let total = Number.POSITIVE_INFINITY;

  do {
    const payload = token ? { query: "", token } : {};
    const response = await fetchWithRetry(listUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, retryOptions);
    const body = await parseJsonOrThrow<WorkableListResponse>(response, listUrl);
    if (!Array.isArray(body.results) || typeof body.total !== "number") {
      throw new Error("Workable listing response is missing results or total");
    }
    total = body.total;
    for (const listing of body.results) {
      const id = listing.shortcode?.trim();
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      listings.push(listing);
    }
    if (enoughBoundedJobs(listings, maxJobs, usOnly)) break;
    token = body.nextPage?.trim() || null;
    if (token) {
      if (seenTokens.has(token)) throw new Error("Workable listing pagination repeated a next-page token");
      seenTokens.add(token);
    }
  } while (token);

  if (!maxJobs && listings.length !== total) {
    throw new Error(`Workable listing is incomplete: expected ${total}, received ${listings.length}`);
  }
  const selected = filterJobsToUs(
    listings.map((listing) => listingJob(slug, listing)),
    { usOnly, existingExternalIds, onLocationFiltered },
    maxJobs
  );
  const perCallLimit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  return Promise.all(selected.map((listing) => {
    if (listing.lifecycleOnly) return listing;
    return perCallLimit(() => publicRequestLimit(async (): Promise<NormalizedJob> => {
      const detailUrl = `${origin}/api/v2/accounts/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(listing.externalId!)}`;
      const response = await fetchWithRetry(detailUrl, { headers: { Accept: "application/json" } }, retryOptions);
      const detail = await parseJsonOrThrow<WorkableDetail>(response, detailUrl);
      const descriptionHtml = fullDescription(detail);
      if (!descriptionHtml) return degradeMissingDescription(listing);
      const descriptionText = stripHtml(descriptionHtml);
      return {
        ...listing,
        title: detail.title?.trim() || listing.title,
        location: locationText(detail) ?? listing.location,
        department: detail.department?.filter(Boolean).join(" / ") || listing.department,
        descriptionHtml,
        descriptionText,
        employmentType: employmentType(detail.type) ?? listing.employmentType,
        workplaceType: detail.workplace?.trim() || (detail.remote ? "Remote" : listing.workplaceType),
        salaryText: extractSalaryText(descriptionText),
        postedAt: detail.published ?? listing.postedAt,
        raw: { listing: listing.raw, detail },
      };
    }));
  }));
}
