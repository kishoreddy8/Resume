import pLimit from "p-limit";
import { extractSalaryText } from "@/lib/extractSalary";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { classifyJobLocation } from "@/lib/jobLocationScope";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { workdayDomainLimiter } from "@/lib/scan/domainLimiter";
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
  title?: string;
  externalPath?: string;
  locationsText?: string;
  bulletFields?: string[];
}

/** Stable representation of the fields Workday exposes before a detail request. Stored raw list
 * payloads from the prior scan can be compared with this to skip details for unchanged postings. */
export function workdayListingFingerprint(listing: WorkdayListJob): string {
  return JSON.stringify({
    title: listing.title ?? null,
    externalPath: listing.externalPath ?? null,
    locationsText: listing.locationsText ?? null,
    bulletFields: listing.bulletFields ?? [],
  });
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
  return workdayDomainLimiter(async () => {
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
  });
}

async function fetchAllListings(
  cxsBase: string,
  options: FetchWithRetryOptions,
  maxJobs?: number,
  countsTowardLimit: (listing: WorkdayListJob) => boolean = () => true
): Promise<WorkdayListJob[]> {
  const first = await fetchListPage(cxsBase, 0, options);
  const all: WorkdayListJob[] = [];
  let eligibleCount = 0;
  const appendUntilLimit = (postings: WorkdayListJob[]) => {
    for (const listing of postings) {
      all.push(listing);
      if (countsTowardLimit(listing)) eligibleCount++;
      if (maxJobs !== undefined && eligibleCount >= maxJobs) break;
    }
  };
  appendUntilLimit(first.jobPostings);

  // Sequential paging (mirrors Workday's own frontend) — a company's board is a handful of pages
  // at most in practice, so this isn't a meaningful latency concern and is gentler on the API.
  for (
    let offset = PAGE_SIZE;
    offset < first.total && (maxJobs === undefined || eligibleCount < maxJobs);
    offset += PAGE_SIZE
  ) {
    const page = await fetchListPage(cxsBase, offset, options);
    appendUntilLimit(page.jobPostings);
  }
  return all;
}

async function fetchDetail(
  cxsBase: string,
  externalPath: string,
  options: FetchWithRetryOptions
): Promise<WorkdayJobPostingInfo> {
  return workdayDomainLimiter(async () => {
    const url = `${cxsBase}${externalPath}`;
    const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } }, options);
    const data = await parseJsonOrThrow<WorkdayDetailResponse>(res, url);
    return data.jobPostingInfo;
  });
}

/**
 * Workday's externalPath conventionally ends in "_<reqId>" (optionally with a "-N" duplicate-post
 * suffix, e.g. ".../Some-Title_JR1561-1") — the same requisition ID a successful detail fetch
 * exposes as jobReqId. Recovering it here (used only when the detail fetch fails — see the catch
 * branch in fetchWorkdayJobs below) keeps dedupe identity (src/lib/dedupe.ts's dedupeKeyForAts)
 * consistent with what it would be on a successful fetch of the SAME posting, rather than diverging
 * to the raw path and creating a duplicate row that later gets closed/archived as if the real
 * posting had disappeared once the detail fetch recovers. Falls back to the raw path — today's
 * existing behavior — when a tenant's paths don't follow this convention.
 */
export function reqIdFromExternalPath(externalPath: string): string | null {
  const match = externalPath.match(/_([A-Za-z0-9]+)(?:-\d+)?$/);
  return match ? match[1] : null;
}

export interface FetchWorkdayJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  /** Optional bounded sample used only for connector verification; production scans omit it. */
  maxJobs?: number;
  /** Testing-only: overrides the `https://{tenant}.{host}.myworkdayjobs.com` origin both the list
   *  and detail requests are built from, so tests can point a real Workday token shape at a local
   *  HTTP server instead of the real host. Production callers never pass this. */
  hostOverride?: string;
}

