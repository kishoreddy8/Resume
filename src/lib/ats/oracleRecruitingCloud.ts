import pLimit from "p-limit";
import { extractSalaryText } from "@/lib/extractSalary";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { degradeMissingDescription } from "@/lib/ats/jobContentFailure";
import { classifyJobLocation } from "@/lib/jobLocationScope";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

export interface OracleRecruitingCloudIdentity {
  host: string;
  site: string;
}

interface OracleLocation {
  Name?: string | null;
  CountryCode?: string | null;
  Country?: string | null;
  TownOrCity?: string | null;
  Region2?: string | null;
}

interface OracleListing {
  Id: string;
  Title: string;
  PostedDate?: string | null;
  PrimaryLocation?: string | null;
  PrimaryLocationCountry?: string | null;
  WorkplaceType?: string | null;
  WorkplaceTypeCode?: string | null;
  JobFunction?: string | null;
  JobType?: string | null;
  JobSchedule?: string | null;
  ShortDescriptionStr?: string | null;
  secondaryLocations?: OracleLocation[];
  otherWorkLocations?: OracleLocation[];
}

interface OracleSearch {
  Offset?: number;
  Limit?: number;
  TotalJobsCount?: number;
  requisitionList?: OracleListing[];
}

interface OracleCollection<T> {
  items?: T[];
  count?: number;
  hasMore?: boolean;
}

interface OracleDetail extends OracleListing {
  Category?: string | null;
  Department?: string | null;
  ExternalDescriptionStr?: string | null;
  ExternalResponsibilitiesStr?: string | null;
  ExternalQualificationsStr?: string | null;
  ExternalPostedStartDate?: string | null;
  workLocation?: OracleLocation[];
}

export interface FetchOracleRecruitingCloudJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production always uses the token's Oracle Cloud host. */
  hostOverride?: string;
  detailConcurrency?: number;
}

const ORACLE_HOST_RE = /^[a-z0-9-]+\.fa(?:\.[a-z0-9-]+)?\.oraclecloud\.com$/;
const publicRequestLimit = pLimit(5);

export function encodeOracleRecruitingCloudToken(identity: OracleRecruitingCloudIdentity): string {
  const host = identity.host.trim().toLowerCase();
  const site = identity.site.trim();
  if (!ORACLE_HOST_RE.test(host) || !/^[a-z0-9_-]+$/i.test(site)) {
    throw new Error("Invalid Oracle Recruiting Cloud identity");
  }
  return `${host}|${site}`;
}

export function decodeOracleRecruitingCloudToken(token: string): OracleRecruitingCloudIdentity {
  const [host, site, ...extra] = token.split("|");
  if (extra.length > 0 || !host || !site) throw new Error("Invalid Oracle Recruiting Cloud token");
  const identity = { host: host.toLowerCase(), site };
  encodeOracleRecruitingCloudToken(identity);
  return identity;
}

export function canonicalOracleRecruitingCloudUrl(token: string): string {
  const identity = decodeOracleRecruitingCloudToken(token);
  return `https://${identity.host}/hcmUI/CandidateExperience/en/sites/${encodeURIComponent(identity.site)}`;
}

function codeLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  if (/^(?:US|USA)$/i.test(code)) return "United States";
  // Never append arbitrary ISO alpha-2 country codes to display locations: several collide with
  // U.S. postal abbreviations (DE, IN, etc.) and could manufacture a false U.S. classification.
  // Oracle's Name/PrimaryLocation normally carries the full non-U.S. country; code-only records
  // remain UNKNOWN and are safely excluded by the shared gate.
  return null;
}

function childLocationText(location: OracleLocation): string | null {
  const name = location.Name?.trim();
  const country = codeLabel(location.CountryCode ?? location.Country);
  if (name && country && !name.toLowerCase().includes(country.toLowerCase())) return `${name}, ${country}`;
  if (name) return name;
  const parts = [location.TownOrCity, location.Region2, country]
    .filter((value): value is string => Boolean(value?.trim()));
  return parts.length > 0 ? parts.join(", ") : null;
}

function locationText(job: OracleListing): string | null {
  const values: string[] = [];
  const primary = job.PrimaryLocation?.trim();
  const primaryCountry = codeLabel(job.PrimaryLocationCountry);
  if (primary && primaryCountry && !primary.toLowerCase().includes(primaryCountry.toLowerCase())) {
    values.push(`${primary}, ${primaryCountry}`);
  } else if (primary) {
    values.push(primary);
  } else if (primaryCountry) {
    values.push(primaryCountry);
  }
  for (const location of [...(job.secondaryLocations ?? []), ...(job.otherWorkLocations ?? [])]) {
    const text = childLocationText(location);
    if (text && !values.includes(text)) values.push(text);
  }
  return values.length > 0 ? values.join("; ") : null;
}

function listingJob(identity: OracleRecruitingCloudIdentity, listing: OracleListing): NormalizedJob {
  const location = locationText(listing);
  return {
    externalId: String(listing.Id),
    title: listing.Title,
    location,
    department: listing.JobFunction?.trim() || null,
    url: `${canonicalOracleRecruitingCloudUrl(encodeOracleRecruitingCloudToken(identity))}/job/${encodeURIComponent(String(listing.Id))}`,
    descriptionHtml: listing.ShortDescriptionStr?.trim() || null,
    descriptionText: stripHtml(listing.ShortDescriptionStr),
    employmentType: listing.JobSchedule ?? listing.JobType ?? null,
    workplaceType: listing.WorkplaceType?.trim() || (/\bremote\b/i.test(location ?? "") ? "Remote" : null),
    salaryText: null,
    postedAt: listing.PostedDate ?? null,
    raw: listing,
  };
}

