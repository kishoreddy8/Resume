import pLimit from "p-limit";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { extractSalaryText } from "@/lib/extractSalary";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { decodeHtmlEntities, stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface TaleoConfig { host: string; section: string }
interface TaleoBootstrap extends TaleoConfig { portal: string }
interface TaleoListing { externalId: string; contestNo: string; title: string; location: string; url: string; raw: Record<string, unknown> }
interface TaleoPage { page: number; pageSize: number; total: number; jobs: TaleoListing[] }
export interface FetchTaleoJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  originOverride?: string;
  listingConcurrency?: number;
  detailConcurrency?: number;
}

export function decodeTaleoToken(value: string): TaleoConfig {
  const [rawHost, rawSection, ...extra] = value.trim().split("|");
  const host = rawHost?.toLowerCase();
  const section = rawSection?.toLowerCase();
  if (extra.length || !/^[a-z0-9-]+\.taleo\.net$/.test(host ?? "") || !/^[a-z0-9_-]+$/.test(section ?? "")) {
    throw new Error("Invalid Taleo host/career-section token");
  }
  return { host, section };
}

export function normalizeTaleoToken(value: string): string {
  const { host, section } = decodeTaleoToken(value);
  return `${host}|${section}`;
}

export function canonicalTaleoUrl(value: string): string {
  const { host, section } = decodeTaleoToken(normalizeTaleoToken(value));
  return `https://${host}/careersection/${section}/jobsearch.ftl?lang=en`;
}

function parseBootstrap(html: string, config: TaleoConfig, expectedOrigin: string): TaleoBootstrap {
  const portal = html.match(/\bportalNo\s*:\s*['"](\d+)['"]/i)?.[1];
  const urlCode = html.match(/\burlCode\s*:\s*['"]([^'"]+)['"]/i)?.[1]?.toLowerCase();
  const urlOrigin = html.match(/\burlOrigin\s*:\s*['"](https?:\/\/[^'"]+)['"]/i)?.[1];
  let identityHost = "";
  try { identityHost = new URL(urlOrigin ?? "").hostname.toLowerCase(); } catch { /* checked below */ }
  let expectedHost = "";
  try { expectedHost = new URL(expectedOrigin).hostname.toLowerCase(); } catch { /* checked below */ }
  if (!portal || !/^\d+$/.test(portal) || urlCode !== config.section || !expectedHost || identityHost !== expectedHost
    || !/data-main=["'][^"']*\/js\/facetedsearch\/FacetedSearchPage\.js["']/i.test(html)) {
    throw new Error("Taleo board bootstrap has no exact tenant/section/search identity");
  }
  return { ...config, portal };
}

function text(value: unknown): string {
  return typeof value === "string" ? stripHtml(decodeHtmlEntities(value)).trim() : "";
}

function parseLocations(value: unknown): string {
  if (typeof value !== "string") return "Unknown";
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      const locations = parsed.map(text).filter(Boolean);
      if (locations.length) return locations.join("; ");
    }
  } catch { /* fall through to the published text */ }
  return text(value) || "Unknown";
}

function parsePage(payload: unknown, expectedPage: number, bootstrap: TaleoBootstrap, origin: string): TaleoPage {
  if (!payload || typeof payload !== "object") throw new Error("Taleo listing response is not an object");
  const object = payload as Record<string, unknown>;
  const paging = object.pagingData;
  if (!paging || typeof paging !== "object" || !Array.isArray(object.requisitionList)) throw new Error("Taleo listing has no paging/requisition data");
  const pageData = paging as Record<string, unknown>;
  const page = Number(pageData.currentPageNo); const pageSize = Number(pageData.pageSize); const total = Number(pageData.totalCount);
  if (!Number.isInteger(page) || page !== expectedPage || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
    || !Number.isInteger(total) || total < 0 || total > 100_000) throw new Error("Taleo listing returned invalid pagination identity");
  const jobs = object.requisitionList.map((entry): TaleoListing => {
    if (!entry || typeof entry !== "object") throw new Error("Taleo listing contains an invalid row");
    const raw = entry as Record<string, unknown>;
    const externalId = text(raw.jobId); const contestNo = text(raw.contestNo);
    const columns = Array.isArray(raw.column) ? raw.column : [];
    const linkedColumn = Number(raw.linkedColumn);
    const locationIndexes = Array.isArray(raw.locationsColumns) ? raw.locationsColumns.map(Number) : [];
    const title = Number.isInteger(linkedColumn) ? text(columns[linkedColumn]) : "";
    const location = locationIndexes.map((index) => parseLocations(columns[index])).filter((item) => item !== "Unknown").join("; ") || "Unknown";
    if (!/^\d+$/.test(externalId) || !/^\d+$/.test(contestNo) || !title || !Number.isInteger(linkedColumn)) {
      throw new Error("Taleo listing is missing requisition identity or title");
    }
    return { externalId, contestNo, title, location,
      url: `${origin}/careersection/${bootstrap.section}/jobdetail.ftl?job=${contestNo}&lang=en`, raw };
  });
  return { page, pageSize, total, jobs };
}

function parseJavascriptStringArray(source: string): string[] {
  const values: string[] = [];
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /[\s,]/.test(source[index])) index++;
    if (index >= source.length) break;
    const quote = source[index];
    if (quote !== "'" && quote !== '"') throw new Error("Taleo detail contains a non-string list value");
    index++;
    let value = "";
    let closed = false;
    while (index < source.length) {
      const char = source[index++];
      if (char === quote) { closed = true; break; }
      if (char !== "\\") { value += char; continue; }
      if (index >= source.length) break;
      const escaped = source[index++];
      const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"' };
      value += simple[escaped] ?? escaped;
    }
    if (!closed) throw new Error("Taleo detail contains an unterminated list value");
    values.push(value);
  }
  return values;
}

