import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface CornerstoneIdentity { host: string; siteId: number; corp: string }
interface CornerstoneContext {
  corp?: string; cultureID?: number; cultureName?: string; token?: string;
  endpoints?: { cloud?: string };
}
interface CornerstoneRouteInfo { cid?: string }
interface CornerstoneLocation { city?: string; state?: string; country?: string }
interface CornerstoneRequisition {
  requisitionId?: number; postingEffectiveDate?: string; postingExpirationDate?: string;
  displayJobTitle?: string; locations?: CornerstoneLocation[]; externalDescription?: string;
}
interface CornerstoneSearchResponse {
  status?: string; data?: { totalCount?: number; requisitions?: CornerstoneRequisition[] };
}
export interface FetchCornerstoneJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number; originOverride?: string; apiOriginOverride?: string;
}

export function decodeCornerstoneToken(value: string): CornerstoneIdentity {
  const [host, siteIdText, corp, ...extra] = value.trim().split("|");
  const siteId = Number(siteIdText);
  if (extra.length || !/^[a-z0-9.-]+\.csod\.com$/i.test(host ?? "")
    || !Number.isSafeInteger(siteId) || siteId <= 0 || !/^[a-z0-9_-]+$/i.test(corp ?? "")) {
    throw new Error("Invalid Cornerstone host/site/corp token");
  }
  return { host: host.toLowerCase(), siteId, corp: corp.toLowerCase() };
}

export function normalizeCornerstoneToken(value: string): string {
  const { host, siteId, corp } = decodeCornerstoneToken(value);
  return `${host}|${siteId}|${corp}`;
}

export function canonicalCornerstoneUrl(value: string): string {
  const { host, siteId, corp } = decodeCornerstoneToken(normalizeCornerstoneToken(value));
  const url = new URL(`https://${host}/ux/ats/careersite/${siteId}/home`);
  url.searchParams.set("c", corp);
  return url.toString();
}

function embeddedJson<T>(html: string, pattern: RegExp, label: string): T {
  const encoded = html.match(pattern)?.[1];
  if (!encoded) throw new Error(`Cornerstone bootstrap has no ${label}`);
  try { return JSON.parse(encoded) as T; }
  catch { throw new Error(`Cornerstone bootstrap has invalid ${label}`); }
}

function parseBootstrap(html: string, identity: CornerstoneIdentity): Required<Pick<CornerstoneContext, "cultureID" | "cultureName" | "token">> & { apiOrigin: string } {
  const route = embeddedJson<CornerstoneRouteInfo>(html, /csodPlayerRouteInfo\s*=\s*(\{[\s\S]*?\})\s*;<\/script>/i, "route identity");
  const context = embeddedJson<CornerstoneContext>(html, /csod\.context\s*=\s*(\{[\s\S]*?\})\s*;<\/script>/i, "public context");
  let api: URL;
  try { api = new URL(context.endpoints?.cloud ?? ""); }
  catch { throw new Error("Cornerstone bootstrap has no valid API origin"); }
  if (route.cid !== String(identity.siteId) || context.corp?.toLowerCase() !== identity.corp
    || !Number.isSafeInteger(context.cultureID) || !context.cultureName || !context.token
    || api.protocol !== "https:" || !/^[a-z0-9-]+\.api\.csod\.com$/i.test(api.hostname)) {
    throw new Error("Cornerstone bootstrap tenant/site/API identity mismatch");
  }
  return { cultureID: context.cultureID!, cultureName: context.cultureName, token: context.token, apiOrigin: api.origin };
}

function formatLocation(locations: CornerstoneLocation[] | undefined): string {
  if (!Array.isArray(locations) || locations.length === 0) return "Unknown";
  return locations.map((item) => [item.city, item.state, item.country].filter(Boolean).join(", "))
    .filter(Boolean).join("; ") || "Unknown";
}

