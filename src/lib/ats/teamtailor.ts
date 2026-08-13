import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { extractSalaryText } from "@/lib/extractSalary";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { decodeHtmlEntities, stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

export interface FetchTeamtailorJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production uses the tenant's teamtailor.com origin. */
  hostOverride?: string;
}

export function normalizeTeamtailorTenant(value: string): string {
  const tenant = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(tenant) || tenant === "www") throw new Error("Invalid Teamtailor tenant");
  return tenant;
}

export function canonicalTeamtailorUrl(tenant: string): string {
  return `https://${normalizeTeamtailorTenant(tenant)}.teamtailor.com/jobs`;
}

function xmlValue(fragment: string, tag: string): string | null {
  const match = fragment.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeHtmlEntities(match[1].trim()) : null;
}

function parseDate(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseFeed(xml: string, origin: string, tenant: string): NormalizedJob[] {
  if (!/^\s*<\?xml\b/i.test(xml) || !/<rss\b[^>]*xmlns:tt=["']https:\/\/teamtailor\.com\/locations["']/i.test(xml)) {
    throw new Error("Teamtailor response is not its public jobs RSS feed");
  }
  const channelLink = xmlValue(xml.slice(0, xml.indexOf("<item>")), "link");
  if (channelLink !== canonicalTeamtailorUrl(tenant)) throw new Error("Teamtailor feed identity does not match the requested tenant");
  const jobs: NormalizedJob[] = [];
  const seen = new Set<string>();
  for (const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const title = xmlValue(item[1], "title");
    const urlValue = xmlValue(item[1], "link");
    const descriptionHtml = xmlValue(item[1], "description");
    if (!title || !urlValue || !descriptionHtml) throw new Error("Teamtailor feed item is missing title, link, or full description");
    let url: URL;
    try { url = new URL(urlValue); } catch { throw new Error("Teamtailor feed item has an invalid URL"); }
    const identity = url.pathname.match(/^\/jobs\/(\d+)(?:-|$)/);
    if (url.origin !== origin || !identity) throw new Error("Teamtailor feed item has a mismatched tenant or unstable job ID");
    if (seen.has(identity[1])) continue;
    seen.add(identity[1]);
    const locations = [...item[1].matchAll(/<tt:location>([\s\S]*?)<\/tt:location>/gi)].map((location) => {
      const parts = [xmlValue(location[1], "tt:name"), xmlValue(location[1], "tt:city"), xmlValue(location[1], "tt:country")].filter(Boolean);
      return [...new Set(parts)].join(", ");
    }).filter(Boolean);
    const remoteStatus = xmlValue(item[1], "remoteStatus");
    const descriptionText = stripHtml(descriptionHtml);
    jobs.push({
      externalId: identity[1],
      title: stripHtml(title),
      location: locations.length ? [...new Set(locations)].join("; ") : remoteStatus === "fully" ? "Remote" : null,
      department: xmlValue(item[1], "tt:department"),
      url: url.href,
      descriptionHtml,
      descriptionText,
      employmentType: null,
      workplaceType: remoteStatus && remoteStatus !== "none" ? remoteStatus : null,
      salaryText: extractSalaryText(descriptionText),
      postedAt: parseDate(xmlValue(item[1], "pubDate")),
      raw: { guid: xmlValue(item[1], "guid"), remoteStatus, locations },
    });
  }
  return jobs;
}

/** Teamtailor's public RSS feed is a complete, non-paginated board snapshot containing full job
 * descriptions and structured locations, so U.S. filtering requires no detail-page requests. */
export async function fetchTeamtailorJobs(tenantValue: string, options: FetchTeamtailorJobsOptions = {}): Promise<NormalizedJob[]> {
  const tenant = normalizeTeamtailorTenant(tenantValue);
  const { hostOverride, maxJobs, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = (hostOverride ?? `https://${tenant}.teamtailor.com`).replace(/\/$/, "");
  const response = await fetchWithRetry(`${origin}/jobs.rss`, { headers: { Accept: "application/rss+xml, application/xml" } }, retryOptions);
  return filterJobsToUs(parseFeed(await response.text(), origin, tenant),
    { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
}
