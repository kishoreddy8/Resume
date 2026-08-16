import pLimit from "p-limit";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { degradeMissingDescription } from "@/lib/ats/jobContentFailure";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { decodeHtmlEntities, stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface EightfoldIdentity { host: string; domain: string }
interface EightfoldPosition {
  id?: number; name?: string; posting_name?: string; location?: string; locations?: string[];
  department?: string; business_unit?: string; t_update?: number; t_create?: number;
  ats_job_id?: string; display_job_id?: string; job_description?: string;
  work_location_option?: string | null; canonicalPositionUrl?: string; isPrivate?: boolean;
}
interface EightfoldPage { domain?: string; count?: number; positions?: EightfoldPosition[] }
export interface FetchEightfoldJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number; originOverride?: string; detailConcurrency?: number;
}

export function decodeEightfoldToken(value: string): EightfoldIdentity {
  const [host, domain, ...extra] = value.trim().split("|");
  if (extra.length || !/^[a-z0-9.-]+\.eightfold\.ai$/i.test(host ?? "")
    || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(domain ?? "")) throw new Error("Invalid Eightfold host/domain token");
  return { host: host.toLowerCase(), domain: domain.toLowerCase() };
}

export function normalizeEightfoldToken(value: string): string {
  const { host, domain } = decodeEightfoldToken(value);
  return `${host}|${domain}`;
}

export function canonicalEightfoldUrl(value: string): string {
  const { host, domain } = decodeEightfoldToken(normalizeEightfoldToken(value));
  const url = new URL(`https://${host}/careers`); url.searchParams.set("domain", domain); return url.toString();
}

function parseBootstrap(html: string, identity: EightfoldIdentity): EightfoldPage {
  const encoded = html.match(/<code\b[^>]*id=["']smartApplyData["'][^>]*>([\s\S]*?)<\/code>/i)?.[1];
  if (!encoded) throw new Error("Eightfold board has no public SmartApply bootstrap");
  let parsed: EightfoldPage;
  try { parsed = JSON.parse(decodeHtmlEntities(encoded)) as EightfoldPage; }
  catch { throw new Error("Eightfold SmartApply bootstrap is invalid JSON"); }
  if (parsed.domain?.toLowerCase() !== identity.domain || !Number.isInteger(parsed.count)
    || (parsed.count ?? -1) < 0 || !Array.isArray(parsed.positions)) {
    throw new Error("Eightfold bootstrap tenant/count identity mismatch");
  }
  return parsed;
}

function location(position: EightfoldPosition): string {
  return (position.locations?.filter(Boolean).join("; ") || position.location?.trim() || "Unknown");
}

function listingJob(position: EightfoldPosition, identity: EightfoldIdentity, origin: string): NormalizedJob {
  const externalId = String(position.id ?? ""); const title = (position.posting_name ?? position.name)?.trim();
  if (!/^\d{6,}$/.test(externalId) || !title || position.isPrivate === true) throw new Error("Eightfold listing has invalid public job identity");
  return { externalId, title, location: location(position), department: position.department?.trim() || null,
    url: `${origin}/careers/job/${externalId}`, descriptionHtml: null, descriptionText: "",
    employmentType: null, workplaceType: position.work_location_option?.trim() || null, salaryText: null,
    postedAt: Number.isFinite(position.t_create) ? new Date(position.t_create! * 1000).toISOString() : null,
    raw: { identity, listing: position } };
}

function detailJob(payload: EightfoldPosition, listing: NormalizedJob, identity: EightfoldIdentity, origin: string): NormalizedJob {
  const externalId = String(payload.id ?? ""); const title = (payload.posting_name ?? payload.name)?.trim();
  let canonical: URL;
  try { canonical = new URL(payload.canonicalPositionUrl ?? ""); } catch { throw new Error(`Eightfold job ${listing.externalId} has no canonical identity`); }
  if (externalId !== listing.externalId || title !== listing.title || canonical.hostname.toLowerCase() !== identity.host
    || !canonical.pathname.endsWith(`/careers/job/${externalId}`)) throw new Error(`Eightfold job ${listing.externalId} has mismatched detail identity`);
  const descriptionHtml = payload.job_description?.trim() || ""; const descriptionText = stripHtml(descriptionHtml);
  if (!descriptionText) return degradeMissingDescription(listing);
  return { ...listing, location: location(payload) || listing.location, department: payload.department?.trim() || listing.department,
    url: `${origin}/careers/job/${externalId}`, descriptionHtml, descriptionText,
    workplaceType: payload.work_location_option?.trim() || listing.workplaceType,
    postedAt: Number.isFinite(payload.t_create) ? new Date(payload.t_create! * 1000).toISOString() : listing.postedAt,
    raw: { identity, listing: (listing.raw as { listing: EightfoldPosition }).listing, detail: payload } };
}

/** Eightfold SmartApply exposes an exact count and offset-paginated public feed. All ten-row pages
 * are exhausted and identity checked before the U.S. gate; only selected jobs receive full details. */
export async function fetchEightfoldJobs(tokenValue: string, options: FetchEightfoldJobsOptions = {}): Promise<NormalizedJob[]> {
  const identity = decodeEightfoldToken(normalizeEightfoldToken(tokenValue));
  const { maxJobs, originOverride, detailConcurrency = 4, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = (originOverride ?? `https://${identity.host}`).replace(/\/$/, "");
  const bootstrapUrl = `${origin}/careers`;
  const bootstrapResponse = await fetchWithRetry(bootstrapUrl, { headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" } }, retryOptions);
  const bootstrap = parseBootstrap(await bootstrapResponse.text(), identity);
  const pageSize = 10; const listings: EightfoldPosition[] = []; const seen = new Set<string>();
  for (let start = 0; start < (bootstrap.count ?? 0); start += pageSize) {
    const url = new URL(`${origin}/api/apply/v2/jobs`); url.searchParams.set("domain", identity.domain);
    url.searchParams.set("profile", ""); url.searchParams.set("start", String(start)); url.searchParams.set("num", String(pageSize));
    const page = await parseJsonOrThrow<EightfoldPage>(await fetchWithRetry(url.toString(), { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } }, retryOptions), url.toString());
    const expected = Math.min(pageSize, (bootstrap.count ?? 0) - start);
    if (page.domain && page.domain.toLowerCase() !== identity.domain || page.count !== bootstrap.count
      || !Array.isArray(page.positions) || page.positions.length !== expected) throw new Error("Eightfold pagination shifted or returned an incomplete page");
    for (const position of page.positions) { const id = String(position.id ?? ""); if (seen.has(id)) throw new Error(`Eightfold duplicate job ${id}`); seen.add(id); listings.push(position); }
  }
  if (listings.length !== bootstrap.count) throw new Error("Eightfold traversal did not match count");
  const selected = filterJobsToUs(listings.map((position) => listingJob(position, identity, origin)),
    { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const limit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 8)));
  return Promise.all(selected.map((job) => job.lifecycleOnly ? job : limit(async () => {
    const url = `${origin}/api/apply/v2/jobs/${job.externalId}?domain=${encodeURIComponent(identity.domain)}`;
    const detail = await parseJsonOrThrow<EightfoldPosition>(await fetchWithRetry(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } }, retryOptions), url);
    return detailJob(detail, job, identity, origin);
  })));
}