function parsePostingDate(value: string | undefined): string | null {
  const match = value?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeRequisition(row: CornerstoneRequisition, identity: CornerstoneIdentity, origin: string): NormalizedJob {
  const externalId = String(row.requisitionId ?? "");
  const title = row.displayJobTitle?.trim();
  const descriptionHtml = row.externalDescription?.trim() || "";
  const descriptionText = stripHtml(descriptionHtml);
  if (!/^\d+$/.test(externalId) || !title || !descriptionText) {
    throw new Error("Cornerstone listing has invalid job identity or no full description");
  }
  return {
    externalId, title, location: formatLocation(row.locations), department: null,
    url: `${origin}/ux/ats/careersite/${identity.siteId}/home/requisition/${externalId}?c=${encodeURIComponent(identity.corp)}`,
    descriptionHtml, descriptionText, employmentType: null, workplaceType: null, salaryText: null,
    postedAt: parsePostingDate(row.postingEffectiveDate), raw: { identity, requisition: row },
  };
}

/** Cornerstone's public career site bootstraps a short-lived anonymous token. The adapter obtains a
 * fresh token for every scan, exhausts the exact-count API, and never persists the token. */
export async function fetchCornerstoneJobs(tokenValue: string, options: FetchCornerstoneJobsOptions = {}): Promise<NormalizedJob[]> {
  const identity = decodeCornerstoneToken(normalizeCornerstoneToken(tokenValue));
  const { maxJobs, originOverride, apiOriginOverride, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = (originOverride ?? `https://${identity.host}`).replace(/\/$/, "");
  const boardUrl = `${origin}/ux/ats/careersite/${identity.siteId}/home?c=${encodeURIComponent(identity.corp)}`;
  const bootstrapResponse = await fetchWithRetry(boardUrl, { headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" } }, retryOptions);
  const bootstrap = parseBootstrap(await bootstrapResponse.text(), identity);
  const apiOrigin = (apiOriginOverride ?? bootstrap.apiOrigin).replace(/\/$/, "");
  const pageSize = 25; const rows: CornerstoneRequisition[] = []; const seen = new Set<string>();
  let exactCount: number | null = null;
  for (let pageNumber = 1; exactCount === null || rows.length < exactCount; pageNumber++) {
    const body = { careerSiteId: identity.siteId, careerSitePageId: identity.siteId, pageNumber, pageSize,
      cultureId: bootstrap.cultureID, searchText: "", cultureName: bootstrap.cultureName, states: [],
      countryCodes: [], cities: [], placeID: "", radius: null, postingsWithinDays: null,
      customFieldCheckboxKeys: [], customFieldDropdowns: [], customFieldRadios: [] };
    const endpoint = `${apiOrigin}/rec-job-search/external/jobs`;
    const payload = await parseJsonOrThrow<CornerstoneSearchResponse>(await fetchWithRetry(endpoint, {
      method: "POST", headers: { Accept: "application/json", Authorization: `Bearer ${bootstrap.token}`,
        "Content-Type": "application/json", "Csod-Accept-Language": bootstrap.cultureName, "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify(body),
    }, retryOptions), endpoint);
    const count = payload.data?.totalCount; const page = payload.data?.requisitions;
    if (payload.status !== "Success" || !Number.isSafeInteger(count) || (count ?? -1) < 0 || !Array.isArray(page)) {
      throw new Error("Cornerstone search returned invalid count or rows");
    }
    if (exactCount === null) exactCount = count!;
    const expected = Math.min(pageSize, exactCount - rows.length);
    if (count !== exactCount || page.length !== expected) throw new Error("Cornerstone pagination shifted or returned an incomplete page");
    for (const row of page) {
      const id = String(row.requisitionId ?? "");
      if (seen.has(id)) throw new Error(`Cornerstone duplicate job ${id}`);
      seen.add(id); rows.push(row);
    }
  }
  if (rows.length !== exactCount) throw new Error("Cornerstone traversal did not match count");
  return filterJobsToUs(rows.map((row) => normalizeRequisition(row, identity, origin)),
    { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
}