export async function fetchWorkdayJobs(
  token: string,
  options: FetchWorkdayJobsOptions = {}
): Promise<NormalizedJob[]> {
  const { hostOverride, maxJobs, usOnly, existingExternalIds, existingListingFingerprints, onLocationFiltered, ...retryOptions } = options;
  const identifier = decodeWorkdayToken(token);
  const cxsBase = cxsBaseUrl(identifier, hostOverride);
  const siteBase = siteBaseUrl(identifier, hostOverride);
  // A U.S.-only sample limit applies to eligible jobs, not to the first N global listings. Workday
  // exposes location in its lightweight list response, so fetch listing pages first and avoid the
  // much heavier detail request for every explicitly non-U.S. posting.
  const listings = await fetchAllListings(
    cxsBase,
    retryOptions,
    maxJobs,
    usOnly ? (listing) => classifyJobLocation(listing.locationsText) !== "NON_US" : undefined
  );

  const lifecycleSightings: NormalizedJob[] = [];
  const detailCandidates = usOnly
    ? listings.filter((listing) => {
        const externalId = listing.externalPath
          ? reqIdFromExternalPath(listing.externalPath) ?? listing.externalPath
          : listing.bulletFields?.find((field): field is string => typeof field === "string" && field.trim().length > 0);
        const listingScope = classifyJobLocation(listing.locationsText);
        const isUnchanged = Boolean(
          externalId && existingListingFingerprints?.get(externalId) === workdayListingFingerprint(listing)
        );
        if (listingScope !== "NON_US" && !isUnchanged) return true;
        if (listingScope !== "US") {
          onLocationFiltered?.(listingScope, {
            externalId: externalId ?? null, title: listing.title ?? "", location: listing.locationsText ?? null,
            department: null, url: listing.externalPath ? `${siteBase}${listing.externalPath}` : siteBase,
            descriptionHtml: null, descriptionText: null, employmentType: null, workplaceType: null,
            salaryText: null, postedAt: null, raw: { listing },
          });
        }
        if (externalId && existingExternalIds?.has(externalId)) {
          lifecycleSightings.push({
            externalId,
            title: listing.title ?? "",
            location: listing.locationsText ?? null,
            department: null,
            url: listing.externalPath ? `${siteBase}${listing.externalPath}` : siteBase,
            descriptionHtml: null,
            descriptionText: null,
            employmentType: null,
            workplaceType: null,
            salaryText: null,
            postedAt: null,
            raw: { listing, locationScope: listingScope, unchangedListing: isUnchanged },
            lifecycleOnly: true,
          });
        }
        return false;
      })
    : listings;

  const limit = pLimit(DETAIL_CONCURRENCY);
  const normalized = await Promise.all(
    detailCandidates.map((listing) =>
      limit(async (): Promise<NormalizedJob> => {
        if (!listing.externalPath || !listing.title) {
          const requisitionId = listing.bulletFields?.find(
            (field): field is string => typeof field === "string" && field.trim().length > 0
          );
          if (!requisitionId) {
            throw new Error("Workday returned a listing without title, externalPath, or requisition ID");
          }
          return {
            externalId: requisitionId,
            title: "",
            location: null,
            department: null,
            url: siteBase,
            descriptionHtml: null,
            descriptionText: null,
            employmentType: null,
            workplaceType: null,
            salaryText: null,
            postedAt: null,
            raw: { listing, listingError: "missing title or externalPath" },
            sightingOnly: true,
          };
        }
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
          // "complete descriptions" partially fails. externalId prefers the requisition ID
          // recoverable from externalPath (see reqIdFromExternalPath) over the raw path itself, so
          // this job's dedupe identity matches what a successful detail fetch would have produced —
          // see that function's doc comment for why.
          return {
            externalId: reqIdFromExternalPath(listing.externalPath) ?? listing.externalPath,
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
  return [
    ...filterJobsToUs(normalized, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs),
    ...lifecycleSightings,
  ];
}
