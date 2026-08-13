import pLimit from "p-limit";
import { extractSalaryText } from "@/lib/extractSalary";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

export interface UkgProIdentity {
  host: "recruiting.ultipro.com" | "recruiting2.ultipro.com";
  tenant: string;
  boardId: string;
}

interface UkgAddress {
  City?: string;
  State?: { Code?: string; Name?: string } | null;
  Country?: { Code?: string; Name?: string } | null;
}

interface UkgLocation {
  LocalizedName?: string | null;
  LocalizedDescription?: string | null;
  Address?: UkgAddress | null;
}

interface UkgOpportunity {
  Id: string;
  Title: string;
  RequisitionNumber?: string;
  FullTime?: boolean;
  JobCategoryName?: string | null;
  Locations?: UkgLocation[];
  PostedDate?: string;
  BriefDescription?: string | null;
  JobLocationType?: number | null;
}

interface UkgSearchResponse {
  opportunities?: UkgOpportunity[];
  totalCount?: number;
}

interface UkgOpportunityDetail extends UkgOpportunity {
  Description?: string | null;
  UpdatedDate?: string;
  CompensationAnnualMinimum?: number | null;
  CompensationAnnualMaximum?: number | null;
  CompensationHourlyMinimum?: number | null;
  CompensationHourlyMaximum?: number | null;
  CompensationCurrency?: string | null;
  Salaried?: boolean | null;
}

export interface FetchUkgProJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production always uses the token's UKG host. */
  hostOverride?: string;
  detailConcurrency?: number;
}

const publicRequestLimit = pLimit(4);
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function encodeUkgProToken(identity: UkgProIdentity): string {
  const host = identity.host.toLowerCase();
  const tenant = identity.tenant.trim();
  const boardId = identity.boardId.toLowerCase();
  if (!/^recruiting2?\.ultipro\.com$/.test(host) || !/^[a-z0-9]+$/i.test(tenant) || !UUID_RE.test(boardId)) {
    throw new Error("Invalid UKG Pro Recruiting identity");
  }
  return `${host}|${tenant}|${boardId}`;
}

export function decodeUkgProToken(token: string): UkgProIdentity {
  const [host, tenant, boardId, ...extra] = token.split("|");
  if (extra.length > 0 || !host || !tenant || !boardId) throw new Error("Invalid UKG Pro Recruiting token");
  const identity = {
    host: host.toLowerCase() as UkgProIdentity["host"],
    tenant,
    boardId: boardId.toLowerCase(),
  } satisfies UkgProIdentity;
  encodeUkgProToken(identity);
  return identity;
}

export function canonicalUkgProUrl(token: string): string {
  const identity = decodeUkgProToken(token);
  // Re-encode to validate values decoded from an arbitrary persisted token.
  encodeUkgProToken(identity);
  return `https://${identity.host}/${identity.tenant}/JobBoard/${identity.boardId}/`;
}

export function extractUkgAssignedObject<T>(html: string, marker: string): T {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error(`UKG page is missing ${marker}`);
  const start = html.indexOf("{", markerIndex + marker.length);
  if (start < 0) throw new Error(`UKG ${marker} has no JSON object`);
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
    else if (char === "}" && --depth === 0) return JSON.parse(html.slice(start, index + 1)) as T;
  }
  throw new Error(`UKG ${marker} JSON object is incomplete`);
}

function cookieHeader(response: Response): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : []);
  const cookies = values.map((value) => value.split(";", 1)[0]).filter(Boolean);
  return cookies.length > 0 ? cookies.join("; ") : null;
}

function locationText(opportunity: UkgOpportunity): string | null {
  const locations = (opportunity.Locations ?? []).map((location) => {
    const address = location.Address;
    const parts = [address?.City, address?.State?.Code ?? address?.State?.Name, address?.Country?.Code ?? address?.Country?.Name]
      .filter((value): value is string => Boolean(value?.trim()));
    return parts.length > 0
      ? parts.join(", ")
      : location.LocalizedName?.trim() || location.LocalizedDescription?.trim() || "";
  }).filter(Boolean);
  return locations.length > 0 ? locations.join("; ") : null;
}

function listingJob(opportunity: UkgOpportunity, identity: UkgProIdentity): NormalizedJob {
  const location = locationText(opportunity);
  const url = `https://${identity.host}/${identity.tenant}/JobBoard/${identity.boardId}/OpportunityDetail?opportunityId=${opportunity.Id}`;
  return {
    externalId: opportunity.Id,
    title: opportunity.Title,
    location,
    department: opportunity.JobCategoryName?.trim() || null,
    url,
    descriptionHtml: opportunity.BriefDescription?.trim() || null,
    descriptionText: stripHtml(opportunity.BriefDescription),
    employmentType: opportunity.FullTime === true ? "Full-Time" : opportunity.FullTime === false ? "Part-Time" : null,
    workplaceType: /\bremote\b/i.test(location ?? "") ? "Remote" : null,
    salaryText: null,
    postedAt: opportunity.PostedDate ?? null,
    raw: opportunity,
  };
}

