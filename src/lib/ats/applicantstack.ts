import pLimit from "p-limit";
import { extractSalaryText } from "@/lib/extractSalary";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { decodeHtmlEntities, stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface ApplicantStackListing { externalId: string; title: string; department: string | null; location: string; url: string }
interface ApplicantStackPosting {
  "@type"?: string;
  datePosted?: string;
  description?: string;
  employmentType?: string;
  identifier?: { value?: string };
  jobLocation?: { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } };
  title?: string;
}

export interface FetchApplicantStackJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  hostOverride?: string;
  detailConcurrency?: number;
}

export function normalizeApplicantStackTenant(value: string): string {
  const tenant = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(tenant) || tenant === "www") throw new Error("Invalid ApplicantStack tenant");
  return tenant;
}

export function canonicalApplicantStackUrl(tenant: string): string {
  return `https://${normalizeApplicantStackTenant(tenant)}.applicantstack.com/x/openings`;
}

function cells(row: string): string[] {
  return [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => stripHtml(decodeHtmlEntities(match[1])).trim());
}

function parseListingPage(html: string, origin: string): { jobs: ApplicantStackListing[]; start: number; end: number; total: number } {
  if (!/ApplicantStack(?:&trade;|™)?/i.test(html) || !/<table\b[^>]*id=["']data-table["']/i.test(html)) {
    throw new Error("ApplicantStack response is not its public openings table");
  }
  const range = html.match(/Showing\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i);
  if (!range) throw new Error("ApplicantStack openings page has no exact pagination total");
  const jobs: ApplicantStackListing[] = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const link = row[1].match(/<a\b[^>]*href=["']([^"']*\/x\/detail\/([a-z0-9]+)(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const values = cells(row[1]);
    const url = new URL(decodeHtmlEntities(link[1]), origin);
    if (url.origin !== origin || url.pathname !== `/x/detail/${link[2]}`
      || [...url.searchParams.keys()].some((key) => key !== "pge") || values.length < 3 || !values[2]) {
      throw new Error("ApplicantStack listing has a mismatched identity or missing structured location");
    }
    jobs.push({ externalId: link[2], title: stripHtml(decodeHtmlEntities(link[3])).trim(), department: values[1] || null, location: values[2], url: `${origin}/x/detail/${link[2]}` });
  }
  return { jobs, start: Number(range[1]), end: Number(range[2]), total: Number(range[3]) };
}

function parseDetail(html: string, listing: ApplicantStackListing): NormalizedJob {
  const canonical = html.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i)?.[1];
  let posting: ApplicantStackPosting | undefined;
  for (const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const value = JSON.parse(script[1]) as ApplicantStackPosting; if (value["@type"] === "JobPosting") posting = value; } catch { /* require a valid JobPosting below */ }
  }
  if (canonical !== listing.url || !posting || posting.identifier?.value !== listing.externalId
    || !posting.title?.trim() || !posting.description?.trim()) {
    throw new Error(`ApplicantStack job ${listing.externalId} has mismatched identity or no full description`);
  }
  const descriptionHtml = posting.description;
  const descriptionText = stripHtml(descriptionHtml);
  const address = posting.jobLocation?.address;
  const location = [address?.addressLocality, address?.addressRegion, address?.addressCountry].filter(Boolean).join(", ") || listing.location;
  return {
    externalId: listing.externalId,
    title: posting.title.trim(),
    location,
    department: listing.department,
    url: listing.url,
    descriptionHtml,
    descriptionText,
    employmentType: posting.employmentType ?? null,
    workplaceType: /\bremote\b/i.test(location) ? "Remote" : null,
    salaryText: extractSalaryText(descriptionText),
    postedAt: posting.datePosted ?? null,
    raw: { listing, posting },
  };
}

/** ApplicantStack exposes 100-row public HTML pages with an exact total. All pages are exhausted
 * and count-checked before the U.S. gate selects jobs for exact same-tenant detail requests. */
export async function fetchApplicantStackJobs(tenantValue: string, options: FetchApplicantStackJobsOptions = {}): Promise<NormalizedJob[]> {
  const tenant = normalizeApplicantStackTenant(tenantValue);
  const { hostOverride, maxJobs, detailConcurrency = 5, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = (hostOverride ?? `https://${tenant}.applicantstack.com`).replace(/\/$/, "");
  const all: ApplicantStackListing[] = [];
  let page = 1;
  let total = 0;
  do {
    const url = `${origin}/x/openings${page === 1 ? "" : `?pge=${page}`}`;
    const response = await fetchWithRetry(url, { headers: { Accept: "text/html" } }, retryOptions);
    const parsed = parseListingPage(await response.text(), origin);
    if (page === 1) total = parsed.total;
    if (parsed.total !== total || parsed.start !== all.length + 1 || parsed.end !== all.length + parsed.jobs.length) {
      throw new Error(`ApplicantStack pagination is incomplete or shifted during traversal: page=${page}, expectedStart=${all.length + 1}, received=${parsed.start}-${parsed.end}, rows=${parsed.jobs.length}, total=${parsed.total}/${total}`);
    }
    all.push(...parsed.jobs);
    page += 1;
  } while (all.length < total);
  if (all.length !== total || new Set(all.map((job) => job.externalId)).size !== total) {
    throw new Error(`ApplicantStack openings list is incomplete: expected ${total}, received ${all.length}`);
  }
  const listings = all.map((job): NormalizedJob => ({ ...job, descriptionHtml: null, descriptionText: "", employmentType: null, workplaceType: null, salaryText: null, postedAt: null, raw: job }));
  const selected = filterJobsToUs(listings, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const limit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  return Promise.all(selected.map((job) => job.lifecycleOnly ? job : limit(async () => {
    const listing = job.raw as ApplicantStackListing;
    const response = await fetchWithRetry(listing.url, { headers: { Accept: "text/html" } }, retryOptions);
    return parseDetail(await response.text(), listing);
  })));
}
