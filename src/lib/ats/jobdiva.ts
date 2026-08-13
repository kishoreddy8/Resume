import pLimit from "p-limit";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { extractSalaryText } from "@/lib/extractSalary";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { decodeHtmlEntities, stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

const JOBDIVA_BASIC_AUTH = "Basic YXhlbG9uOmF4ZWxvbg==";
const PAGE_SIZE = 100;

interface JobDivaConfig {
  host: string;
  account: string;
  compid: number;
  divisions: number[];
}

interface JobDivaSession extends JobDivaConfig {
  portalId: number;
  token: string;
}

interface JobDivaListing {
  externalId: string;
  title: string;
  location: string;
  url: string;
  raw: Record<string, unknown>;
}

interface JobDivaPage {
  total: number;
  jobs: JobDivaListing[];
}

export interface FetchJobDivaJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  apiOriginOverride?: string;
  detailConcurrency?: number;
}

function normalizeInteger(value: string, label: string): number {
  if (!/^-?\d+$/.test(value.trim())) throw new Error(`Invalid JobDiva ${label}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid JobDiva ${label}`);
  return Object.is(parsed, -0) ? 0 : parsed;
}

export function decodeJobDivaToken(value: string): JobDivaConfig {
  const [rawHost, rawAccount, rawCompid, rawDivisions = "", ...extra] = value.trim().split("|");
  const host = rawHost?.toLowerCase();
  const account = rawAccount?.toLowerCase();
  if (extra.length || !/^www\d*\.jobdiva\.com$/.test(host ?? "") || !/^[a-z0-9]{64}$/.test(account ?? "")) {
    throw new Error("Invalid JobDiva board token");
  }
  const compid = normalizeInteger(rawCompid ?? "", "company ID");
  const divisions = rawDivisions
    ? [...new Set(rawDivisions.split(",").map((entry) => normalizeInteger(entry, "division ID")))].sort((a, b) => a - b)
    : [];
  if (divisions.some((division) => division < 0)) throw new Error("Invalid JobDiva division ID");
  return { host, account, compid, divisions };
}

export function normalizeJobDivaToken(value: string): string {
  const config = decodeJobDivaToken(value);
  return `${config.host}|${config.account}|${config.compid}|${config.divisions.join(",")}`;
}

export function canonicalJobDivaUrl(value: string): string {
  const { host, account, compid, divisions } = decodeJobDivaToken(normalizeJobDivaToken(value));
  const query = new URLSearchParams({ a: account, compid: String(compid) });
  if (divisions.length) query.set("divisions", divisions.join(","));
  return `https://${host}/portal/?${query.toString()}#/`;
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  for (const key of ["displayName", "name", "label", "value"]) {
    if (typeof object[key] === "string" && object[key].trim()) return object[key].trim();
  }
  return null;
}

function parsePage(payload: unknown, config: JobDivaConfig): JobDivaPage {
  if (!payload || typeof payload !== "object") throw new Error("JobDiva listing response is not an object");
  const object = payload as Record<string, unknown>;
  if (!Number.isInteger(object.total) || (object.total as number) < 0 || (object.total as number) > 100_000 || !Array.isArray(object.data)) {
    throw new Error("JobDiva listing response has invalid pagination");
  }
  const root = canonicalJobDivaUrl(`${config.host}|${config.account}|${config.compid}|${config.divisions.join(",")}`);
  const jobs = object.data.map((entry): JobDivaListing => {
    if (!entry || typeof entry !== "object") throw new Error("JobDiva listing contains an invalid job row");
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === "number" ? raw.id : Number(raw.id);
    const title = textValue(raw.title) ?? "";
    const location = textValue(raw.location) ?? "Unknown";
    if (!Number.isSafeInteger(id) || id <= 0 || !title) throw new Error("JobDiva listing is missing job identity or title");
    const externalId = String(id);
    return { externalId, title, location, url: `${root}jobs/${externalId}?jobtitle=${encodeURIComponent(title)}`, raw };
  });
  return { total: object.total as number, jobs };
}

