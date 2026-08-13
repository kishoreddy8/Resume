import crypto from "node:crypto";
import pLimit from "p-limit";
import { getDb } from "@/db";
import { safeFetch, SafeFetchError } from "@/lib/net/safeFetch";

export const ADAPTER_PROFILER_VERSION = "careerops.adapter-profiler.v2";
const DEFAULT_SAMPLES_PER_PROVIDER = 3;
const MAX_ENDPOINTS = 40;
const MAX_SCRIPTS = 3;

export type AdapterProfileOutcome =
  | "PUBLIC_ENDPOINT_EVIDENCE"
  | "PAGE_REACHABLE"
  | "BLOCKED_OR_EMPTY"
  | "FAILED_TEMPORARY"
  | "UNSAFE_URL";

export interface AdapterProfileCandidate {
  jobSourceId: number;
  organizationId: number;
  canonicalName: string;
  suspectedAts: string;
  sourceUrl: string;
}

export interface AdapterEndpointEvidence {
  shape: string;
  origin: "page" | "script";
  signals: string[];
}

export interface AdapterProfileEvidence {
  schemaVersion: typeof ADAPTER_PROFILER_VERSION;
  sourceUrlShape: string;
  finalUrlShape: string | null;
  status: number | null;
  contentType: string | null;
  bodyBytes: number;
  endpointEvidence: AdapterEndpointEvidence[];
  scriptShapesInspected: string[];
  queryKeys: string[];
  detectedSignals: string[];
  fingerprint: string;
}

export interface AdapterProfileResult {
  jobSourceId: number;
  organizationId: number;
  canonicalName: string;
  suspectedAts: string;
  sourceHost: string;
  outcome: AdapterProfileOutcome;
  endpointCandidates: number;
  apiEvidence: boolean;
  paginationEvidence: boolean;
  tenantEvidence: boolean;
  errorCategory: string | null;
  errorMessage: string | null;
  evidence: AdapterProfileEvidence;
  durationMs: number;
}

export interface AdapterProfileBatchSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  attempted: number;
  publicEndpointEvidence: number;
  pageReachable: number;
  blockedOrEmpty: number;
  failedTemporary: number;
  unsafeUrl: number;
  results: AdapterProfileResult[];
}

interface CandidateRow {
  job_source_id: number;
  organization_id: number;
  canonical_name: string;
  suspected_ats: string;
  source_url: string;
}

function boundedInteger(value: number, fallback: number, max: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.trunc(value), max)) : fallback;
}

/** Selects a diverse, bounded sample per unsupported ATS. A provider is complete for this profiler
 * version after the requested number of distinct sources has evidence, while newly discovered ATS
 * families automatically enter the queue. Connector identity conflicts are deliberately excluded. */
export function listAdapterProfileCandidates(options: {
  limit?: number;
  samplesPerProvider?: number;
  retryCompleted?: boolean;
} = {}): AdapterProfileCandidate[] {
  const limit = boundedInteger(options.limit ?? 6, 6, 50);
  const samples = boundedInteger(options.samplesPerProvider ?? DEFAULT_SAMPLES_PER_PROVIDER, DEFAULT_SAMPLES_PER_PROVIDER, 10);
  const completedClause = options.retryCompleted
    ? ""
    : `AND NOT EXISTS (
         SELECT 1 FROM ats_adapter_profile_runs own
         WHERE own.job_source_id=js.id AND own.profiler_version=?
       )`;
  const db = getDb();
  const rows = db.prepare(
    `WITH backlog AS (
       SELECT suspected_ats, COUNT(*) AS provider_count
       FROM job_sources
       WHERE resolution_status='NEEDS_ADAPTER' AND is_active=1
         AND suspected_ats IS NOT NULL AND suspected_ats <> 'connector_identity_conflict'
       GROUP BY suspected_ats
     ), candidates AS (
       SELECT js.id AS job_source_id, js.organization_id, o.canonical_name,
              js.suspected_ats, js.source_url, backlog.provider_count,
              ROW_NUMBER() OVER (PARTITION BY js.suspected_ats ORDER BY js.id) AS provider_rank
       FROM job_sources js
       JOIN organizations o ON o.id=js.organization_id
       JOIN backlog ON backlog.suspected_ats=js.suspected_ats
       WHERE js.resolution_status='NEEDS_ADAPTER' AND js.is_active=1
         AND js.source_url IS NOT NULL AND js.suspected_ats IS NOT NULL
         AND js.suspected_ats <> 'connector_identity_conflict'
         ${completedClause}
     )
     SELECT job_source_id, organization_id, canonical_name, suspected_ats, source_url
     FROM candidates c
     WHERE provider_rank <= ? - (
       SELECT COUNT(DISTINCT prior.job_source_id) FROM ats_adapter_profile_runs prior
       WHERE prior.suspected_ats=c.suspected_ats AND prior.profiler_version=?
     )
     ORDER BY provider_count DESC, provider_rank, suspected_ats, job_source_id
     LIMIT ?`
  ).all(...(options.retryCompleted
    ? [samples, ADAPTER_PROFILER_VERSION, limit]
    : [ADAPTER_PROFILER_VERSION, samples, ADAPTER_PROFILER_VERSION, limit])) as CandidateRow[];
  return rows.map((row) => ({
    jobSourceId: row.job_source_id,
    organizationId: row.organization_id,
    canonicalName: row.canonical_name,
    suspectedAts: row.suspected_ats,
    sourceUrl: row.source_url,
  }));
}

