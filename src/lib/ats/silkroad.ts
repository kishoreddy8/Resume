import pLimit from "p-limit";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { extractSalaryText } from "@/lib/extractSalary";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { decodeHtmlEntities, stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface SilkRoadListing { externalId: string; title: string; location: string; department: string | null; url: string }
interface ParsedPage { page: number; totalPages: number; jobs: SilkRoadListing[] }
export interface FetchSilkRoadJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number; originOverride?: string; listingConcurrency?: number; detailConcurrency?: number;
}

export function normalizeSilkRoadToken(value: string): string {
  const [account, site, ...extra] = value.trim().split("|");
  if (extra.length || !/^[A-Za-z0-9_-]+$/.test(account ?? "") || !/^[A-Za-z0-9_-]+$/.test(site ?? "")) throw new Error("Invalid SilkRoad account/site token");
  return `${account}|${site}`;
}
export function canonicalSilkRoadUrl(value: string): string {
  const [account, site] = normalizeSilkRoadToken(value).split("|");
  return `https://jobs.silkroad.com/${account}/${site}`;
}

function parsePage(html: string, origin: string, account: string, site: string): ParsedPage {
  const pager = html.match(/id=["']Jobs_PagedJobList_CurrentPageText["'][^>]*>\s*Page\s+(\d+)\s+of\s+(\d+)/i);
  const company = html.match(/id=["']Jobs_JobsList_CompanyName["'][^>]*>([\s\S]*?)<\/h1>/i);
  if (!pager || !company || !stripHtml(decodeHtmlEntities(company[1])).trim()) throw new Error("SilkRoad board has no exact page/company identity");
  const page = Number(pager[1]); const totalPages = Number(pager[2]);
  if (!Number.isInteger(page) || !Number.isInteger(totalPages) || page < 1 || totalPages < page || totalPages > 500) throw new Error("SilkRoad board returned invalid pagination");
  const jobs: SilkRoadListing[] = []; let department: string | null = null;
  const item = /<h2\b[^>]*id=["']Jobs_PagedJobList_Category__[^"']+["'][^>]*>([\s\S]*?)<\/h2>|<a\b[^>]*id=["']Jobs_PagedJobList_Job-(\d+)["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(item)) {
    if (match[1] !== undefined) { department = stripHtml(decodeHtmlEntities(match[1])).trim() || null; continue; }
    const externalId = match[2]; const url = new URL(decodeHtmlEntities(match[3]), origin);
    const titleHtml = match[4].match(/id=["']Jobs_PagedJobList_JobTitle-\d+["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
    const locationHtml = match[4].match(/id=["']Jobs_PagedJobList_JobLocation-\d+["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
    const expectedPath = `/${account}/${site}/jobs/${externalId}`;
    const title = titleHtml ? stripHtml(decodeHtmlEntities(titleHtml)).trim() : "";
    const location = locationHtml ? stripHtml(decodeHtmlEntities(locationHtml)).trim() : "";
    if (url.origin !== origin || url.pathname !== expectedPath || !title || !location) throw new Error(`SilkRoad job ${externalId} has incomplete listing identity`);
    jobs.push({ externalId, title, location, department, url: `${origin}${expectedPath}` });
  }
  if (jobs.length === 0 && !/(?:no jobs|no positions|no opportunities)/i.test(stripHtml(html))) throw new Error("SilkRoad page has no complete job rows");
  return { page, totalPages, jobs };
}

function parseDetail(html: string, listing: SilkRoadListing, origin: string, account: string, site: string): NormalizedJob {
  const canonicalValue = html.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i)?.[1];
  const titleHtml = html.match(/id=["']Jobs_JobDetail_TitleText["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const locationHtml = html.match(/id=["']Jobs_JobDetail_LocationText["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
  const descriptionHtml = html.match(/<div\b[^>]*id=["']Jobs_JobDetail_JobDescriptionText["'][^>]*>([\s\S]*?)<\/div>\s*(?:<div\b[^>]*id=["']Jobs_JobDetail_JobRequirementsText|<\/section>)/i)?.[1]?.trim()
    ?? html.match(/<div\b[^>]*id=["']Jobs_JobDetail_JobDescriptionText["'][^>]*>([\s\S]*?)<\/div>\s*<\/section>/i)?.[1]?.trim();
  const applyPath = `/${account}/${site}/Apply/MultiForm/${listing.externalId}`;
  let canonical: URL; try { canonical = new URL(canonicalValue ?? "", origin); } catch { throw new Error(`SilkRoad job ${listing.externalId} has no canonical identity`); }
  const title = titleHtml ? stripHtml(decodeHtmlEntities(titleHtml)).trim() : "";
  const location = locationHtml ? stripHtml(decodeHtmlEntities(locationHtml)).trim() : "";
  if (canonical.hostname !== new URL(origin).hostname || canonical.pathname !== `/${account}/${site}/jobs/${listing.externalId}`
    || !new RegExp(`href=["']${applyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "i").test(html)
    || title !== listing.title || !location || !descriptionHtml) throw new Error(`SilkRoad job ${listing.externalId} has mismatched board/apply identity or no full description`);
  const descriptionText = stripHtml(decodeHtmlEntities(descriptionHtml));
  if (!descriptionText) throw new Error(`SilkRoad job ${listing.externalId} has an empty description`);
  const employmentType = html.match(/id=["']Jobs_JobDetail_JobPositionTypeText["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
  return { externalId: listing.externalId, title, location, department: listing.department, url: listing.url,
    descriptionHtml, descriptionText, employmentType: employmentType ? stripHtml(decodeHtmlEntities(employmentType)).trim() : null,
    workplaceType: /\bremote\b/i.test(location) ? "Remote" : null, salaryText: extractSalaryText(descriptionText), postedAt: null, raw: { listing } };
}

/** SilkRoad exposes exact numbered HTML pages. Every page is exhausted and checked against the
 * same total before the U.S. gate and exact board/job detail requests. */
export async function fetchSilkRoadJobs(tokenValue: string, options: FetchSilkRoadJobsOptions = {}): Promise<NormalizedJob[]> {
  const token = normalizeSilkRoadToken(tokenValue); const [account, site] = token.split("|");
  const { maxJobs, originOverride = "https://jobs.silkroad.com", listingConcurrency = 3, detailConcurrency = 5,
    usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = originOverride.replace(/\/$/, ""); const root = `${origin}/${account}/${site}`;
  const headers = { Accept: "text/html", "User-Agent": "Mozilla/5.0" };
  const firstResponse = await fetchWithRetry(root, { headers }, retryOptions); const first = parsePage(await firstResponse.text(), origin, account, site);
  if (first.page !== 1) throw new Error("SilkRoad first listing page did not identify as page 1");
  const pageLimit = pLimit(Math.max(1, Math.min(Math.trunc(listingConcurrency), 5)));
  const rest = await Promise.all(Array.from({ length: first.totalPages - 1 }, (_, index) => index + 2).map((page) => pageLimit(async () => {
    const response = await fetchWithRetry(`${root}?page=${page}`, { headers }, retryOptions); const parsed = parsePage(await response.text(), origin, account, site);
    if (parsed.page !== page || parsed.totalPages !== first.totalPages) throw new Error("SilkRoad pagination shifted during traversal"); return parsed;
  })));
  const seen = new Set<string>(); const listings = [first, ...rest].flatMap((page) => page.jobs);
  for (const job of listings) { if (seen.has(job.externalId)) throw new Error(`SilkRoad duplicate job ${job.externalId} across pages`); seen.add(job.externalId); }
  const normalized = listings.map((job): NormalizedJob => ({ ...job, descriptionHtml: null, descriptionText: "", employmentType: null,
    workplaceType: null, salaryText: null, postedAt: null, raw: job }));
  const selected = filterJobsToUs(normalized, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const detailLimit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  return Promise.all(selected.map((job) => job.lifecycleOnly ? job : detailLimit(async () => { const listing = job.raw as SilkRoadListing;
    const response = await fetchWithRetry(listing.url, { headers }, retryOptions); return parseDetail(await response.text(), listing, new URL(origin).origin, account, site); })));
}
