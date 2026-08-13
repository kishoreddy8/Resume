import pLimit from "p-limit";
import { chromium } from "playwright";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { decodeHtmlEntities, stripHtml } from "@/lib/stripHtml";
import { isUrlSafeForNavigation } from "@/lib/net/safeFetch";
import type { NormalizedJob } from "@/types";

type AvatureMode = "template" | "legacy";
interface AvatureIdentity { host: string; mode: AvatureMode; portalPath: string; page: string }
interface AvatureField { stringValue?: string; jsonValue?: unknown }
interface AvatureResult { id?: number; entityId?: number; fields?: Record<string, AvatureField> }
interface AvatureTemplatePage {
  results?: AvatureResult[]; offset?: number; total?: string | number; recordsFrom?: number; recordsTo?: number;
  totalLimitReached?: boolean; columns?: Array<{ code?: string; label?: string }>;
  links?: Array<Record<string, string>>;
}
interface Listing { externalId: string; title: string; location: string; url: string; postedAt: string | null; raw: unknown }
export interface FetchAvatureJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number; originOverride?: string; detailConcurrency?: number;
  /** Test-only. Never enable for stored production sources. */
  allowPrivateNetworksForTests?: boolean;
}

export function decodeAvatureToken(value: string): AvatureIdentity {
  const [host, mode, portalPath, page, ...extra] = value.trim().split("|");
  if (extra.length || !/^[a-z0-9.-]+\.avature\.(?:net|com)$/i.test(host ?? "")
    || !/^(?:template|legacy)$/.test(mode ?? "") || !/^[a-z0-9_/-]+$/i.test(portalPath ?? "")
    || !/^[a-z0-9_-]+$/i.test(page ?? "") || portalPath.includes("..")) throw new Error("Invalid Avature board token");
  return { host: host.toLowerCase(), mode: mode as AvatureMode, portalPath: portalPath.replace(/^\/+|\/+$/g, ""), page };
}

export function normalizeAvatureToken(value: string): string {
  const item = decodeAvatureToken(value);
  return `${item.host}|${item.mode}|${item.portalPath}|${item.page}`;
}

export function canonicalAvatureUrl(value: string): string {
  const item = decodeAvatureToken(normalizeAvatureToken(value));
  return item.mode === "template" ? `https://${item.host}/${item.portalPath}/${item.page}` : `https://${item.host}/${item.portalPath}`;
}

