import pLimit from "p-limit";
import { extractSalaryText } from "@/lib/extractSalary";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { degradeMissingDescription } from "@/lib/ats/jobContentFailure";
import { classifyJobLocation } from "@/lib/jobLocationScope";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface RipplingLocation {
  name?: string | null;
  country?: string | null;
  countryCode?: string | null;
  state?: string | null;
  stateCode?: string | null;
  city?: string | null;
  workplaceType?: string | null;
}

interface RipplingListing {
  id: string;
  name: string;
  url?: string | null;
  department?: { name?: string | null } | null;
  locations?: RipplingLocation[];
}

interface RipplingListData {
  items: RipplingListing[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

interface RipplingJobPost {
  uuid: string;
  name: string;
  description?: Record<string, string | null> | null;
  workLocations?: string[];
  department?: { name?: string | null } | null;
  employmentType?: { id?: string | null; label?: string | null } | null;
  createdOn?: string | null;
  url?: string | null;
}

interface RipplingPageProps {
  apiData?: {
    jobPost?: RipplingJobPost;
  };
  dehydratedState?: {
    queries?: Array<{
      queryKey?: unknown[];
      state?: { data?: unknown };
    }>;
  };
}

export interface FetchRipplingJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production uses ats.rippling.com. */
  hostOverride?: string;
  detailConcurrency?: number;
}

const publicRequestLimit = pLimit(5);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeRipplingSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug) || slug === "embed" || /^[a-z]{2}-[a-z]{2}$/.test(slug)) {
    throw new Error("Invalid Rippling job-board slug");
  }
  return slug;
}

export function canonicalRipplingUrl(slug: string): string {
  return `https://ats.rippling.com/${normalizeRipplingSlug(slug)}/jobs`;
}

function parseNextPageProps(html: string, url: string): RipplingPageProps {
  const match = html.match(/<script\s+id=["']__NEXT_DATA__["']\s+type=["']application\/json["']>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error(`Rippling page ${url} is missing __NEXT_DATA__`);
  try {
    const payload = JSON.parse(match[1]) as { props?: { pageProps?: RipplingPageProps } };
    if (!payload.props?.pageProps) throw new Error("missing pageProps");
    return payload.props.pageProps;
  } catch (error) {
    throw new Error(`Rippling page ${url} contains invalid __NEXT_DATA__: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function listingData(pageProps: RipplingPageProps, url: string): RipplingListData {
  const query = pageProps.dehydratedState?.queries?.find((candidate) =>
    candidate.queryKey?.some((part) => part === "job-posts")
  );
  const data = query?.state?.data as Partial<RipplingListData> | undefined;
  if (!data || !Array.isArray(data.items) || !Number.isInteger(data.page) ||
      !Number.isInteger(data.totalItems) || !Number.isInteger(data.totalPages)) {
    throw new Error(`Rippling listing page ${url} is missing complete pagination metadata`);
  }
  return data as RipplingListData;
}

function locationText(listing: RipplingListing): string | null {
  const names = (listing.locations ?? []).map((location) => location.name?.trim()).filter((name): name is string => Boolean(name));
  return names.length ? [...new Set(names)].join("; ") : null;
}

function workplaceType(listing: RipplingListing): string | null {
  const values = (listing.locations ?? []).map((location) => location.workplaceType?.trim()).filter((value): value is string => Boolean(value));
  return values.length ? [...new Set(values)].join(" / ") : null;
}

function listingJob(slug: string, listing: RipplingListing): NormalizedJob {
  return {
    externalId: listing.id,
    title: listing.name,
    location: locationText(listing),
    department: listing.department?.name?.trim() || null,
    url: `${canonicalRipplingUrl(slug)}/${encodeURIComponent(listing.id)}`,
    descriptionHtml: null,
    descriptionText: "",
    employmentType: null,
    workplaceType: workplaceType(listing),
    salaryText: null,
    postedAt: null,
    raw: listing,
  };
}

function enoughBoundedJobs(listings: RipplingListing[], maxJobs: number | undefined, usOnly: boolean | undefined): boolean {
  if (!maxJobs) return false;
  if (!usOnly) return listings.length >= maxJobs;
  return listings.reduce((count, listing) => count + (classifyJobLocation(locationText(listing)) === "US" ? 1 : 0), 0) >= maxJobs;
}

/** Rippling's public Next.js careers pages expose complete list pagination in __NEXT_DATA__ and
 * full job descriptions on public UUID detail pages. Production exhausts all listing pages while
 * bounded canaries stop after enough eligible jobs. The U.S. gate runs before detail requests. */
export async function fetchRipplingJobs(
  boardSlug: string,
  options: FetchRipplingJobsOptions = {}
): Promise<NormalizedJob[]> {
  const slug = normalizeRipplingSlug(boardSlug);
  const {
    hostOverride,
    maxJobs,
    detailConcurrency = 5,
    usOnly,
    existingExternalIds,
    onLocationFiltered,
    ...retryOptions
  } = options;
  const origin = (hostOverride ?? "https://ats.rippling.com").replace(/\/$/, "");
  const listings: RipplingListing[] = [];
  const seenIds = new Set<string>();
  let page = 0;
  let expectedTotal = 0;
  let expectedPages = 0;

  do {
    const listUrl = `${origin}/${encodeURIComponent(slug)}/jobs${page ? `?page=${page}&pageSize=20` : ""}`;
    const response = await fetchWithRetry(listUrl, { headers: { Accept: "text/html" } }, retryOptions);
    const data = listingData(parseNextPageProps(await response.text(), listUrl), listUrl);
    if (data.page !== page) throw new Error(`Rippling listing returned page ${data.page} while page ${page} was requested`);
    if (page === 0) {
      expectedTotal = data.totalItems;
      expectedPages = data.totalPages;
    } else if (data.totalItems !== expectedTotal || data.totalPages !== expectedPages) {
      throw new Error("Rippling listing pagination totals changed during the scan");
    }
    for (const listing of data.items) {
      if (!UUID_PATTERN.test(listing.id) || !listing.name?.trim() || seenIds.has(listing.id)) continue;
      seenIds.add(listing.id);
      listings.push(listing);
    }
    if (enoughBoundedJobs(listings, maxJobs, usOnly)) break;
    page += 1;
  } while (page < expectedPages);

  if (!maxJobs && listings.length !== expectedTotal) {
    throw new Error(`Rippling listing is incomplete: expected ${expectedTotal}, received ${listings.length}`);
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
      const detailUrl = `${origin}/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(listing.externalId!)}`;
      const response = await fetchWithRetry(detailUrl, { headers: { Accept: "text/html" } }, retryOptions);
      const detail = parseNextPageProps(await response.text(), detailUrl).apiData?.jobPost;
      if (!detail || detail.uuid !== listing.externalId) throw new Error(`Rippling job ${listing.externalId} detail identity did not match`);
      const descriptionHtml = Object.values(detail.description ?? {}).map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)).join("\n");
      if (!descriptionHtml) return degradeMissingDescription(listing);
      const descriptionText = stripHtml(descriptionHtml);
      return {
        ...listing,
        title: detail.name?.trim() || listing.title,
        location: detail.workLocations?.filter(Boolean).join("; ") || listing.location,
        department: detail.department?.name?.trim() || listing.department,
        descriptionHtml,
        descriptionText,
        employmentType: detail.employmentType?.id?.trim() || detail.employmentType?.label?.trim() || null,
        salaryText: extractSalaryText(descriptionText),
        postedAt: detail.createdOn ?? null,
        url: detail.url?.trim() || listing.url,
        raw: { listing: listing.raw, detail },
      };
    }));
  }));
}