function detailSalary(detail: UkgOpportunityDetail, descriptionText: string): string | null {
  const extracted = extractSalaryText(descriptionText);
  if (extracted) return extracted;
  const min = detail.Salaried === false ? detail.CompensationHourlyMinimum : detail.CompensationAnnualMinimum;
  const max = detail.Salaried === false ? detail.CompensationHourlyMaximum : detail.CompensationAnnualMaximum;
  if (min == null && max == null) return null;
  const amount = min != null && max != null && min !== max
    ? `${min.toLocaleString("en-US")} - ${max.toLocaleString("en-US")}`
    : (min ?? max)!.toLocaleString("en-US");
  return `${detail.CompensationCurrency ?? "USD"} ${amount}${detail.Salaried === false ? " hourly" : " annually"}`;
}

function searchBody(skip: number, top: number): Record<string, unknown> {
  return {
    opportunitySearch: {
      Top: top,
      Skip: skip,
      QueryString: "",
      Filters: [4, 5, 6, 37].map((fieldName) => ({
        t: "TermsSearchFilterDto", fieldName, extra: null, values: [],
      })),
    },
    matchCriteria: {
      PreferredJobs: [], Educations: [], LicenseAndCertifications: [], Skills: [],
      hasNoLicenses: false, SkippedSkills: [],
    },
  };
}

/** UKG Pro Recruiting public boards require a public session established by the board GET. The
 * adapter preserves that cookie, exhausts totalCount/Skip pagination, filters explicit locations,
 * and fetches the full CandidateOpportunityDetail model only for selected jobs. */
export async function fetchUkgProJobs(
  token: string,
  options: FetchUkgProJobsOptions = {}
): Promise<NormalizedJob[]> {
  const identity = decodeUkgProToken(token);
  encodeUkgProToken(identity);
  const {
    hostOverride,
    maxJobs,
    detailConcurrency = 4,
    usOnly,
    existingExternalIds,
    onLocationFiltered,
    ...retryOptions
  } = options;
  const origin = hostOverride ?? `https://${identity.host}`;
  const boardPath = `/${encodeURIComponent(identity.tenant)}/JobBoard/${encodeURIComponent(identity.boardId)}`;
  const boardUrl = `${origin}${boardPath}/`;
  const boardResponse = await fetchWithRetry(boardUrl, { headers: { Accept: "text/html" } }, retryOptions);
  const cookie = cookieHeader(boardResponse);
  await boardResponse.arrayBuffer();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Referer: boardUrl,
  };
  if (cookie) headers.Cookie = cookie;

  const opportunities: UkgOpportunity[] = [];
  const seen = new Set<string>();
  const pageSize = 50;
  let totalCount = Number.POSITIVE_INFINITY;
  for (let skip = 0; skip < totalCount; skip += pageSize) {
    const listUrl = `${origin}${boardPath}/JobBoardView/LoadSearchResults`;
    const response = await fetchWithRetry(listUrl, {
      method: "POST", headers, body: JSON.stringify(searchBody(skip, pageSize)),
    }, retryOptions);
    const page = await parseJsonOrThrow<UkgSearchResponse>(response, listUrl);
    if (!Array.isArray(page.opportunities) || typeof page.totalCount !== "number") {
      throw new Error("UKG search response is missing opportunities or totalCount");
    }
    totalCount = page.totalCount;
    for (const opportunity of page.opportunities) {
      if (!opportunity.Id || !UUID_RE.test(opportunity.Id) || seen.has(opportunity.Id)) continue;
      seen.add(opportunity.Id);
      opportunities.push(opportunity);
    }
    if (page.opportunities.length === 0) break;
  }

  const listings = opportunities.map((opportunity) => listingJob(opportunity, identity));
  const selected = filterJobsToUs(listings, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const perCallLimit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 8)));
  return Promise.all(selected.map((listing) => {
    if (listing.lifecycleOnly) return listing;
    return perCallLimit(() => publicRequestLimit(async (): Promise<NormalizedJob> => {
      const detailUrl = `${origin}${boardPath}/OpportunityDetail?opportunityId=${encodeURIComponent(listing.externalId!)}`;
      const response = await fetchWithRetry(detailUrl, { headers: { Accept: "text/html", ...(cookie ? { Cookie: cookie } : {}) } }, retryOptions);
      const detail = extractUkgAssignedObject<UkgOpportunityDetail>(
        await response.text(), "var opportunity = new US.Opportunity.CandidateOpportunityDetail("
      );
      if (!detail.Description?.trim()) throw new Error(`UKG opportunity ${listing.externalId} has no full description`);
      const descriptionHtml = detail.Description;
      const descriptionText = stripHtml(descriptionHtml);
      return {
        ...listing,
        title: detail.Title?.trim() || listing.title,
        location: locationText(detail) ?? listing.location,
        department: detail.JobCategoryName?.trim() || listing.department,
        descriptionHtml,
        descriptionText,
        employmentType: detail.FullTime === true ? "Full-Time" : detail.FullTime === false ? "Part-Time" : listing.employmentType,
        salaryText: detailSalary(detail, descriptionText),
        postedAt: detail.PostedDate ?? listing.postedAt,
        raw: { listing: listing.raw, detail },
      };
    }));
  }));
}