function clean(value: string | undefined): string { return stripHtml(decodeHtmlEntities(value ?? "")).trim(); }
function isoDate(value: string | undefined): string | null {
  if (!value) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function meta(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.match(new RegExp(`<meta\\b[^>]*name=["']${escaped}["'][^>]*content=["']([^"']*)`, "i"))?.[1]
    ?? html.match(new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*name=["']${escaped}["']`, "i"))?.[1] ?? null;
}

function validateBootstrap(html: string, identity: AvatureIdentity): number {
  const portalId = meta(html, "avature.portal.id");
  const portalPath = meta(html, "avature.portal.urlPath");
  if (!portalId || !/^\d+$/.test(portalId) || portalPath !== identity.portalPath.split("/").at(-1)) {
    throw new Error("Avature bootstrap portal identity mismatch");
  }
  if (identity.mode === "template" && meta(html, "avature.portal.page") !== identity.page) throw new Error("Avature template page identity mismatch");
  return Number(portalId);
}

function findField(page: AvatureTemplatePage, row: AvatureResult, wanted: RegExp): AvatureField | undefined {
  const code = page.columns?.find((column) => wanted.test(`${column.code ?? ""} ${column.label ?? ""}`))?.code;
  return code ? row.fields?.[code] : undefined;
}

function parseTemplatePage(payload: unknown, expectedOffset: number, pageSize: number): { total: number; jobs: Listing[] } {
  if (!payload || typeof payload !== "object") throw new Error("Avature template list is not an object");
  const page = payload as AvatureTemplatePage; const total = Number(page.total);
  const isFinalPage = expectedOffset + pageSize >= total;
  if (!Number.isSafeInteger(total) || total < 0 || total > 100_000 || page.offset !== expectedOffset
    || page.totalLimitReached !== isFinalPage || !Array.isArray(page.results) || !Array.isArray(page.columns) || !Array.isArray(page.links)) {
    throw new Error(`Avature template list has invalid pagination identity (offset=${String(page.offset)}, expected=${expectedOffset}, total=${String(page.total)}, rows=${Array.isArray(page.results) ? page.results.length : "invalid"}, limited=${String(page.totalLimitReached)}, columns=${Array.isArray(page.columns)}, links=${Array.isArray(page.links)})`);
  }
  const expected = Math.min(pageSize, total - expectedOffset);
  if (page.results.length !== expected || page.links.length !== expected
    || (expected > 0 && (page.recordsFrom !== expectedOffset + 1 || page.recordsTo !== expectedOffset + expected))) {
    throw new Error("Avature template pagination shifted or returned an incomplete page");
  }
  const jobs = page.results.map((row, index): Listing => {
    const externalId = String(row.id ?? "");
    const title = clean(findField(page, row, /job posting title|job title|jobname/i)?.stringValue);
    const location = clean(findField(page, row, /joblocation|location/i)?.stringValue) || "Unknown";
    const postedAt = isoDate(clean(findField(page, row, /posteddate|date posted|\bdate\b/i)?.stringValue));
    const url = page.links?.[index]?.$detailLink;
    if (!url) throw new Error("Avature template row has no canonical detail URL");
    let detail: URL; try { detail = new URL(url); } catch { throw new Error("Avature template row has no canonical detail URL"); }
    if (!/^\d+$/.test(externalId) || !title || !detail.pathname.endsWith(`/${externalId}`)) throw new Error("Avature template row has invalid job identity");
    return { externalId, title, location, postedAt, url: detail.toString(), raw: row };
  });
  return { total, jobs };
}

async function fetchTemplateListings(identity: AvatureIdentity, origin: string, allowPrivateNetworksForTests: boolean): Promise<Listing[]> {
  const canonical = `${origin}/${identity.portalPath}/${identity.page}`;
  if (!(await isUrlSafeForNavigation(canonical, allowPrivateNetworksForTests))) throw new Error("Refused unsafe Avature board URL");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36" });
    await page.route("**/*", async (route) => {
      if (!(await isUrlSafeForNavigation(route.request().url(), allowPrivateNetworksForTests))) return route.abort();
      return route.continue();
    });
    let firstUrl = "";
    const first = new Promise<void>((resolve, reject) => {
      page.on("response", async (response) => {
        if (firstUrl || !new URL(response.url()).pathname.endsWith("/_portalList")) return;
        try { firstUrl = response.url(); await response.finished(); resolve(); } catch (error) { reject(error); }
      });
    });
    await page.goto(canonical, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (new URL(page.url()).hostname !== new URL(origin).hostname) throw new Error("Avature template redirected outside the pinned tenant");
    await Promise.race([first, new Promise((_, reject) => setTimeout(() => reject(new Error("Avature template list request timed out")), 20_000))]);
    const html = await page.content(); validateBootstrap(html, identity);
    const requestUrl = new URL(firstUrl); const pageSize = Number(requestUrl.searchParams.get("recordsPerPage"));
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || requestUrl.hostname !== new URL(origin).hostname) throw new Error("Avature template request identity mismatch");
    const stableUrl = new URL(firstUrl); stableUrl.searchParams.set("sort", "jobId"); stableUrl.searchParams.set("sortDirection", "DESC");
    const snapshot = async (): Promise<Listing[]> => {
      const jobs: Listing[] = []; let exactTotal: number | null = null;
      for (let offset = 0; exactTotal === null || offset < exactTotal; offset += pageSize) {
        const payload = await page.evaluate(async ({ rawUrl, nextOffset }) => {
        const url = new URL(rawUrl); url.searchParams.set("offset", String(nextOffset));
        const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`Avature page ${nextOffset} returned ${response.status}`);
        return response.json();
        }, { rawUrl: stableUrl.toString(), nextOffset: offset });
        const parsed = parseTemplatePage(payload, offset, pageSize);
        if (exactTotal === null) exactTotal = parsed.total;
        if (parsed.total !== exactTotal) throw new Error("Avature template total changed during traversal");
        jobs.push(...parsed.jobs);
      }
      return validateListings(jobs, exactTotal ?? 0, identity.host, originOverrideHost(origin));
    };
    const firstSnapshot = await snapshot(); const secondSnapshot = await snapshot();
    const fingerprint = (items: Listing[]) => JSON.stringify(items.map(({ externalId, title, location, url, postedAt }) => ({ externalId, title, location, url, postedAt })));
    if (fingerprint(firstSnapshot) !== fingerprint(secondSnapshot)) throw new Error("Avature template snapshots changed during traversal");
    return secondSnapshot;
  } finally { await browser.close(); }
}

function originOverrideHost(origin: string): string { return new URL(origin).hostname; }
function validateListings(jobs: Listing[], total: number, identityHost: string, expectedHost = identityHost): Listing[] {
  if (jobs.length !== total) throw new Error("Avature traversal did not match the exact total");
  const seen = new Set<string>();
  for (const job of jobs) { if (seen.has(job.externalId)) throw new Error(`Avature duplicate job ${job.externalId}`); seen.add(job.externalId);
    if (new URL(job.url).hostname !== expectedHost) throw new Error("Avature job URL left the pinned tenant"); }
  return jobs;
}

function legacyPage(html: string, identity: AvatureIdentity, expectedOffset: number): { total: number; jobs: Listing[] } {
  validateBootstrap(html, identity);
  const legend = clean(html.match(/<div\b[^>]*class=["'][^"']*list-controls__legend[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]);
  const match = legend.match(/^(\d+)-(\d+) of (\d+) results?$/i); if (!match) throw new Error("Avature legacy page has no exact result count");
  const from = Number(match[1]); const to = Number(match[2]); const total = Number(match[3]);
  if (from !== expectedOffset + 1 || to < from || to > total || total > 100_000) throw new Error("Avature legacy pagination identity mismatch");
  const articles = [...html.matchAll(/<article\b[^>]*class=["'][^"']*article--result[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi)];
  if (articles.length !== to - from + 1) throw new Error("Avature legacy page returned an incomplete page");
  const jobs = articles.map((article): Listing => {
    const body = article[1]; const link = body.match(/<h3\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']*\/JobDetail\/[^"']*\/(\d+))["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) throw new Error("Avature legacy row has no job identity");
    const values = (label: string) => clean(body.match(new RegExp(`<span\\b[^>]*>\\s*${label}:\\s*<\\/span>([\\s\\S]*?)<\\/p>`, "i"))?.[1]);
    const city = values("City"), state = values("State\\/Province"), country = values("Country");
    return { externalId: link[2], title: clean(link[3]), location: [city, state, country].filter(Boolean).join(", ") || "Unknown",
      url: decodeHtmlEntities(link[1]), postedAt: null, raw: { city, state, country } };
  });
  return { total, jobs };
}

async function fetchLegacyListings(identity: AvatureIdentity, origin: string, retry: FetchWithRetryOptions): Promise<Listing[]> {
  const root = `${origin}/${identity.portalPath}`; const pageSize = 5;
  const snapshot = async (): Promise<Listing[]> => {
    const jobs: Listing[] = [];
    const firstHtml = await (await fetchWithRetry(root, { headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" } }, retry)).text();
    const first = legacyPage(firstHtml, identity, 0); jobs.push(...first.jobs);
    for (let offset = pageSize; offset < first.total; offset += pageSize) {
      const url = `${root}/${identity.page}/?jobRecordsPerPage=${pageSize}&jobOffset=${offset}`;
      const parsed = legacyPage(await (await fetchWithRetry(url, { headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" } }, retry)).text(), identity, offset);
      if (parsed.total !== first.total) throw new Error("Avature legacy total changed during traversal"); jobs.push(...parsed.jobs);
    }
    return validateListings(jobs, first.total, identity.host, new URL(origin).hostname);
  };
  const first = await snapshot(); const second = await snapshot();
  const fingerprint = (items: Listing[]) => JSON.stringify(items.map(({ externalId, title, location, url }) => ({ externalId, title, location, url })));
  if (fingerprint(first) !== fingerprint(second)) throw new Error("Avature legacy snapshots changed during traversal");
  return second;
}

function jsonLdDetail(html: string): Record<string, unknown> | null {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const value = JSON.parse(match[1]) as Record<string, unknown>; if (value["@type"] === "JobPosting") return value; } catch { /* inspect the next block */ }
  } return null;
}

function detailJob(html: string, listing: Listing, identity: AvatureIdentity, expectedHost: string): NormalizedJob {
  const pageId = meta(html, "avature.portallist.search"); const pageName = meta(html, "avature.portal.page");
  const structured = jsonLdDetail(html);
  const legacyTitle = meta(html, "Description")?.replace(/\s+at\s+created\s+.*$/i, "");
  const title = clean(String(structured?.title ?? legacyTitle ?? ""));
  const descriptionHtml = typeof structured?.description === "string" ? structured.description : (() => {
    const article = [...html.matchAll(/<article\b[^>]*class=["'][^"']*article--details[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi)]
      .find((item) => /Description\s*(?:&amp;|&)\s*Requirements/i.test(item[1]));
    return article?.[1].match(/<div\b[^>]*class=["'][^"']*article__content__view[^"']*["'][^>]*>([\s\S]*)/i)?.[1] ?? "";
  })();
  const descriptionText = stripHtml(decodeHtmlEntities(descriptionHtml)).trim();
  const canonical = structured ? listing.url : decodeHtmlEntities(html.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)/i)?.[1] ?? "");
  let detail: URL; try { detail = new URL(canonical); } catch { throw new Error(`Avature job ${listing.externalId} has no canonical identity`); }
  if (pageId !== listing.externalId || !/^(?:FolderDetail|JobDetail)$/i.test(pageName ?? "") || detail.hostname !== expectedHost
    || !detail.pathname.endsWith(`/${listing.externalId}`) || title !== listing.title || !descriptionText) throw new Error(`Avature job ${listing.externalId} detail identity mismatch or empty description`);
  return { externalId: listing.externalId, title, location: listing.location, department: null, url: listing.url,
    descriptionHtml, descriptionText, employmentType: null, workplaceType: null, salaryText: null,
    postedAt: typeof structured?.datePosted === "string" ? isoDate(structured.datePosted) : listing.postedAt,
    raw: { identity, listing: listing.raw, detail: structured ?? { page: pageName } } };
}

export async function fetchAvatureJobs(tokenValue: string, options: FetchAvatureJobsOptions = {}): Promise<NormalizedJob[]> {
  const identity = decodeAvatureToken(normalizeAvatureToken(tokenValue));
  const { maxJobs, originOverride, detailConcurrency = 3, usOnly, existingExternalIds, onLocationFiltered,
    allowPrivateNetworksForTests = false, ...retry } = options;
  const origin = (originOverride ?? `https://${identity.host}`).replace(/\/$/, "");
  const listings = identity.mode === "template" ? await fetchTemplateListings(identity, origin, allowPrivateNetworksForTests) : await fetchLegacyListings(identity, origin, retry);
  const candidates: NormalizedJob[] = listings.map((job) => ({ externalId: job.externalId, title: job.title, location: job.location,
    department: null, url: job.url, descriptionHtml: null, descriptionText: "", employmentType: null, workplaceType: null,
    salaryText: null, postedAt: job.postedAt, raw: job.raw }));
  const selected = filterJobsToUs(candidates, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
  const byId = new Map(listings.map((item) => [item.externalId, item])); const limit = pLimit(Math.max(1, Math.min(6, Math.trunc(detailConcurrency))));
  return Promise.all(selected.map((candidate) => candidate.lifecycleOnly ? candidate : limit(async () => {
    const listing = byId.get(candidate.externalId!); if (!listing) throw new Error("Avature selected job disappeared from listing set");
    const html = await (await fetchWithRetry(listing.url, { headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" } }, retry)).text();
    return detailJob(html, listing, identity, new URL(origin).hostname);
  })));
}
