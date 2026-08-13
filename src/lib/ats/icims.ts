import pLimit from "p-limit";
import { extractSalaryText } from "@/lib/extractSalary";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { classifyJobLocation } from "@/lib/jobLocationScope";
import { decodeHtmlEntities, stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface IcimsJsonLd {
  "@type"?: string | string[];
  title?: string;
  description?: string;
  datePosted?: string;
  employmentType?: string | string[];
  jobLocationType?: string;
  jobLocation?: IcimsPlace | IcimsPlace[];
  baseSalary?: {
    currency?: string;
    minValue?: number;
    maxValue?: number;
    value?: number | { minValue?: number; maxValue?: number; unitText?: string };
  };
}

interface IcimsPlace {
  address?: {
    addressLocality?: string;
    addressRegion?: string;
    addressCountry?: string | { name?: string };
  };
}

interface IcimsListing {
  id: string;
  title: string;
  path: string;
  location: string | null;
  department: string | null;
  employmentType: string | null;
}

export interface FetchIcimsJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production always requests the token's iCIMS tenant host. */
  hostOverride?: string;
  detailConcurrency?: number;
}

const publicRequestLimit = pLimit(4);

export function normalizeIcimsHost(value: string): string {
  const host = value.trim().toLowerCase();
  if (!/^(?!www\.)[a-z0-9.-]+\.icims\.com$/.test(host)) {
    throw new Error("Invalid iCIMS tenant host");
  }
  return host;
}

export function canonicalIcimsUrl(host: string): string {
  return `https://${normalizeIcimsHost(host)}/jobs/search`;
}

function parseFields(card: string): Map<string, string> {
  const fields = new Map<string, string>();
  const fieldRe = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
  let match: RegExpExecArray | null;
  while ((match = fieldRe.exec(card)) !== null) {
    const key = stripHtml(match[1]).toLowerCase();
    const value = stripHtml(match[2]);
    if (key && value) fields.set(key, value);
  }
  return fields;
}