function decodeTaleoHtml(value: string): string {
  const encoded = value.replace(/^!\*!/, "");
  try { return decodeURIComponent(encoded); } catch { throw new Error("Taleo detail description encoding is invalid"); }
}

function parseDetail(html: string, listing: TaleoListing): NormalizedJob {
  const hiddenId = html.match(/<input\b[^>]*name=["']requisitionno["'][^>]*value=["'](\d+)["']/i)?.[1]
    ?? html.match(/<input\b[^>]*value=["'](\d+)["'][^>]*name=["']requisitionno["']/i)?.[1];
  const marker = /api\.fillList\(\s*['"]requisitionDescriptionInterface['"]\s*,\s*['"]descRequisition['"]\s*,\s*\[([\s\S]*?)\]\s*\);/i.exec(html);
  if (!marker || hiddenId !== listing.externalId || !/id=["']requisitionDescriptionInterface\.(?:UP|BOTTOM)_APPLY_ON_REQ["']/i.test(html)) {
    throw new Error(`Taleo job ${listing.externalId} has no exact detail/apply identity`);
  }
  const values = parseJavascriptStringArray(marker[1]);
  const jobId = values[0] ?? ""; const title = values[9] ?? ""; const contestNo = values[10] ?? "";
  if (jobId !== listing.externalId || title !== listing.title || contestNo !== listing.contestNo) {
    throw new Error(`Taleo job ${listing.externalId} has mismatched job/title/contest identity`);
  }
  const sections = [values[11], values[13]].filter((value): value is string => Boolean(value)).map(decodeTaleoHtml);
  const descriptionHtml = sections.join("\n");
  const descriptionText = stripHtml(decodeHtmlEntities(descriptionHtml));
  if (!descriptionText) throw new Error(`Taleo job ${listing.externalId} has an empty full description`);
  return { externalId: listing.externalId, title, location: listing.location, department: null, url: listing.url,
    descriptionHtml, descriptionText, employmentType: null, workplaceType: /\bremote\b/i.test(listing.location) ? "Remote" : null,
    salaryText: extractSalaryText(descriptionText), postedAt: null, raw: { listing: listing.raw, contestNo: listing.contestNo } };
}

async function fetchPage(bootstrap: TaleoBootstrap, origin: string, page: number, retryOptions: FetchWithRetryOptions): Promise<TaleoPage> {
  const url = `${origin}/careersection/rest/jobboard/searchjobs?lang=en&portal=${bootstrap.portal}`;
  const response = await fetchWithRetry(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", tz: "GMT-05:00", tzname: "America/Chicago" },
    body: JSON.stringify({ multilineEnabled: false, pageNo: page }) }, retryOptions);
  return parsePage(await response.json(), page, bootstrap, origin);
}

/** Taleo's public faceted-search endpoint exposes exact page size/number/total and stable internal
 * job IDs. Every page is exhausted before U.S. filtering and contest-scoped full detail requests. */
export async function fetchTaleoJobs(tokenValue: string, options: FetchTaleoJobsOptions = {}): Promise<NormalizedJob[]> {
  const config = decodeTaleoToken(normalizeTaleoToken(tokenValue));
  const { maxJobs, originOverride, listingConcurrency = 3, detailConcurrency = 5,
    usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = (originOverride ?? `https://${config.host}`).replace(/\/$/, "");
  const bootstrapResponse = await fetchWithRetry(`${origin}/careersection/${config.section}/jobsearch.ftl?lang=en`,
    { headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" } }, retryOptions);
  const bootstrap = parseBootstrap(await bootstrapResponse.text(), config, origin);
  const first = await fetchPage(bootstrap, origin, 1, retryOptions);
  if (first.jobs.length > first.pageSize || (first.total > 0 && first.jobs.length === 0)) {
    throw new Error("Taleo first listing page is invalid");
  }
  const pageCount = Math.ceil(first.total / first.pageSize);
  const pageLimit = pLimit(Math.max(1, Math.min(Math.trunc(listingConcurrency), 5)));
  const rest = await Promise.all(Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => index + 2).map((page) => pageLimit(async () => {
    const parsed = await fetchPage(bootstrap, origin, page, retryOptions);
    if (parsed.total !== first.total || parsed.pageSize !== first.pageSize || parsed.jobs.length > first.pageSize) {
      throw new Error("Taleo pagination shifted or returned an invalid page");
    }
    return parsed;
  })));
  const listings = [first, ...rest].flatMap((page) => page.jobs);
  const seen = new Set<string>();
  for (const job of listings) { if (seen.has(job.externalId)) throw new Error(`Taleo duplicate job ${job.externalId}`); seen.add(job.externalId); }
  // Taleo's totalCount can include requisitions its own public endpoint omits, and some
  // intermediate pages can be short. We still request every advertised page and fail
  // closed on duplicate IDs, changing pagination metadata, or an impossible row count.
  if (listings.length > first.total || (first.total > 0 && listings.length === 0)) {
    throw new Error("Taleo traversal returned an invalid number of requisitions");
  }
  const normalized = listings.map((job): NormalizedJob => ({ externalId: job.externalId, title: job.title, location: job.location,
    department: null, url: job.url, descriptionHtml: null, descriptionText: "", employmentType: null, workplaceType: null,
    salaryText: null, postedAt: null, raw: job }));
  const selected = filterJobsToUs(normalized, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const detailLimit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  return Promise.all(selected.map((job) => job.lifecycleOnly ? job : detailLimit(async () => {
    const listing = job.raw as TaleoListing;
    const response = await fetchWithRetry(listing.url, { headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" } }, retryOptions);
    return parseDetail(await response.text(), listing);
  })));
}
