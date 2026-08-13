import pLimit from "p-limit";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { extractSalaryText } from "@/lib/extractSalary";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface ClearCompanyListing {
  requisitionId: string;
  locationId: string;
  title: string;
  department: string | null;
  location: string | null;
  url: string;
}

export interface FetchClearCompanyJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin overrides. Production derives both exact tenant origins. */
  hostOverride?: string;
  postingsHostOverride?: string;
  detailConcurrency?: number;
}

const publicRequestLimit = pLimit(5);

export function normalizeClearCompanyTenant(value: string): string {
  const tenant = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(tenant) || tenant === "www") throw new Error("Invalid ClearCompany tenant");
  return tenant;
}

export function canonicalClearCompanyUrl(tenant: string): string {
  return `https://${normalizeClearCompanyTenant(tenant)}.clearcompany.com/careers/jobs`;
}

function decodeLegacyHtml(response: Response): Promise<string> {
  return response.arrayBuffer().then((buffer) => new TextDecoder("windows-1252").decode(buffer));
}

function extractNestedDiv(html: string, className: string): string | null {
  const opening = new RegExp(`<div\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`, "i").exec(html);
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

function cell(row: string, className: string): string | null {
  const value = row.match(new RegExp(`<td\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/td>`, "i"))?.[1];
  return value ? stripHtml(value) || null : null;
}

function parseListings(html: string, postingsOrigin: string): ClearCompanyListing[] {
  if (!/<form\b[^>]*action=["']job-openings\.php["'][^>]*>[\s\S]*?name=["']search["'][^>]*value=["']true["']/i.test(html)
    || !/class=["'][^"']*\breqResult\b/i.test(html)) throw new Error("ClearCompany HRMDirect response is not its all-jobs board");
  if (/<a\b[^>]*href=["'][^"']*[?&](?:page|offset)=/i.test(html)) throw new Error("ClearCompany HRMDirect board unexpectedly requires pagination");
  const rows = [...html.matchAll(/<tr\b[^>]*data-req-id=["'](\d+)["'][^>]*>([\s\S]*?)<\/tr>/gi)];
  const seen = new Set<string>();
  return rows.map((match, index) => {
    const requisitionId = match[1];
    const locationId = match[2].match(/job-opening\.php\?req=(\d+)&(?:amp;)?req_loc=(\d*)/i)?.[2];
    const rowIndex = match[2].match(/id=["']posTitle(\d+)["']/i)?.[1];
    const title = cell(match[2], "posTitle");
    if (locationId === undefined || rowIndex !== String(index) || !title) throw new Error("ClearCompany listing row has an incomplete or unstable identity");
    const externalId = `${requisitionId}:${locationId || "none"}`;
    if (seen.has(externalId)) throw new Error("ClearCompany listing contains a duplicate requisition location");
    seen.add(externalId);
    const city = cell(match[2], "cities");
    const state = cell(match[2], "state");
    return {
      requisitionId,
      locationId,
      title,
      department: cell(match[2], "departments"),
      location: [city, state].filter(Boolean).join(", ") || null,
      url: `${postingsOrigin}/employment/job-opening.php?req=${requisitionId}&req_loc=${locationId}`,
    };
  });
}

function listingJob(listing: ClearCompanyListing): NormalizedJob {
  return { externalId: `${listing.requisitionId}:${listing.locationId || "none"}`, title: listing.title, location: listing.location,
    department: listing.department, url: listing.url, descriptionHtml: null, descriptionText: "", employmentType: null,
    workplaceType: null, salaryText: null, postedAt: null, raw: listing };
}

/** ClearCompany's public tenant API resolves to an exact same-tenant HRMDirect board. An explicit
 * all-filter request returns its complete non-paginated table; U.S. filtering precedes details. */
export async function fetchClearCompanyJobs(tenantValue: string, options: FetchClearCompanyJobsOptions = {}): Promise<NormalizedJob[]> {
  const tenant = normalizeClearCompanyTenant(tenantValue);
  const { hostOverride, postingsHostOverride, maxJobs, detailConcurrency = 5, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = (hostOverride ?? `https://${tenant}.clearcompany.com`).replace(/\/$/, "");
  const expectedPostingsOrigin = (postingsHostOverride ?? `https://${tenant}.hrmdirect.com`).replace(/\/$/, "");
  const portal = await fetchWithRetry(`${origin}/careers/portal`, { headers: { Accept: "text/html" } }, retryOptions);
  const portalHtml = await portal.text();
  if (!new RegExp(`window\\.\\$ccShortName\\s*=\\s*["']${tenant}["']`, "i").test(portalHtml)) {
    throw new Error("ClearCompany portal tenant identity does not match");
  }
  const mapping = await fetchWithRetry(`${origin}/api/v1/careers/jobs/postings-url`, { headers: {
    Accept: "application/json", "X-Requested-With": "XMLHttpRequest", "API-ShortName": tenant,
  } }, retryOptions);
  const postingsUrl = await mapping.json() as unknown;
  if (postingsUrl !== `${expectedPostingsOrigin}/employment/job-openings.php`) throw new Error("ClearCompany postings URL is not the exact tenant board");
  const listUrl = `${expectedPostingsOrigin}/employment/job-openings.php?search=true&dept=-1&city=-1&state=-1&office=-1`;
  const listResponse = await fetchWithRetry(listUrl, { headers: { Accept: "text/html" } }, retryOptions);
  const selected = filterJobsToUs(parseListings(await decodeLegacyHtml(listResponse), expectedPostingsOrigin).map(listingJob),
    { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const perCallLimit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  return Promise.all(selected.map((listing) => {
    if (listing.lifecycleOnly) return listing;
    return perCallLimit(() => publicRequestLimit(async (): Promise<NormalizedJob> => {
      const response = await fetchWithRetry(listing.url, { headers: { Accept: "text/html" } }, retryOptions);
      const html = await decodeLegacyHtml(response);
      const [requisitionId, locationToken] = listing.externalId!.split(":");
      const locationId = locationToken === "none" ? "" : locationToken;
      const canonical = html.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i)?.[1];
      if (canonical !== `${expectedPostingsOrigin}/employment/job-opening.php?req=${requisitionId}&req_loc=${locationId}`
        || !new RegExp(`Apply\\.aspx\\?req_id=${requisitionId}(?:&|&amp;)`, "i").test(html)) {
        throw new Error(`ClearCompany job ${listing.externalId} has a mismatched detail identity`);
      }
      const descriptionHtml = extractNestedDiv(html, "jobDesc");
      if (!descriptionHtml) throw new Error(`ClearCompany job ${listing.externalId} has no full description`);
      const descriptionText = stripHtml(descriptionHtml);
      return { ...listing, descriptionHtml, descriptionText, salaryText: extractSalaryText(descriptionText), raw: { listing: listing.raw } };
    }));
  }));
}
