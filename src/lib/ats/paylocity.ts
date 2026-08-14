import pLimit from "p-limit";
import { extractSalaryText } from "@/lib/extractSalary";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

export interface PaylocityIdentity {
  companyId: string;
  slug: string;
}

interface PaylocityJob {
  JobId: number;
  JobTitle: string;
  LocationName?: string;
  PublishedDate?: string;
  Description?: string;
  HiringDepartment?: string | null;
  IsRemote?: boolean;
  IndeedRemoteType?: number;
  JobLocation?: {
    Name?: string;
    City?: string;
    State?: string;
    Country?: string;
  } | null;
}

interface PaylocityPageData {
  Jobs?: PaylocityJob[];
  ModuleId?: string;
  ModuleTitle?: string;
}

interface PaylocityJsonLd {
  "@type"?: string | string[];
  title?: string;
  datePosted?: string;
  description?: string;
  jobLocation?: unknown;
}

export interface FetchPaylocityJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production always uses recruiting.paylocity.com. */
  hostOverride?: string;
  detailConcurrency?: number;
}

// Paylocity's public recruiting host applies an origin-wide rate limit. Scans can process several
// companies at once, so a module-level limiter prevents each adapter invocation from independently
// bursting board and detail requests. Local fixture servers bypass this production courtesy delay.
const publicRequestLimit = pLimit(1);
let nextPublicRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPaylocityPage(
  url: string,
  retryOptions: FetchWithRetryOptions,
  isPublicHost: boolean
): Promise<Response> {
  const request = async () => {
    if (isPublicHost) {
      const waitMs = Math.max(0, nextPublicRequestAt - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      nextPublicRequestAt = Date.now() + 350;
    }
    return fetchWithRetry(url, { headers: { Accept: "text/html" } }, {
      maxAttempts: retryOptions.maxAttempts ?? 4,
      baseDelayMs: retryOptions.baseDelayMs ?? 1_000,
      maxDelayMs: retryOptions.maxDelayMs ?? 15_000,
      timeoutMs: retryOptions.timeoutMs,
      onRetry: retryOptions.onRetry,
    });
  };
  return isPublicHost ? publicRequestLimit(request) : request();
}

export function encodePaylocityToken(identity: PaylocityIdentity): string {
  if (!/^[a-f0-9-]{36}$/i.test(identity.companyId) || !/^[a-z0-9_-]+$/i.test(identity.slug)) {
    throw new Error("Invalid Paylocity identity");
  }
  return `${identity.companyId.toLowerCase()}|${identity.slug}`;
}

export function decodePaylocityToken(token: string): PaylocityIdentity {
  const [companyId, slug, ...extra] = token.split("|");
  if (extra.length > 0 || !companyId || !slug || !/^[a-f0-9-]{36}$/i.test(companyId) || !/^[a-z0-9_-]+$/i.test(slug)) {
    throw new Error("Invalid Paylocity token; expected company UUID|slug");
  }
  return { companyId: companyId.toLowerCase(), slug };
}

export function canonicalPaylocityUrl(token: string): string {
  const { companyId, slug } = decodePaylocityToken(token);
  return `https://recruiting.paylocity.com/recruiting/jobs/All/${companyId}/${slug}`;
}

/** Extracts a JSON object assigned to a named window variable without relying on a greedy regex.
 * JSON strings may contain braces, quotes, and escaped characters, so brace depth is tracked only
 * outside strings. */
export function extractAssignedJson<T>(html: string, assignment: string): T {
  const marker = html.indexOf(assignment);
  if (marker < 0) throw new Error(`Paylocity page is missing ${assignment}`);
  const start = html.indexOf("{", marker + assignment.length);
  if (start < 0) throw new Error(`Paylocity ${assignment} has no JSON object`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start, index + 1)) as T;
    }
  }
  throw new Error(`Paylocity ${assignment} JSON object is incomplete`);
}

function extractJobPosting(html: string): PaylocityJsonLd | null {
  const scriptRe = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as PaylocityJsonLd;
      const type = parsed["@type"];
      if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return parsed;
    } catch {
      // Ignore unrelated malformed structured-data blocks.
    }
  }
  return null;
}

export interface PaylocityDetailParsed {
  title?: string;
  descriptionHtml: string;
  datePosted?: string;
  source: "JSON-LD" | "HTML";
}

/**
 * Extracts structured job description from Paylocity detail page HTML.
 * Paylocity renders detail descriptions via:
 * 1. Schema.org JobPosting JSON-LD `<script type="application/ld+json">`, OR
 * 2. Dedicated structured HTML section headers:
 *    `<div class="job-listing-header">Description</div><div data-bind="...">...</div>`
 *    and optional Requirements/Summary/Qualifications sections.
 * Generic navigation, headers, and footers are never extracted.
 */