function fullDescription(detail: OracleDetail): string {
  const sections = [
    detail.ExternalDescriptionStr,
    detail.ExternalResponsibilitiesStr,
    detail.ExternalQualificationsStr,
  ].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return [...new Set(sections)].join("\n");
}

function shouldStopBounded(listings: OracleListing[], maxJobs: number | undefined, usOnly: boolean | undefined): boolean {
  if (!maxJobs) return false;
  if (!usOnly) return listings.length >= maxJobs;
  return listings.reduce((count, listing) => count + (classifyJobLocation(locationText(listing)) === "US" ? 1 : 0), 0) >= maxJobs;
}

/** Oracle Candidate Experience exposes an anonymous `findReqs` listing with explicit offset,
 * limit, and TotalJobsCount, plus an anonymous `ById` detail finder. Production scans exhaust the
 * listing; bounded validation stops only after enough eligible samples are found. */
export async function fetchOracleRecruitingCloudJobs(
  token: string,
  options: FetchOracleRecruitingCloudJobsOptions = {}
): Promise<NormalizedJob[]> {
  const identity = decodeOracleRecruitingCloudToken(token);
  const {
    hostOverride,
    maxJobs,
    detailConcurrency = 5,
    usOnly,
    existingExternalIds,
    onLocationFiltered,
    ...retryOptions
  } = options;
  const origin = hostOverride ?? `https://${identity.host}`;
  const listEndpoint = `${origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`;
  const pageSize = 25;
  const listings: OracleListing[] = [];
  const seen = new Set<string>();
  let total = Number.POSITIVE_INFINITY;

  for (let offset = 0; offset < total; offset += pageSize) {
    const params = new URLSearchParams({
      onlyData: "true",
      expand: "requisitionList.workLocation,requisitionList.otherWorkLocations,requisitionList.secondaryLocations",
      finder: `findReqs;siteNumber=${identity.site},sortBy=POSTING_DATES_DESC,limit=${pageSize},offset=${offset}`,
    });
    const listUrl = `${listEndpoint}?${params}`;
    const response = await fetchWithRetry(listUrl, { headers: { Accept: "application/json" } }, retryOptions);
    const body = await parseJsonOrThrow<OracleCollection<OracleSearch>>(response, listUrl);
    const search = body.items?.[0];
    if (!search || !Array.isArray(search.requisitionList) || typeof search.TotalJobsCount !== "number") {
      throw new Error("Oracle Recruiting Cloud response is missing requisitionList or TotalJobsCount");
    }
    total = search.TotalJobsCount;
    for (const listing of search.requisitionList) {
      const id = String(listing.Id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      listings.push(listing);
    }
    if (shouldStopBounded(listings, maxJobs, usOnly)) break;
    if (search.requisitionList.length === 0) {
      if (!maxJobs && listings.length < total) {
        throw new Error(`Oracle Recruiting Cloud listing is incomplete: expected ${total}, received ${listings.length}`);
      }
      break;
    }
  }

  if (!maxJobs && listings.length !== total) {
    throw new Error(`Oracle Recruiting Cloud listing is incomplete: expected ${total}, received ${listings.length}`);
  }
  const selected = filterJobsToUs(
    listings.map((listing) => listingJob(identity, listing)),
    { usOnly, existingExternalIds, onLocationFiltered },
    maxJobs
  );
  const perCallLimit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  return Promise.all(selected.map((listing) => {
    if (listing.lifecycleOnly) return listing;
    return perCallLimit(() => publicRequestLimit(async (): Promise<NormalizedJob> => {
      const params = new URLSearchParams({
        onlyData: "true",
        expand: "all",
        finder: `ById;Id=${listing.externalId},siteNumber=${identity.site}`,
        limit: "1",
      });
      const detailUrl = `${origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?${params}`;
      const response = await fetchWithRetry(detailUrl, { headers: { Accept: "application/json" } }, retryOptions);
      const body = await parseJsonOrThrow<OracleCollection<OracleDetail>>(response, detailUrl);
      const detail = body.items?.[0];
      const descriptionHtml = detail ? fullDescription(detail) : "";
      // A single job with no full description is a per-job content gap, not a connector failure —
      // degrade gracefully (see jobContentFailure.ts) instead of aborting the whole company scan.
      if (!detail || !descriptionHtml) return degradeMissingDescription(listing);
      const descriptionText = stripHtml(descriptionHtml);
      return {
        ...listing,
        title: detail.Title?.trim() || listing.title,
        location: locationText(detail) ?? listing.location,
        department: detail.Department?.trim() || detail.Category?.trim() || detail.JobFunction?.trim() || listing.department,
        descriptionHtml,
        descriptionText,
        employmentType: detail.JobSchedule ?? detail.JobType ?? listing.employmentType,
        workplaceType: detail.WorkplaceType?.trim() || listing.workplaceType,
        salaryText: extractSalaryText(descriptionText),
        postedAt: detail.ExternalPostedStartDate ?? detail.PostedDate ?? listing.postedAt,
        raw: { listing: listing.raw, detail },
      };
    }));
  }));
}