export function parseIcimsListings(html: string): { jobs: IcimsListing[]; totalPages: number } {
  const pageMatch = stripHtml(html).match(/Page\s+\d+\s+of\s+(\d+)/i);
  const totalPages = pageMatch ? Number.parseInt(pageMatch[1], 10) : 1;
  const jobs: IcimsListing[] = [];
  const seen = new Set<string>();
  const cardRe = /<li\b[^>]*class\s*=\s*(["'])[^"']*\biCIMS_JobCardItem\b[^"']*\1[^>]*>([\s\S]*?)<\/li>/gi;
  let cardMatch: RegExpExecArray | null;
  while ((cardMatch = cardRe.exec(html)) !== null) {
    const card = cardMatch[2];
    const anchor = card.match(/<a\b[^>]*href\s*=\s*(["'])([^"']*\/jobs\/(\d+)\/[^"']*\/job(?:\?[^"']*)?)\1[^>]*>/i);
    if (!anchor || seen.has(anchor[3])) continue;
    const heading = card.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
    const title = stripHtml(heading?.[1]);
    if (!title) continue;
    const href = decodeHtmlEntities(anchor[2]);
    let path: string;
    try {
      const parsed = new URL(href, "https://example.invalid");
      path = parsed.pathname;
    } catch {
      continue;
    }
    const fields = parseFields(card);
    const location = fields.get("job locations") ?? fields.get("location") ?? null;
    seen.add(anchor[3]);
    jobs.push({
      id: anchor[3],
      title,
      path,
      location,
      department: fields.get("category") ?? fields.get("department") ?? null,
      employmentType: fields.get("position type") ?? fields.get("employment type") ?? null,
    });
  }
  return { jobs, totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 1 };
}

function isJobPosting(value: IcimsJsonLd): boolean {
  const type = value["@type"];
  return type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
}

function extractJobPosting(html: string): IcimsJsonLd | null {
  const scriptRe = /<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[2].trim()) as IcimsJsonLd | IcimsJsonLd[] | { "@graph": IcimsJsonLd[] };
      let candidates: IcimsJsonLd[];
      if (Array.isArray(parsed)) candidates = parsed;
      else if ("@graph" in parsed && Array.isArray(parsed["@graph"])) candidates = parsed["@graph"];
      else candidates = [parsed as IcimsJsonLd];
      const posting = candidates.find(isJobPosting);
      if (posting) return posting;
    } catch {
      // Ignore unrelated malformed structured-data blocks.
    }
  }
  return null;
}

function detailLocation(detail: IcimsJsonLd): string | null {
  const places = Array.isArray(detail.jobLocation) ? detail.jobLocation : detail.jobLocation ? [detail.jobLocation] : [];
  const values = places.map((place) => {
    const address = place.address;
    const country = typeof address?.addressCountry === "string"
      ? address.addressCountry
      : address?.addressCountry?.name;
    return [address?.addressLocality, address?.addressRegion, country]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(", ");
  }).filter(Boolean);
  return values.length > 0 ? values.join("; ") : null;
}

function salaryFromDetail(detail: IcimsJsonLd, descriptionText: string): string | null {
  const fromDescription = extractSalaryText(descriptionText);
  if (fromDescription) return fromDescription;
  const salary = detail.baseSalary;
  if (!salary) return null;
  const value = typeof salary.value === "object" ? salary.value : undefined;
  const min = salary.minValue ?? value?.minValue ?? (typeof salary.value === "number" ? salary.value : undefined);
  const max = salary.maxValue ?? value?.maxValue;
  if (min === undefined && max === undefined) return null;
  const currency = salary.currency ?? "USD";
  const amount = min !== undefined && max !== undefined && min !== max
    ? `${min.toLocaleString("en-US")} - ${max.toLocaleString("en-US")}`
    : (min ?? max)!.toLocaleString("en-US");
  return `${currency} ${amount}${value?.unitText ? ` ${value.unitText}` : ""}`;
}

function listingJob(listing: IcimsListing, tenantHost: string): NormalizedJob {
  return {
    externalId: listing.id,
    title: listing.title,
    location: listing.location,
    department: listing.department,
    url: `https://${tenantHost}${listing.path}`,
    descriptionHtml: null,
    descriptionText: "",
    employmentType: listing.employmentType,
    workplaceType: /\bremote\b/i.test(listing.location ?? "") ? "Remote" : null,
    salaryText: null,
    postedAt: null,
    raw: listing,
  };
}

/** iCIMS public boards expose exhaustive zero-based page-index listings. We exhaust those listings
 * for authoritative scans, apply the shared U.S. gate, and only then request full JobPosting JSON-LD
 * details for the selected jobs. */
export async function fetchIcimsJobs(
  tenantToken: string,
  options: FetchIcimsJobsOptions = {}
): Promise<NormalizedJob[]> {
  const tenantHost = normalizeIcimsHost(tenantToken);
  const {
    hostOverride,
    maxJobs,
    detailConcurrency = 4,
    usOnly,
    existingExternalIds,
    onLocationFiltered,
    ...retryOptions
  } = options;
  const origin = hostOverride ?? `https://${tenantHost}`;
  const listings: NormalizedJob[] = [];
  const seen = new Set<string>();
  let totalPages = 1;
  for (let page = 0; page < totalPages; page++) {
    const params = new URLSearchParams({ ss: "1", pr: String(page), searchRelation: "keyword_all", in_iframe: "1" });
    const listUrl = `${origin}/jobs/search?${params}`;
    const response = await fetchWithRetry(listUrl, { headers: { Accept: "text/html" } }, retryOptions);
    const parsed = parseIcimsListings(await response.text());
    totalPages = Math.max(totalPages, parsed.totalPages);
    for (const item of parsed.jobs) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      listings.push(listingJob(item, tenantHost));
    }
  }

  let selected: NormalizedJob[];
  if (!usOnly) {
    selected = listings.slice(0, maxJobs);
  } else {
    const explicitUs = listings.filter((job) => classifyJobLocation(job.location) === "US");
    const unresolved = listings.filter((job) => classifyJobLocation(job.location) === "UNKNOWN");
    // Sample/validation scans resolve a bounded number of ambiguous listings. Full authoritative
    // scans have no maxJobs and resolve every UNKNOWN location before the final persistence gate.
    const resolutionBudget = maxJobs === undefined ? unresolved.length : maxJobs * 5;
    selected = [...explicitUs, ...unresolved.slice(0, resolutionBudget)];
    if (maxJobs !== undefined && explicitUs.length >= maxJobs) selected = explicitUs.slice(0, maxJobs);
    for (const job of listings) {
      if (classifyJobLocation(job.location) !== "NON_US") continue;
      onLocationFiltered?.("NON_US", job);
      if (job.externalId && existingExternalIds?.has(job.externalId)) {
        selected.push({ ...job, lifecycleOnly: true });
      }
    }
  }
  const perCallLimit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 8)));
  const detailed = await Promise.all(selected.map((listing) => {
    if (listing.lifecycleOnly) return listing;
    return perCallLimit(() => publicRequestLimit(async (): Promise<NormalizedJob> => {
      const path = new URL(listing.url).pathname;
      const detailUrl = `${origin}${path}?in_iframe=1`;
      const response = await fetchWithRetry(detailUrl, { headers: { Accept: "text/html" } }, retryOptions);
      const detail = extractJobPosting(await response.text());
      if (!detail?.description?.trim()) throw new Error(`iCIMS job ${listing.externalId} has no full JobPosting description`);
      const descriptionHtml = detail.description;
      const descriptionText = stripHtml(descriptionHtml);
      const employmentType = Array.isArray(detail.employmentType)
        ? detail.employmentType.join(", ")
        : detail.employmentType ?? listing.employmentType;
      return {
        ...listing,
        title: detail.title?.trim() || listing.title,
        location: detailLocation(detail) ?? listing.location,
        descriptionHtml,
        descriptionText,
        employmentType,
        workplaceType: detail.jobLocationType === "TELECOMMUTE" ? "Remote" : listing.workplaceType,
        salaryText: salaryFromDetail(detail, descriptionText),
        postedAt: detail.datePosted ?? null,
        raw: { listing: listing.raw, detail },
      };
    }));
  }));
  return usOnly
    ? filterJobsToUs(detailed, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs)
    : detailed.slice(0, maxJobs);
}