export function extractPaylocityDetail(html: string): PaylocityDetailParsed | null {
  // 1. Primary: JobPosting JSON-LD
  const jsonLd = extractJobPosting(html);
  if (jsonLd?.description && jsonLd.description.trim().length > 20) {
    return {
      title: typeof jsonLd.title === "string" ? jsonLd.title.trim() : undefined,
      descriptionHtml: jsonLd.description.trim(),
      datePosted: typeof jsonLd.datePosted === "string" ? jsonLd.datePosted.trim() : undefined,
      source: "JSON-LD",
    };
  }

  // 2. Structured HTML section headers on Paylocity detail pages
  const sections: string[] = [];
  const headerRe = /<div[^>]*class=["'][^"']*job-listing-header[^"']*["'][^>]*>\s*(Description|Requirements|Summary|Qualifications)\s*<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/gi;
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(html)) !== null) {
    const content = match[2].trim();
    if (content.length > 0) {
      sections.push(content);
    }
  }

  if (sections.length > 0) {
    const combined = sections.join("\n\n");
    if (combined.length > 20) {
      return {
        descriptionHtml: combined,
        source: "HTML",
      };
    }
  }

  return null;
}

function locationText(job: PaylocityJob): string | null {
  const location = job.JobLocation;
  const country = location?.Country?.toUpperCase();
  if (job.IsRemote && /^(?:US|USA|UNITED STATES)$/.test(country ?? "")) return "Remote - United States";
  const parts = [location?.City, location?.State, location?.Country].filter((value): value is string => Boolean(value?.trim()));
  if (parts.length > 0) return parts.join(", ");
  return job.LocationName?.trim() || location?.Name?.trim() || (job.IsRemote ? "Remote" : null);
}

function listingJob(job: PaylocityJob): NormalizedJob {
  const descriptionHtml = job.Description?.trim() || null;
  return {
    externalId: String(job.JobId),
    title: job.JobTitle,
    location: locationText(job),
    department: job.HiringDepartment?.trim() || null,
    url: `https://recruiting.paylocity.com/Recruiting/Jobs/Details/${job.JobId}`,
    descriptionHtml,
    descriptionText: stripHtml(descriptionHtml),
    employmentType: null,
    workplaceType: job.IsRemote ? "Remote" : null,
    salaryText: null,
    postedAt: job.PublishedDate ?? null,
    raw: job,
  };
}

/** Paylocity publishes the complete current listing in window.pageData on the public board. The
 * adapter filters that listing before requesting details, then reads the full JobPosting JSON-LD
 * or structured HTML container from each selected detail page. */
export async function fetchPaylocityJobs(
  token: string,
  options: FetchPaylocityJobsOptions = {}
): Promise<NormalizedJob[]> {
  const {
    hostOverride,
    maxJobs,
    detailConcurrency = 4,
    usOnly,
    existingExternalIds,
    onLocationFiltered,
    ...retryOptions
  } = options;
  const identity = decodePaylocityToken(token);
  const origin = hostOverride ?? "https://recruiting.paylocity.com";
  const isPublicHost = hostOverride === undefined;
  const boardPath = `/recruiting/jobs/All/${encodeURIComponent(identity.companyId)}/${encodeURIComponent(identity.slug)}`;
  const boardUrl = `${origin}${boardPath}`;
  const response = await fetchPaylocityPage(boardUrl, retryOptions, isPublicHost);
  if (!response.ok) throw new Error(`Paylocity board failed with status ${response.status}`);
  const html = await response.text();
  const pageData = extractAssignedJson<PaylocityPageData>(html, "window.pageData");
  if (!Array.isArray(pageData.Jobs)) throw new Error("Paylocity pageData has no Jobs array");

  const seenIds = new Set<string>();
  for (const job of pageData.Jobs) {
    const idStr = String(job.JobId);
    if (seenIds.has(idStr)) {
      throw new Error(`Paylocity board returned duplicate job ID ${idStr}`);
    }
    seenIds.add(idStr);
  }

  const listings = pageData.Jobs.map(listingJob);
  const selected = filterJobsToUs(listings, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const limit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 8)));
  return Promise.all(selected.map((listing) => {
    if (listing.lifecycleOnly) return listing;
    return limit(async (): Promise<NormalizedJob> => {
      const detailUrl = `${origin}/Recruiting/Jobs/Details/${encodeURIComponent(listing.externalId!)}`;
      const detailResponse = await fetchPaylocityPage(detailUrl, retryOptions, isPublicHost);
      if (!detailResponse.ok) throw new Error(`Paylocity detail failed with status ${detailResponse.status}`);
      const detailHtml = await detailResponse.text();
      const detail = extractPaylocityDetail(detailHtml);
      if (!detail?.descriptionHtml?.trim()) throw new Error(`Paylocity job ${listing.externalId} has no full JobPosting description`);
      const descriptionHtml = detail.descriptionHtml;
      const descriptionText = stripHtml(descriptionHtml);
      return {
        ...listing,
        title: detail.title || listing.title,
        url: `https://recruiting.paylocity.com/Recruiting/Jobs/Details/${listing.externalId}`,
        descriptionHtml,
        descriptionText,
        salaryText: extractSalaryText(descriptionText),
        postedAt: detail.datePosted ?? listing.postedAt,
        raw: { identity, pageData: { ModuleId: pageData.ModuleId, ModuleTitle: pageData.ModuleTitle }, listing: listing.raw, detail },
      };
    });
  }));
}
