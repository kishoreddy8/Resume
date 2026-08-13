import pLimit from "p-limit";
import { extractJsonLdJobPostings } from "@/lib/ats/jobValidation";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { extractSalaryText } from "@/lib/extractSalary";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface BreezyListing {
  id: string;
  title: string;
  locations: Set<string>;
  department: string | null;
  url: string;
}

export interface FetchBreezyJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production uses the tenant's breezy.hr origin. */
  hostOverride?: string;
  detailConcurrency?: number;
}

const publicRequestLimit = pLimit(5);

export function normalizeBreezyTenant(value: string): string {
  const tenant = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(tenant) || tenant === "www" || tenant === "app") throw new Error("Invalid Breezy HR tenant");
  return tenant;
}

export function canonicalBreezyUrl(tenant: string): string {
  return `https://${normalizeBreezyTenant(tenant)}.breezy.hr/`;
}

function parseListings(html: string, origin: string): BreezyListing[] {
  if (!/class=["'][^"']*\bpositions-container\b/i.test(html)) throw new Error("Breezy HR page is missing its positions container");
  const linkRe = /<a\b[^>]*href=["'](\/p\/([a-f0-9]{12})-[^"']+)["'][^>]*>\s*<h2>([\s\S]*?)<\/h2>/gi;
  const matches = [...html.matchAll(linkRe)];
  const byId = new Map<string, BreezyListing>();
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const before = html.slice(0, match.index);
    const groupHeaders = [...before.matchAll(/<h2\b[^>]*class=["'][^"']*\bgroup-header\b[^"']*["'][^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>[\s\S]*?<\/h2>/gi)];
    const location = groupHeaders.length ? stripHtml(groupHeaders.at(-1)![1]) : "";
    const end = matches[index + 1]?.index ?? html.length;
    const segment = html.slice(match.index, end);
    const cardLocationHtml = segment.match(/class=["'][^"']*\blocation\b[^"']*["'][^>]*>[\s\S]*?<span(?:\b[^>]*)?>([\s\S]*?)<\/span>/i)?.[1];
    const cardLocation = cardLocationHtml ? stripHtml(cardLocationHtml) : "";
    const concreteLocation = cardLocation && !/%LABEL_MULTIPLE_LOCATIONS%/i.test(cardLocation) ? cardLocation : location;
    const departmentHtml = segment.match(/class=["'][^"']*\bdepartment\b[^"']*["'][^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i)?.[1];
    const id = match[2].toLowerCase();
    const existing = byId.get(id);
    if (existing) {
      if (concreteLocation) existing.locations.add(concreteLocation);
      continue;
    }
    byId.set(id, {
      id,
      title: stripHtml(match[3]),
      locations: new Set(concreteLocation ? [concreteLocation] : []),
      department: departmentHtml ? stripHtml(departmentHtml) : null,
      url: `${origin}${match[1]}`,
    });
  }
  return [...byId.values()];
}

function extractLegacyDescription(html: string, externalId: string): string | null {
  const embeddedId = html.match(/\bvar\s+positionId\s*=\s*["']([a-f0-9]{12})["']/i)?.[1]?.toLowerCase();
  if (embeddedId !== externalId) return null;
  const opening = /<div\b[^>]*class=["'][^"']*\bdescription\b[^"']*["'][^>]*>/i.exec(html);
  if (!opening || opening.index === undefined) return null;
  const start = opening.index + opening[0].length;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 1;
  for (let token = tags.exec(html); token; token = tags.exec(html)) {
    if (/^<\//.test(token[0])) depth -= 1;
    else if (!/\/>$/.test(token[0])) depth += 1;
    if (depth === 0) return html.slice(start, token.index).trim() || null;
  }
  return null;
}

function listingJob(listing: BreezyListing): NormalizedJob {
  return {
    externalId: listing.id,
    title: listing.title,
    location: listing.locations.size ? [...listing.locations].join("; ") : null,
    department: listing.department,
    url: listing.url,
    descriptionHtml: null,
    descriptionText: "",
    employmentType: null,
    workplaceType: null,
    salaryText: null,
    postedAt: null,
    raw: { ...listing, locations: [...listing.locations] },
  };
}

/** Breezy HR publishes the full grouped opening list in initial HTML. Duplicate cards for
 * multi-location roles are collapsed by stable 12-character position ID before the U.S. gate. */
export async function fetchBreezyJobs(tenantValue: string, options: FetchBreezyJobsOptions = {}): Promise<NormalizedJob[]> {
  const tenant = normalizeBreezyTenant(tenantValue);
  const { hostOverride, maxJobs, detailConcurrency = 5, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = (hostOverride ?? `https://${tenant}.breezy.hr`).replace(/\/$/, "");
  const response = await fetchWithRetry(`${origin}/`, { headers: { Accept: "text/html" } }, retryOptions);
  const selected = filterJobsToUs(parseListings(await response.text(), origin).map(listingJob),
    { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const perCallLimit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  return Promise.all(selected.map((listing) => {
    if (listing.lifecycleOnly) return listing;
    return perCallLimit(() => publicRequestLimit(async (): Promise<NormalizedJob> => {
      const detailResponse = await fetchWithRetry(listing.url, { headers: { Accept: "text/html" } }, retryOptions);
      const detailHtml = await detailResponse.text();
      const detail = extractJsonLdJobPostings(detailHtml).find((posting) => {
        try { return new URL(posting.url ?? "").pathname.split("/")[2]?.toLowerCase().startsWith(`${listing.externalId}-`) === true; }
        catch { return false; }
      });
      const descriptionHtml = detail?.descriptionHtml?.trim() || extractLegacyDescription(detailHtml, listing.externalId!);
      if (!descriptionHtml) throw new Error(`Breezy HR job ${listing.externalId} has no identity-matched full description`);
      const descriptionText = stripHtml(descriptionHtml);
      return {
        ...listing,
        title: detail?.title?.trim() || listing.title,
        location: listing.location ?? detail?.location ?? null,
        descriptionHtml,
        descriptionText,
        salaryText: extractSalaryText(descriptionText),
        postedAt: detail?.datePosted ?? null,
        raw: { listing: listing.raw, detail },
      };
    }));
  }));
}
