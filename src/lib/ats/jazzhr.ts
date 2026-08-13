import pLimit from "p-limit";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { extractJsonLdJobPostings } from "@/lib/ats/jobValidation";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { extractSalaryText } from "@/lib/extractSalary";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface JazzHrListing {
  id: string;
  title: string;
  location: string | null;
  department: string | null;
  url: string;
}

export interface FetchJazzHrJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production uses the tenant.applytojob.com origin. */
  hostOverride?: string;
  detailConcurrency?: number;
}

const publicRequestLimit = pLimit(5);

export function normalizeJazzHrTenant(value: string): string {
  const tenant = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(tenant) || tenant === "www") throw new Error("Invalid JazzHR tenant");
  return tenant;
}

export function canonicalJazzHrUrl(tenant: string): string {
  return `https://${normalizeJazzHrTenant(tenant)}.applytojob.com/apply`;
}

function parseListings(html: string, origin: string): JazzHrListing[] {
  if (!/class=['"][^'"]*job-board-list\b/i.test(html)) {
    throw new Error("JazzHR page is missing the server-rendered job-board list");
  }
  const linkRe = /<h3\s+class=['"]list-group-item-heading['"][^>]*>\s*<a\s+href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>\s*<\/h3>/gi;
  const matches = [...html.matchAll(linkRe)];
  const listings: JazzHrListing[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const rawUrl = match[1].replace(/&amp;/gi, "&");
    let url: URL;
    try {
      url = new URL(rawUrl, origin);
    } catch {
      throw new Error("JazzHR listing contained an invalid job URL");
    }
    if (url.origin !== new URL(origin).origin) throw new Error("JazzHR listing contained a cross-tenant job URL");
    const pathMatch = url.pathname.match(/^\/apply\/([a-z0-9]{10})(?:\/|$)/i);
    if (!pathMatch) throw new Error("JazzHR listing contained a job without a stable public ID");
    const id = pathMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? html.indexOf("</main>", start);
    const segment = html.slice(start, end > start ? end : undefined);
    const location = segment.match(/fa-map-marker[^>]*><\/i>\s*([^<]+)/i)?.[1];
    const department = segment.match(/fa-sitemap[^>]*><\/i>\s*([^<]+)/i)?.[1];
    listings.push({
      id,
      title: stripHtml(match[2]),
      location: location ? stripHtml(location) : null,
      department: department ? stripHtml(department) : null,
      url: `${origin}/apply/${id}${url.pathname.slice(url.pathname.indexOf(id) + id.length)}`,
    });
  }
  return listings;
}

function listingJob(listing: JazzHrListing): NormalizedJob {
  return {
    externalId: listing.id,
    title: listing.title,
    location: listing.location,
    department: listing.department,
    url: listing.url,
    descriptionHtml: null,
    descriptionText: "",
    employmentType: null,
    workplaceType: null,
    salaryText: null,
    postedAt: null,
    raw: listing,
  };
}

function extractInputValueById(html: string, id: string): string | null {
  const input = html.match(new RegExp(`<input\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i"))?.[0];
  return input?.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? null;
}

function extractElementInnerHtmlById(html: string, id: string): string | null {
  const opening = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i").exec(html);
  if (!opening || opening.index === undefined) return null;
  const tag = opening[1];
  const contentStart = opening.index + opening[0].length;
  const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  tags.lastIndex = contentStart;
  let depth = 1;
  for (let token = tags.exec(html); token; token = tags.exec(html)) {
    if (/^<\//.test(token[0])) depth -= 1;
    else if (!/\/>$/.test(token[0])) depth += 1;
    if (depth === 0) return html.slice(contentStart, token.index);
  }
  return null;
}

/** JazzHR serves every current opening in the tenant board's initial HTML (its public board script
 * has no pagination or lazy-loading path). The shared U.S. gate runs on each listing card before
 * selected detail pages, whose JobPosting JSON-LD supplies full descriptions and dates. */
export async function fetchJazzHrJobs(
  tenantValue: string,
  options: FetchJazzHrJobsOptions = {}
): Promise<NormalizedJob[]> {
  const tenant = normalizeJazzHrTenant(tenantValue);
  const {
    hostOverride,
    maxJobs,
    detailConcurrency = 5,
    usOnly,
    existingExternalIds,
    onLocationFiltered,
    ...retryOptions
  } = options;
  const origin = (hostOverride ?? `https://${tenant}.applytojob.com`).replace(/\/$/, "");
  const boardUrl = `${origin}/apply`;
  const boardResponse = await fetchWithRetry(boardUrl, { headers: { Accept: "text/html" } }, retryOptions);
  const listings = parseListings(await boardResponse.text(), origin);
  const selected = filterJobsToUs(listings.map(listingJob),
    { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const perCallLimit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  return Promise.all(selected.map((listing) => {
    if (listing.lifecycleOnly) return listing;
    return perCallLimit(() => publicRequestLimit(async (): Promise<NormalizedJob> => {
      const detailResponse = await fetchWithRetry(listing.url, { headers: { Accept: "text/html" } }, retryOptions);
      const detailHtml = await detailResponse.text();
      const postings = extractJsonLdJobPostings(detailHtml);
      const detail = postings.find((posting) => {
        try {
          return new URL(posting.url ?? "").pathname.split("/").includes(listing.externalId!);
        } catch {
          return false;
        }
      });
      let descriptionHtml = detail?.descriptionHtml?.trim() || null;
      let detailSource: unknown = detail;
      if (!descriptionHtml) {
        const embeddedJobId = extractInputValueById(detailHtml, "resumator-job-value");
        const legacyDescription = extractElementInnerHtmlById(detailHtml, "job-description")?.trim();
        if (embeddedJobId !== listing.externalId || !legacyDescription) {
          throw new Error(`JazzHR job ${listing.externalId} has no identity-matched full description`);
        }
        descriptionHtml = legacyDescription;
        detailSource = { embeddedJobId, format: "legacy-html" };
      }
      const descriptionText = stripHtml(descriptionHtml);
      return {
        ...listing,
        title: detail?.title?.trim() || listing.title,
        location: detail?.location ?? listing.location,
        descriptionHtml,
        descriptionText,
        salaryText: extractSalaryText(descriptionText),
        postedAt: detail?.datePosted ?? null,
        raw: { tenant, listing: listing.raw, detail: detailSource },
      };
    }));
  }));
}
