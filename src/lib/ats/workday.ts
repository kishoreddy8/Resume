import pLimit from "p-limit";
import { extractSalaryText } from "@/lib/extractSalary";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

// Workday's own public job-board frontend uses this same unauthenticated JSON API
// (wday/cxs = "candidate experience site"), one call per fiscal a listing page and one per
// job detail. No API key, no login — it's what the browser calls when you browse the board.
const PAGE_SIZE = 20; // Workday hard-caps list requests at 20 per page regardless of what's requested
const DETAIL_CONCURRENCY = 8;

export interface WorkdayIdentifier {
  tenant: string;
  host: string; // e.g. "wd1", "wd5", "wd503" — Workday's regional cluster, varies per tenant
  site: string;
}

/** Encodes the three-part Workday identifier into the single-string ats_board_token column. */
export function encodeWorkdayToken(id: WorkdayIdentifier): string {
  return `${id.tenant}|${id.host}|${id.site}`;
}

export function decodeWorkdayToken(token: string): WorkdayIdentifier {
  const [tenant, host, site] = token.split("|");
  if (!tenant || !host || !site) {
    throw new Error(`Invalid Workday token "${token}" — expected "tenant|host|site"`);
  }
  return { tenant, host, site };
}

function siteBaseUrl(id: WorkdayIdentifier, hostOverride?: string): string {
  const origin = hostOverride ?? `https://${id.tenant}.${id.host}.myworkdayjobs.com`;
  return `${origin}/${id.site}`;
}

function cxsBaseUrl(id: WorkdayIdentifier, hostOverride?: string): string {
  const origin = hostOverride ?? `https://${id.tenant}.${id.host}.myworkdayjobs.com`;
  return `${origin}/wday/cxs/${id.tenant}/${id.site}`;
}

interface WorkdayListJob {
  title: string;
  externalPath: string;
  locationsText?: string;
}

interface WorkdayListResponse {
  total: number;
  jobPostings: WorkdayListJob[];
}

interface WorkdayJobPostingInfo {
  title?: string;
  jobDescription?: string;
  location?: string;
  startDate?: string;
  timeType?: string;
  jobReqId?: string;
  externalUrl?: string;
}

interface WorkdayDetailResponse {
  jobPostingInfo: WorkdayJobPostingInfo;
}

async function fetchListPage(
  cxsBase: string,
  offset: number,
  options: FetchWithRetryOptions
): Promise<WorkdayListResponse> {
  const url = `${cxsBase}/jobs`;
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: "" }),
    },
    options
  );
  return parseJsonOrThrow<WorkdayListResponse>(res, url);
}

async function fetchAllListings(
  cxsBase: string,
  options: FetchWithRetryOptions
): Promise<WorkdayListJob[]> {
  const first = await fetchListPage(cxsBase, 0, options);
  const all = [...first.jobPostings];

  // Sequential paging (mirrors Workday's own frontend) — a company's board is a handful of pages
  // at most in practice, so this isn't a meaningful latency concern and is gentler on the API.
  for (let offset = PAGE_SIZE; offset < first.total; offset += PAGE_SIZE) {
    const page = await fetchListPage(cxsBase, offset, options);
    all.push(...page.jobPostings);
  }
  return all;
}

async function fetchDetail(
  cxsBase: string,
  externalPath: string,
  options: FetchWithRetryOptions
): Promise<WorkdayJobPostingInfo> {
  const url = `${cxsBase}${externalPath}`;
  const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } }, options);
  const data = await parseJsonOrThrow<WorkdayDetailResponse>(res, url);
  return data.jobPostingInfo;
}

export interface FetchWorkdayJobsOptions extends FetchWithRetryOptions {
  /** Testing-only: overrides the `https://{tenant}.{host}.myworkdayjobs.com` origin both the list
   *  and detail requests are built from, so tests can point a real Workday token shape at a local
   *  HTTP server instead of the real host. Production callers never pass this. */
  hostOverride?: string;
}

export async function fetchWorkdayJobs(
  token: string,
  options: FetchWorkdayJobsOptions = {}
): Promise<NormalizedJob[]> {
  const { hostOverride, ...retryOptions } = options;
  const identifier = decodeWorkdayToken(token);
  const cxsBase = cxsBaseUrl(identifier, hostOverride);
  const siteBase = siteBaseUrl(identifier, hostOverride);
  const listings = await fetchAllListings(cxsBase, retryOptions);

  const limit = pLimit(DETAIL_CONCURRENCY);
  return Promise.all(
    listings.map((listing) =>
      limit(async (): Promise<NormalizedJob> => {
        const fallbackUrl = `${siteBase}${listing.externalPath}`;
        try {
          const info = await fetchDetail(cxsBase, listing.externalPath, retryOptions);
          const descriptionText = stripHtml(info.jobDescription);
          return {
            externalId: info.jobReqId ?? listing.externalPath,
            title: info.title ?? listing.title,
            location: info.location ?? listing.locationsText ?? null,
            department: null, // not exposed as a clean per-job field by this API
            url: info.externalUrl ?? fallbackUrl,
            descriptionHtml: info.jobDescription ?? null,
            descriptionText,
            employmentType: info.timeType ?? null,
            workplaceType: null, // not reliably present across tenants
            salaryText: extractSalaryText(descriptionText),
            postedAt: info.startDate ?? null,
            raw: { listing, detail: info },
          };
        } catch (err) {
          // One bad detail request (timeout, transient 5xx) shouldn't drop the job entirely —
          // still return it from the list data alone so "complete jobs" holds even when
          // "complete descriptions" partially fails.
          return {
            externalId: listing.externalPath,
            title: listing.title,
            location: listing.locationsText ?? null,
            department: null,
            url: fallbackUrl,
            descriptionHtml: null,
            descriptionText: null,
            employmentType: null,
            workplaceType: null,
            salaryText: null,
            postedAt: null,
            raw: { listing, detailError: err instanceof Error ? err.message : String(err) },
          };
        }
      })
    )
  );
}