function searchBody(from: number, to: number, divisions: number[]): string {
  return new URLSearchParams({
    portalID: "1", from: String(from), to: String(to), keywords: "", country: "", states: "", city: "",
    zipcode: "", miles: "", jobCategories: "", jobTypes: "", jobDivisions: divisions.join(","),
    onsiteFlex: "", qualifications: "", unit: "mi",
  }).toString();
}

async function fetchPage(
  session: JobDivaSession,
  apiOrigin: string,
  from: number,
  to: number,
  retryOptions: FetchWithRetryOptions,
): Promise<JobDivaPage> {
  const response = await fetchWithRetry(`${apiOrigin}/candPortal/rest/job/searchjobsportal`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      portalID: String(session.portalId),
      token: session.token,
      a: session.account,
    },
    body: searchBody(from, to, session.divisions),
  }, retryOptions);
  return parsePage(await response.json(), session);
}

async function fetchCompleteListings(
  session: JobDivaSession,
  apiOrigin: string,
  retryOptions: FetchWithRetryOptions,
): Promise<JobDivaListing[]> {
  const first = await fetchPage(session, apiOrigin, 1, PAGE_SIZE, retryOptions);
  const pageCount = Math.ceil(first.total / PAGE_SIZE);
  if (first.jobs.length !== Math.min(PAGE_SIZE, first.total)) throw new Error("JobDiva first page is incomplete");
  const jobs = [...first.jobs];
  // JobDiva stores search paging state in the anonymous session, so pages must be requested in
  // order. Parallel page calls can cross and return a different slice for the same range.
  for (let page = 1; page < pageCount; page++) {
    const from = page * PAGE_SIZE + 1;
    const parsed = await fetchPage(session, apiOrigin, from, Math.min(first.total, from + PAGE_SIZE - 1), retryOptions);
    if (parsed.total !== first.total || parsed.jobs.length !== Math.min(PAGE_SIZE, first.total - from + 1)) {
      throw new Error("JobDiva pagination shifted or returned an incomplete page");
    }
    jobs.push(...parsed.jobs);
  }
  const seen = new Set<string>();
  for (const job of jobs) {
    if (seen.has(job.externalId)) throw new Error(`JobDiva duplicate job ${job.externalId} across pages`);
    seen.add(job.externalId);
  }
  if (jobs.length !== first.total) throw new Error("JobDiva traversal did not match the reported total");
  return jobs;
}