export function urlShape(value: string): string {
  try {
    const url = new URL(value.replace(/&amp;|&#038;|&#x26;/gi, "&").replace(/&#34;/gi, ""));
    const queryKeys = [...new Set([...url.searchParams.keys()])].sort();
    return `${url.protocol}//${url.hostname}${url.pathname}${queryKeys.length ? `?${queryKeys.map((key) => `${key}=<value>`).join("&")}` : ""}`;
  } catch {
    return "invalid-url";
  }
}

function signalsFor(value: string): string[] {
  const signals: string[] = [];
  if (/\b(?:api|graphql|services?|rest|ajax)\b/i.test(value)) signals.push("api");
  if (/\b(?:jobs?|requisitions?|postings?|openings?|positions?)\b/i.test(value)) signals.push("jobs");
  if (/[$?&](?:top|skip|offset|limit|page|pagesize|start|rows)=/i.test(value)) signals.push("pagination");
  if (/[?&](?:company|companyId|client|cid|tenant|site|careerSite|board|token)=/i.test(value)) signals.push("tenant");
  return signals;
}

function extractEndpointShapes(text: string, baseUrl: string, origin: "page" | "script"): AdapterEndpointEvidence[] {
  const raw = new Set<string>();
  const attributeRe = /(?:href|src|action)\s*=\s*["']([^"']+)["']/gi;
  const absoluteRe = /https?:\\?\/\\?\/[a-z0-9.-]+(?:\\?\/[a-z0-9_~!$&'()*+,;=:@%/?#.-]*)?/gi;
  const pathRe = /["'`](\/(?:[^"'`\s]{0,180})(?:api|graphql|jobs?|requisitions?|postings?|openings?|positions?)(?:[^"'`\s]{0,180}))["'`]/gi;
  for (const match of text.matchAll(attributeRe)) raw.add(match[1]);
  for (const match of text.matchAll(absoluteRe)) raw.add(match[0].replace(/\\\//g, "/"));
  for (const match of text.matchAll(pathRe)) raw.add(match[1].replace(/\\\//g, "/"));

  const evidence = new Map<string, AdapterEndpointEvidence>();
  for (const candidate of raw) {
    if (/^(?:data:|javascript:|mailto:|tel:)/i.test(candidate)) continue;
    if (/\.(?:png|jpe?g|gif|svg|ico|woff2?|ttf|css|m?js|map)(?:$|[?#])/i.test(candidate)) continue;
    let resolved: string;
    try {
      resolved = new URL(candidate, baseUrl).toString();
    } catch {
      continue;
    }
    if (/^(?:ajax\.googleapis\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)$/i.test(new URL(resolved).hostname)) continue;
    if (/(?:share[_-]?image|getlogofile|favicon|\/logos?(?:\/|$))/i.test(new URL(resolved).pathname)) continue;
    const signals = signalsFor(resolved);
    if (!signals.includes("jobs") && !signals.includes("api")) continue;
    const shape = urlShape(resolved);
    if (!evidence.has(shape)) evidence.set(shape, { shape, origin, signals });
    if (evidence.size >= MAX_ENDPOINTS) break;
  }
  return [...evidence.values()];
}

function scriptUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url = new URL(match[1], baseUrl);
      if (url.hostname !== new URL(baseUrl).hostname) continue;
      if (seen.has(url.toString())) continue;
      seen.add(url.toString());
      urls.push(url.toString());
    } catch {
      // Ignore malformed script references.
    }
  }
  return urls.slice(0, MAX_SCRIPTS);
}

function emptyEvidence(candidate: AdapterProfileCandidate): AdapterProfileEvidence {
  return {
    schemaVersion: ADAPTER_PROFILER_VERSION,
    sourceUrlShape: urlShape(candidate.sourceUrl),
    finalUrlShape: null,
    status: null,
    contentType: null,
    bodyBytes: 0,
    endpointEvidence: [],
    scriptShapesInspected: [],
    queryKeys: [],
    detectedSignals: [],
    fingerprint: crypto.createHash("sha256").update(candidate.suspectedAts).digest("hex"),
  };
}

export async function profileAdapterCandidate(
  candidate: AdapterProfileCandidate,
  options: { persist?: boolean; allowPrivateNetworksForTests?: boolean } = {}
): Promise<AdapterProfileResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const persist = options.persist ?? true;
  let evidence = emptyEvidence(candidate);
  let outcome: AdapterProfileOutcome = "FAILED_TEMPORARY";
  let errorCategory: string | null = null;
  let errorMessage: string | null = null;
  let sourceHost = "invalid-url";
  try {
    sourceHost = new URL(candidate.sourceUrl.replace(/&amp;|&#038;|&#x26;/gi, "&")).hostname;
    const page = await safeFetch(candidate.sourceUrl, {
      timeoutMs: 20_000,
      maxRedirects: 5,
      maxResponseBytes: 1_000_000,
      allowPrivateNetworksForTests: options.allowPrivateNetworksForTests,
      headers: { "User-Agent": "CareerOps-Adapter-Profiler/1.0", Accept: "text/html,application/json;q=0.9,*/*;q=0.5" },
    });
    let endpoints = extractEndpointShapes(page.bodyText, page.finalUrl, "page");
    const scriptsInspected: string[] = [];
    for (const scriptUrl of scriptUrls(page.bodyText, page.finalUrl)) {
      try {
        const script = await safeFetch(scriptUrl, {
          timeoutMs: 15_000,
          maxRedirects: 3,
          maxResponseBytes: 750_000,
          allowPrivateNetworksForTests: options.allowPrivateNetworksForTests,
          headers: { "User-Agent": "CareerOps-Adapter-Profiler/1.0", Accept: "application/javascript,text/javascript,*/*;q=0.5" },
        });
        scriptsInspected.push(urlShape(script.finalUrl));
        endpoints = [...endpoints, ...extractEndpointShapes(script.bodyText, page.finalUrl, "script")];
      } catch {
        // A script is optional evidence; the primary page result remains valid.
      }
    }
    const uniqueEndpoints = [...new Map(endpoints.map((item) => [item.shape, item])).values()].slice(0, MAX_ENDPOINTS);
    const finalUrl = new URL(page.finalUrl);
    const queryKeys = [...new Set([...finalUrl.searchParams.keys()])].sort();
    const detectedSignals = [...new Set(uniqueEndpoints.flatMap((item) => item.signals))].sort();
    const fingerprintInput = uniqueEndpoints.map((item) => `${item.shape}:${item.signals.join(",")}`).sort().join("\n");
    evidence = {
      schemaVersion: ADAPTER_PROFILER_VERSION,
      sourceUrlShape: urlShape(candidate.sourceUrl),
      finalUrlShape: urlShape(page.finalUrl),
      status: page.status,
      contentType: page.headers.get("content-type"),
      bodyBytes: Buffer.byteLength(page.bodyText),
      endpointEvidence: uniqueEndpoints,
      scriptShapesInspected: scriptsInspected,
      queryKeys,
      detectedSignals,
      fingerprint: crypto.createHash("sha256").update(`${candidate.suspectedAts}\n${fingerprintInput}`).digest("hex"),
    };
    const reachable = page.status >= 200 && page.status < 400 && page.bodyText.trim().length > 0;
    outcome = uniqueEndpoints.length > 0 && (detectedSignals.includes("api") || detectedSignals.includes("jobs"))
      ? "PUBLIC_ENDPOINT_EVIDENCE"
      : reachable ? "PAGE_REACHABLE" : "BLOCKED_OR_EMPTY";
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    errorCategory = error instanceof SafeFetchError ? error.reason : "unexpected_error";
    outcome = errorCategory === "invalid_url" || errorCategory === "disallowed_scheme" || errorCategory === "disallowed_host"
      ? "UNSAFE_URL" : "FAILED_TEMPORARY";
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startedMs;
  const apiEvidence = evidence.detectedSignals.includes("api");
  const paginationEvidence = evidence.detectedSignals.includes("pagination");
  const tenantEvidence = evidence.detectedSignals.includes("tenant") || evidence.queryKeys.some((key) =>
    /^(?:company|companyId|client|cid|tenant|site|careerSite|board|token)$/i.test(key)
  );
  const result: AdapterProfileResult = {
    jobSourceId: candidate.jobSourceId,
    organizationId: candidate.organizationId,
    canonicalName: candidate.canonicalName,
    suspectedAts: candidate.suspectedAts,
    sourceHost,
    outcome,
    endpointCandidates: evidence.endpointEvidence.length,
    apiEvidence,
    paginationEvidence,
    tenantEvidence,
    errorCategory,
    errorMessage,
    evidence,
    durationMs,
  };
  if (persist) {
    getDb().prepare(
      `INSERT INTO ats_adapter_profile_runs (
         job_source_id, organization_id, suspected_ats, profiler_version, outcome, source_host,
         final_url_shape, http_status, endpoint_candidates, api_evidence, pagination_evidence,
         tenant_evidence, evidence_json, error_category, error_message, started_at, finished_at, duration_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      candidate.jobSourceId, candidate.organizationId, candidate.suspectedAts,
      ADAPTER_PROFILER_VERSION, outcome, sourceHost, evidence.finalUrlShape, evidence.status,
      evidence.endpointEvidence.length, apiEvidence ? 1 : 0, paginationEvidence ? 1 : 0,
      tenantEvidence ? 1 : 0, JSON.stringify(evidence), errorCategory, errorMessage,
      startedAt, finishedAt, durationMs
    );
  }
  return result;
}

export async function runAdapterProfileBatch(options: {
  batchSize?: number;
  concurrency?: number;
  samplesPerProvider?: number;
  persist?: boolean;
  retryCompleted?: boolean;
  allowPrivateNetworksForTests?: boolean;
} = {}): Promise<AdapterProfileBatchSummary> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const candidates = listAdapterProfileCandidates({
    limit: options.batchSize,
    samplesPerProvider: options.samplesPerProvider,
    retryCompleted: options.retryCompleted,
  });
  const limit = pLimit(boundedInteger(options.concurrency ?? 1, 1, 2));
  const results = await Promise.all(candidates.map((candidate) => limit(() => profileAdapterCandidate(candidate, {
    persist: options.persist,
    allowPrivateNetworksForTests: options.allowPrivateNetworksForTests,
  }))));
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    attempted: results.length,
    publicEndpointEvidence: results.filter((row) => row.outcome === "PUBLIC_ENDPOINT_EVIDENCE").length,
    pageReachable: results.filter((row) => row.outcome === "PAGE_REACHABLE").length,
    blockedOrEmpty: results.filter((row) => row.outcome === "BLOCKED_OR_EMPTY").length,
    failedTemporary: results.filter((row) => row.outcome === "FAILED_TEMPORARY").length,
    unsafeUrl: results.filter((row) => row.outcome === "UNSAFE_URL").length,
    results,
  };
}
