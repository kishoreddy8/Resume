import pLimit from "p-limit";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { degradeMissingDescription } from "@/lib/ats/jobContentFailure";
import { extractSalaryText } from "@/lib/extractSalary";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { decodeHtmlEntities, stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

/**
 * ADMIN-SEC-2 — JobDiva's portal bootstrap credential, read from server-only process environment.
 *
 * This used to be a Basic Authorization header committed directly into this file and sent on every
 * JobDiva discovery request. That is an embedded secret in a public source tree: it is readable by
 * anyone with repository access, it cannot be rotated without a code change and redeploy, and it
 * travels into every clone and every fork of the history.
 *
 * Two variables rather than one pre-encoded header, deliberately. Basic auth is a username and a
 * password; storing the encoded composite would oblige an operator to base64 it by hand and would
 * put a single opaque credential string into the environment for no benefit. Encoding happens here,
 * at the moment of use.
 *
 * BOTH must be present. A half-configured connector is not usable, and treating a missing password
 * as an empty one would send a malformed credential to a third party rather than failing locally.
 *
 * The thrown message deliberately begins with "Missing " and names only the variables, never their
 * values: categorizeThrownError (src/lib/scan/errors.ts) maps a leading "Missing"/"Invalid" to the
 * `invalid_config` category, which is exactly right here — this is a configuration problem, not a
 * broken board, and it is non-retryable, so the scanner will not hammer JobDiva over a setting.
 */
const JOBDIVA_USERNAME_ENV = "JOBDIVA_API_USERNAME";
const JOBDIVA_PASSWORD_ENV = "JOBDIVA_API_PASSWORD";

/** True when both credential variables are set. Reports configuration state only — never a value. */
export function isJobDivaConfigured(): boolean {
  return Boolean(process.env[JOBDIVA_USERNAME_ENV]) && Boolean(process.env[JOBDIVA_PASSWORD_ENV]);
}

function jobDivaAuthorizationHeader(): string {
  const username = process.env[JOBDIVA_USERNAME_ENV];
  const password = process.env[JOBDIVA_PASSWORD_ENV];
  if (!username || !password) {
    throw new Error(
      `Missing JobDiva API credentials — set ${JOBDIVA_USERNAME_ENV} and ${JOBDIVA_PASSWORD_ENV} in the server environment.`
    );
  }
  return `Basic ${Buffer.from(`${username}:${password}`, "utf-8").toString("base64")}`;
}

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

// Returns null (never throws) for a per-job CONTENT gap — a malformed/empty detail payload or a
// missing description — so the caller can degrade gracefully (see jobContentFailure.ts) instead of
// aborting the whole company scan. An IDENTITY mismatch (wrong job ID/title returned for the
// requested detail) stays a real throw: that's a more serious signal than one job's content being
// incomplete, and worth surfacing as a genuine connector problem.
function parseDetail(payload: unknown, listing: JobDivaListing): NormalizedJob | null {
  if (!payload || typeof payload !== "object") return null;
  const job = (payload as Record<string, unknown>).job;
  if (!job || typeof job !== "object") return null;
  const raw = job as Record<string, unknown>;
  const id = typeof raw.id === "number" ? raw.id : Number(raw.id);
  const title = textValue(raw.title) ?? "";
  if (String(id) !== listing.externalId || title !== listing.title) {
    throw new Error(`JobDiva job ${listing.externalId} has mismatched identity/title`);
  }
  const descriptionHtml = textValue(raw.jobDescription) ?? "";
  if (!descriptionHtml) return null;
  const descriptionText = stripHtml(decodeHtmlEntities(descriptionHtml));
  if (!descriptionText) return null;
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
  /* Resolved before the request is built: a missing credential must fail locally, never as an
   * outbound call carrying an empty or malformed Authorization header. */
  const authorization = jobDivaAuthorizationHeader();
  const auth = await fetchWithRetry(`${apiOrigin}/candPortal/rest/auth/a`, {
    headers: {
      Accept: "application/json",
      Authorization: authorization,
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
        // The job disappeared between the listing and detail fetch — a per-job timing/content gap
        // (common on high-churn boards), not a board-level failure; degrade gracefully instead of
        // aborting the whole company scan (see jobContentFailure.ts).
        return degradeMissingDescription(job);
      }
      throw error;
    }
    return parseDetail(await response.json(), listing) ?? degradeMissingDescription(job);
  })));
}
