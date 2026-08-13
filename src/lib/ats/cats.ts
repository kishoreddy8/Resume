import pLimit from "p-limit";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { extractSalaryText } from "@/lib/extractSalary";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { decodeHtmlEntities, stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface CatsListing { externalId: string; title: string; location: string; department: string | null; url: string }
export interface FetchCatsJobsOptions extends FetchWithRetryOptions, LocationFilterOptions { maxJobs?: number; hostOverride?: string; detailConcurrency?: number }

export function normalizeCatsToken(value: string): string {
  const [host, portalId, ...extra] = value.trim().toLowerCase().split("|");
  if (extra.length || !/^[a-z0-9-]+\.catsone\.com$/.test(host ?? "") || !/^\d+$/.test(portalId ?? "")) throw new Error("Invalid CATS portal token");
  return `${host}|${portalId}`;
}

export function canonicalCatsUrl(value: string): string {
  const [host, portalId] = normalizeCatsToken(value).split("|");
  return `https://${host}/careers/${portalId}`;
}

function parseListings(html: string, origin: string, portalId: string): CatsListing[] {
  if (!/Powered by[\s\S]*?catsone\.com/i.test(html) || !new RegExp(`href=["']/careers/${portalId}/register["']`, "i").test(html)) {
    throw new Error("CATS board identity does not match the requested public portal");
  }
  const jobs: CatsListing[] = [];
  const seen = new Set<string>();
  const rowPattern = new RegExp(`<a\\b[^>]*class=["'][^"']*table-row[^"']*["'][^>]*href=["'](/careers/${portalId}/jobs/(\\d+)-[^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>`, "gi");
  for (const row of html.matchAll(rowPattern)) {
    const id = row[2];
    const title = row[3].match(/<div\b[^>]*class=["'][^"']*title-cell[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
    const cells = [...row[3].matchAll(/<div\b([^>]*class=["'][^"']*data-cell[^"']*["'][^>]*)>([\s\S]*?)<\/div>/gi)]
      .map((cell) => ({ label: cell[1].match(/data-label=["']([^"']*)["']/i)?.[1] ?? "", value: stripHtml(decodeHtmlEntities(cell[2])).trim() }));
    const location = cells.find((cell) => cell.label === "Location")?.value;
    const department = cells.find((cell) => cell.label === "Category")?.value || null;
    if (!title || !location || seen.has(id)) throw new Error("CATS board has a duplicate job ID or missing title/location");
    seen.add(id);
    jobs.push({ externalId: id, title: stripHtml(decodeHtmlEntities(title)).trim(), location, department, url: `${origin}${row[1]}` });
  }
  if (jobs.length === 0 && !/We don't have any openings currently available/i.test(html)) throw new Error("CATS board returned no complete jobs snapshot");
  return jobs;
}

function parseDetail(html: string, listing: CatsListing, host: string, portalId: string): NormalizedJob {
  const canonicalValue = html.match(/<meta\b[^>]*(?:name=["']url["']\s+)?property=["']og:url["'][^>]*content=["']([^"']+)["']/i)?.[1];
  let canonical: URL;
  try { canonical = new URL(canonicalValue ?? ""); } catch { throw new Error(`CATS job ${listing.externalId} has no canonical identity`); }
  const expectedPath = new URL(listing.url).pathname;
  const applyPath = `${expectedPath}/apply`;
  const title = html.match(/<div\b[^>]*class=["'][^"']*job-header[^"']*["'][^>]*>[\s\S]*?<h1>([\s\S]*?)<\/h1>/i)?.[1];
  const description = html.match(/<div\b[^>]*class=["'][^"']*job-description["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<aside>/i)?.[1];
  if (canonical.hostname.toLowerCase() !== host || canonical.pathname !== expectedPath
    || !new RegExp(`href=["']${applyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(html)
    || !new RegExp(`^/careers/${portalId}/jobs/${listing.externalId}-`).test(expectedPath) || !title || !description) {
    throw new Error(`CATS job ${listing.externalId} has mismatched portal/apply identity or no full description`);
  }
  const descriptionHtml = description.trim(); const descriptionText = stripHtml(descriptionHtml);
  if (!descriptionText) throw new Error(`CATS job ${listing.externalId} has an empty description`);
  return { externalId: listing.externalId, title: stripHtml(decodeHtmlEntities(title)).trim(), location: listing.location,
    department: listing.department, url: listing.url, descriptionHtml, descriptionText, employmentType: null,
    workplaceType: /\bremote\b/i.test(listing.location) ? "Remote" : null, salaryText: extractSalaryText(descriptionText), postedAt: null,
    raw: { listing } };
}

/** The CATS public Remix loader server-renders its complete jobs array without paging. Structured
 * listing locations are filtered before exact same-portal detail pages are requested. */
export async function fetchCatsJobs(tokenValue: string, options: FetchCatsJobsOptions = {}): Promise<NormalizedJob[]> {
  const token = normalizeCatsToken(tokenValue); const [host, portalId] = token.split("|");
  const { hostOverride, maxJobs, detailConcurrency = 5, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = (hostOverride ?? `https://${host}`).replace(/\/$/, "");
  const response = await fetchWithRetry(`${origin}/careers/${portalId}`, { headers: { Accept: "text/html" } }, retryOptions);
  const listings = parseListings(await response.text(), origin, portalId).map((job): NormalizedJob => ({ ...job,
    descriptionHtml: null, descriptionText: "", employmentType: null, workplaceType: null, salaryText: null, postedAt: null, raw: job }));
  const selected = filterJobsToUs(listings, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const limit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  return Promise.all(selected.map((job) => job.lifecycleOnly ? job : limit(async () => {
    const listing = job.raw as CatsListing;
    const detail = await fetchWithRetry(listing.url, { headers: { Accept: "text/html" } }, retryOptions);
    return parseDetail(await detail.text(), listing, new URL(origin).hostname, portalId);
  })));
}
