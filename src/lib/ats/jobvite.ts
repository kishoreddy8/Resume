import pLimit from "p-limit";
import { extractSalaryText } from "@/lib/extractSalary";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface JobviteListing {
  id: string;
  title: string;
  location: string | null;
  department: string | null;
  url: string;
}

interface JobvitePosting {
  "@type"?: string | string[];
  identifier?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  employmentType?: string;
  industry?: string;
}

export interface FetchJobviteJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production uses jobs.jobvite.com. */
  hostOverride?: string;
  detailConcurrency?: number;
}

const publicRequestLimit = pLimit(5);

export function normalizeJobviteTenant(value: string): string {
  const tenant = value.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(tenant) || tenant === "careers" || tenant === "your-careersite-name") {
    throw new Error("Invalid Jobvite careers-site tenant");
  }
  return tenant;
}

export function canonicalJobviteUrl(tenant: string): string {
  return `https://jobs.jobvite.com/${normalizeJobviteTenant(tenant)}/jobs`;
}

function parseListings(html: string, tenant: string, origin: string): JobviteListing[] {
  if (!/\bjv-page-jobs\b/i.test(html) || !/\bjv-job-list\b/i.test(html)) {
    throw new Error("Jobvite page is missing its server-rendered job list");
  }
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const listings: JobviteListing[] = [];
  const seen = new Set<string>();
  for (const row of html.matchAll(rowRe)) {
    const link = row[1].match(/class=["'][^"']*jv-job-list-name[^"']*["'][\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    let url: URL;
    try {
      url = new URL(link[1].replace(/&amp;/gi, "&"), origin);
    } catch {
      throw new Error("Jobvite listing contained an invalid job URL");
    }
    if (url.origin !== new URL(origin).origin) throw new Error("Jobvite listing contained a cross-origin job URL");
    const identity = url.pathname.match(new RegExp(`^/${tenant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([a-z0-9_-]+)$`, "i"));
    if (!identity || seen.has(identity[1])) continue;
    seen.add(identity[1]);
    const location = row[1].match(/class=["'][^"']*jv-job-list-location[^"']*["'][^>]*>([\s\S]*?)<\/td>/i)?.[1];
    const beforeRow = html.slice(0, row.index);
    const departments = [...beforeRow.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)];
    listings.push({
      id: identity[1],
      title: stripHtml(link[2]),
      location: location ? stripHtml(location) : null,
      department: departments.length ? stripHtml(departments.at(-1)![1]) : null,
      url: `${origin}/${tenant}/job/${identity[1]}`,
    });
  }
  return listings;
}

function parsePosting(html: string, externalId: string): JobvitePosting {
  const scripts = html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    try {
      const posting = JSON.parse(script[1].trim()) as JobvitePosting;
      const type = posting["@type"];
      if ((type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) && posting.identifier === externalId) {
        return posting;
      }
    } catch {
      // Ignore unrelated malformed structured-data blocks; exact Jobvite identity is required below.
    }
  }
  throw new Error(`Jobvite job ${externalId} has no identity-matched JobPosting detail`);
}

function extractLegacyDescription(html: string, externalId: string): string | null {
  const embeddedId = html.match(/function\s+getJobId\s*\(\)\s*\{\s*return\s+["']([^"']+)["']/i)?.[1];
  if (embeddedId !== externalId) return null;
  const opening = /<div\b[^>]*class=["'][^"']*\bjv-job-detail-description\b[^"']*["'][^>]*>/i.exec(html);
  if (!opening || opening.index === undefined) return null;
  const start = opening.index + opening[0].length;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 1;
  for (let token = tags.exec(html); token; token = tags.exec(html)) {
    if (/^<\//.test(token[0])) depth -= 1;
    else if (!/\/>$/.test(token[0])) depth += 1;
    if (depth === 0) {
      const value = html.slice(start, token.index)
        .replace(/<img\b[^>]*src=["']data:[^"']*["'][^>]*>/gi, "")
        .trim();
      return value || null;
    }
  }
  return null;
}

function listingJob(listing: JobviteListing): NormalizedJob {
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

/** Jobvite's public careers-site response contains its complete job tables in initial HTML. The
 * U.S. gate runs on those lightweight rows before exact-ID detail pages are requested. */
export async function fetchJobviteJobs(
  tenantValue: string,
  options: FetchJobviteJobsOptions = {}
): Promise<NormalizedJob[]> {
  const tenant = normalizeJobviteTenant(tenantValue);
  const { hostOverride, maxJobs, detailConcurrency = 5, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = (hostOverride ?? "https://jobs.jobvite.com").replace(/\/$/, "");
  const response = await fetchWithRetry(`${origin}/${tenant}/jobs`, { headers: { Accept: "text/html" } }, retryOptions);
  const listings = parseListings(await response.text(), tenant, origin);
  const selected = filterJobsToUs(listings.map(listingJob), { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const perCallLimit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  return Promise.all(selected.map((listing) => {
    if (listing.lifecycleOnly) return listing;
    return perCallLimit(() => publicRequestLimit(async (): Promise<NormalizedJob> => {
      const detailResponse = await fetchWithRetry(listing.url, { headers: { Accept: "text/html" } }, retryOptions);
      const detailHtml = await detailResponse.text();
      let detail: JobvitePosting;
      try {
        detail = parsePosting(detailHtml, listing.externalId!);
      } catch {
        detail = { identifier: listing.externalId!, "@type": "JobPosting" };
      }
      const descriptionHtml = detail.description?.trim() || extractLegacyDescription(detailHtml, listing.externalId!) || null;
      const descriptionText = descriptionHtml ? stripHtml(descriptionHtml) : "";
      return {
        ...listing,
        title: detail.title?.trim() || listing.title,
        department: detail.industry?.trim() || listing.department,
        descriptionHtml,
        descriptionText,
        employmentType: detail.employmentType?.trim() || null,
        salaryText: extractSalaryText(descriptionText),
        postedAt: detail.datePosted?.trim() || null,
        raw: { listing: listing.raw, detail },
      };
    }));
  }));
}
