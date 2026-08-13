import pLimit from "p-limit";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { extractSalaryText } from "@/lib/extractSalary";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { decodeHtmlEntities, stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface NewtonListing { externalId: string; title: string; location: string; url: string }
export interface FetchNewtonJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  originOverride?: string;
  detailConcurrency?: number;
}

export function normalizeNewtonClientId(value: string): string {
  const clientId = value.trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(clientId)) throw new Error("Invalid Newton/Paycor client ID");
  return clientId;
}

export function canonicalNewtonUrl(value: string): string {
  return `https://recruitingbypaycor.com/career/CareerHome.action?clientId=${normalizeNewtonClientId(value)}`;
}

function parseListings(html: string, origin: string, clientId: string): NewtonListing[] {
  if (!new RegExp(`<form\\b[^>]*name=["']candidateHome["'][^>]*action=["']${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/career/CareerHomeSearch\\.action["']`, "i").test(html)) {
    throw new Error("Newton/Paycor board identity does not match the requested client");
  }
  const jobs: NewtonListing[] = [];
  const seen = new Set<string>();
  const rowPattern = /<div\b[^>]*class=["'][^"']*gnewtonCareerGroupRowClass[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*gnewtonCareerGroup(?:Row|Header)Class|<\/form>)/gi;
  for (const row of html.matchAll(rowPattern)) {
    const link = row[1].match(/<a\b[^>]*href=["']([^"']*JobIntroduction\.action\?[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const locationHtml = row[1].match(/gnewtonCareerGroupJobDescriptionClass[^>]*>([\s\S]*?)<\/div>/i)?.[1];
    if (!link || !locationHtml) throw new Error("Newton/Paycor listing row is incomplete");
    const url = new URL(decodeHtmlEntities(link[1]), `${origin}/career/`);
    const externalId = url.searchParams.get("id") ?? "";
    if (url.origin !== origin || url.pathname !== "/career/JobIntroduction.action"
      || url.searchParams.get("clientId")?.toLowerCase() !== clientId || !/^[a-f0-9]{32}$/.test(externalId) || seen.has(externalId)) {
      throw new Error("Newton/Paycor listing contains a mismatched or duplicate job identity");
    }
    const title = stripHtml(decodeHtmlEntities(link[2])).trim();
    const location = stripHtml(decodeHtmlEntities(locationHtml)).trim();
    if (!title || !location) throw new Error("Newton/Paycor listing is missing title/location");
    seen.add(externalId);
    url.search = new URLSearchParams({ clientId, id: externalId, source: "", lang: "en" }).toString();
    jobs.push({ externalId, title, location, url: url.toString() });
  }
  if (jobs.length === 0 && !/(?:no|don't have any) (?:current )?(?:jobs|positions|openings)/i.test(stripHtml(html))) {
    throw new Error("Newton/Paycor board returned no complete jobs snapshot");
  }
  return jobs;
}

function parseDetail(html: string, listing: NewtonListing, origin: string, clientId: string): NormalizedJob {
  const apply = html.match(/<form\b[^>]*id=["']gravityApplyJob["'][^>]*action=["']([^"']+)["']/i)?.[1];
  const titleHtml = html.match(/<td\b[^>]*id=["']gnewtonJobPosition["'][^>]*>([\s\S]*?)<\/td>/i)?.[1];
  const locationHtml = html.match(/<td\b[^>]*id=["']gnewtonJobLocationInfo["'][^>]*>([\s\S]*?)<\/td>/i)?.[1];
  const descriptionHtml = html.match(/<td\b[^>]*id=["']gnewtonJobDescriptionText["'][^>]*>([\s\S]*?)<\/td>/i)?.[1]?.trim();
  let applyUrl: URL;
  try { applyUrl = new URL(decodeHtmlEntities(apply ?? ""), origin); } catch { throw new Error(`Newton/Paycor job ${listing.externalId} has no apply identity`); }
  const title = titleHtml ? stripHtml(decodeHtmlEntities(titleHtml)).replace(/^Position:\s*/i, "").trim() : "";
  const location = locationHtml ? stripHtml(decodeHtmlEntities(locationHtml)).trim() : "";
  if (applyUrl.origin !== origin || applyUrl.pathname !== "/career/SubmitResume.action"
    || applyUrl.searchParams.get("clientId")?.toLowerCase() !== clientId
    || applyUrl.searchParams.get("id") !== listing.externalId || title !== listing.title || !location || !descriptionHtml) {
    throw new Error(`Newton/Paycor job ${listing.externalId} has mismatched client/job identity or no full description`);
  }
  const descriptionText = stripHtml(decodeHtmlEntities(descriptionHtml));
  if (!descriptionText) throw new Error(`Newton/Paycor job ${listing.externalId} has an empty description`);
  return { externalId: listing.externalId, title, location, department: null, url: listing.url,
    descriptionHtml, descriptionText, employmentType: null, workplaceType: /\bremote\b/i.test(location) ? "Remote" : null,
    salaryText: extractSalaryText(descriptionText), postedAt: null, raw: { listing } };
}

/** Legacy Newton boards redirect to Recruiting by Paycor. CareerHome is a complete server-rendered
 * snapshot; structured locations are filtered before exact client-ID/job-ID detail requests. */
export async function fetchNewtonJobs(clientIdValue: string, options: FetchNewtonJobsOptions = {}): Promise<NormalizedJob[]> {
  const clientId = normalizeNewtonClientId(clientIdValue);
  const { maxJobs, originOverride = "https://recruitingbypaycor.com", detailConcurrency = 5,
    usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = originOverride.replace(/\/$/, "");
  const headers = { Accept: "text/html", "User-Agent": "Mozilla/5.0" };
  const list = await fetchWithRetry(`${origin}/career/CareerHome.action?clientId=${clientId}`, { headers }, retryOptions);
  const listings = parseListings(await list.text(), origin, clientId).map((job): NormalizedJob => ({ ...job,
    department: null, descriptionHtml: null, descriptionText: "", employmentType: null, workplaceType: null,
    salaryText: null, postedAt: null, raw: job }));
  const selected = filterJobsToUs(listings, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const limit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  return Promise.all(selected.map((job) => job.lifecycleOnly ? job : limit(async () => {
    const listing = job.raw as NewtonListing;
    const response = await fetchWithRetry(listing.url, { headers }, retryOptions);
    return parseDetail(await response.text(), listing, new URL(origin).origin, clientId);
  })));
}