function parsePostedAt(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseDetail(payload: unknown, listing: JobDivaListing): NormalizedJob {
  if (!payload || typeof payload !== "object") throw new Error(`JobDiva job ${listing.externalId} has no detail object`);
  const job = (payload as Record<string, unknown>).job;
  if (!job || typeof job !== "object") throw new Error(`JobDiva job ${listing.externalId} has no exact job payload`);
  const raw = job as Record<string, unknown>;
  const id = typeof raw.id === "number" ? raw.id : Number(raw.id);
  const title = textValue(raw.title) ?? "";
  const descriptionHtml = textValue(raw.jobDescription) ?? "";
  if (String(id) !== listing.externalId || title !== listing.title || !descriptionHtml) {
    throw new Error(`JobDiva job ${listing.externalId} has mismatched identity/title or no full description`);
  }
  const descriptionText = stripHtml(decodeHtmlEntities(descriptionHtml));
  if (!descriptionText) throw new Error(`JobDiva job ${listing.externalId} has an empty description`);
  const employmentType = textValue(raw.positionType);
  const payRate = textValue(raw.payRate);
  const workingRemote = typeof raw.workingRemote === "number" ? raw.workingRemote : Number(raw.workingRemote ?? 0);
  const mainLocation = raw.mainLocation && typeof raw.mainLocation === "object" ? raw.mainLocation as Record<string, unknown> : null;
  const detailLocation = textValue(raw.location) ?? (mainLocation
    ? [textValue(mainLocation.city), textValue(mainLocation.state), textValue(mainLocation.country)].filter(Boolean).join(", ")
    : "");
  const location = listing.location === "Unknown" && detailLocation ? detailLocation : listing.location;
  return {
    externalId: listing.externalId,
    title,
    location,
    department: textValue(raw.jobSector),
    url: listing.url,
    descriptionHtml,
    descriptionText,
    employmentType,
    workplaceType: workingRemote !== 0 || /\bremote\b/i.test(location) ? "Remote" : null,
    salaryText: payRate || extractSalaryText(descriptionText),
    postedAt: parsePostedAt(raw.postDate),
    raw: { listing: listing.raw, detail: raw },
  };
}

/** JobDiva's public candidate portal bootstraps a tenant-scoped anonymous session. The adapter
 * traverses the exact division-scoped search result count before the U.S. gate and detail calls. */
export async function fetchJobDivaJobs(tokenValue: string, options: FetchJobDivaJobsOptions = {}): Promise<NormalizedJob[]> {
  const config = decodeJobDivaToken(normalizeJobDivaToken(tokenValue));
  const {
    maxJobs,
    apiOriginOverride = "https://ws.jobdiva.com",
    detailConcurrency = 5,
    usOnly,
    existingExternalIds,
    onLocationFiltered,
    ...retryOptions
  } = options;
  const apiOrigin = apiOriginOverride.replace(/\/$/, "");
  const auth = await fetchWithRetry(`${apiOrigin}/candPortal/rest/auth/a`, {
    headers: {
      Accept: "application/json",
      Authorization: JOBDIVA_BASIC_AUTH,
      portalID: "1",
      a: config.account,
      compid: String(config.compid),
    },
  }, retryOptions);
  const authPayload = await auth.json() as Record<string, unknown>;
  const portalId = typeof authPayload.portalID === "number" ? authPayload.portalID : Number(authPayload.portalID);
  const returnedCompid = typeof authPayload.compid === "number" ? authPayload.compid : Number(authPayload.compid);
  const returnedAccount = textValue(authPayload.a)?.toLowerCase();
  const sessionToken = textValue(authPayload.token);
  if (!Number.isSafeInteger(portalId) || portalId <= 0 || returnedCompid !== config.compid
    || returnedAccount !== config.account || !sessionToken || sessionToken.length < 16) {
    throw new Error("JobDiva bootstrap returned mismatched tenant identity");
  }
  const session: JobDivaSession = { ...config, portalId, token: sessionToken };
  const listings = await fetchCompleteListings(session, apiOrigin, retryOptions);
  const confirmation = await fetchCompleteListings(session, apiOrigin, retryOptions);
  if (listings.length !== confirmation.length
    || listings.some((job, index) => job.externalId !== confirmation[index]?.externalId)) {
    throw new Error("JobDiva repeated snapshots disagreed; refusing authoritative ingestion");
  }
  const normalized = listings.map((job): NormalizedJob => ({
    externalId: job.externalId, title: job.title, location: job.location, department: null, url: job.url,
    descriptionHtml: null, descriptionText: "", employmentType: null, workplaceType: null, salaryText: null,
    postedAt: parsePostedAt(job.raw.postDate), raw: job,
  }));
  const selected = filterJobsToUs(normalized, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const detailLimit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 10)));
  return Promise.all(selected.map((job) => job.lifecycleOnly ? job : detailLimit(async () => {
    const listing = job.raw as JobDivaListing;
    let response: Response;
    try {
      response = await fetchWithRetry(`${apiOrigin}/candPortal/rest/job/getdetailbyjobid/${listing.externalId}?compid=${config.compid}`, {
        headers: { Accept: "application/json", portalID: String(session.portalId), token: session.token, a: session.account },
      }, retryOptions);
    } catch (error) {
      if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 404) {
        throw new Error(`JobDiva listing/detail snapshot drift for job ${listing.externalId}; refusing authoritative ingestion`);
      }
      throw error;
    }
    return parseDetail(await response.json(), listing);
  })));
}
