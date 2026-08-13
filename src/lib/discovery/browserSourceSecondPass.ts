import pLimit from "p-limit";
import { getDb } from "@/db";
import { recordDiscoveryResult } from "@/db/queries/companies";
import { discoverCompanySourceBrowser } from "@/lib/ats/discoveryBrowser";
import type { DiscoveryResult } from "@/lib/ats/discovery";
import type { Company } from "@/types";

const PASS_TYPE = "browser_v1";

export interface BrowserSourceCandidate {
  organizationId: number;
  companyId: number;
  canonicalName: string;
  domain: string;
  inputUrl: string;
  priorStatus: string | null;
  company: Company;
}

export interface BrowserSourceAttemptResult {
  organizationId: number;
  companyId: number;
  canonicalName: string;
  priorStatus: string | null;
  resultStatus: string;
  provider: string | null;
  sourceKey: string | null;
  sourceUrl: string | null;
  reason: string;
  error: string | null;
  durationMs: number;
}

export interface BrowserSourceBatchSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  attempted: number;
  verified: number;
  needsAdapter: number;
  generic: number;
  unresolved: number;
  failedTemporary: number;
  conflicts: number;
  results: BrowserSourceAttemptResult[];
}

interface CandidateRow {
  organization_id: number;
  resolved_company_id: number;
  canonical_name: string;
  domain: string;
  input_url: string;
  prior_status: string | null;
}

export function listBrowserSourceCandidates(
  limit = 50,
  options: { retryCompleted?: boolean } = {}
): BrowserSourceCandidate[] {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 250));
  const retryClause = options.retryCompleted
    ? ""
    : `AND NOT EXISTS (
         SELECT 1 FROM organization_source_discovery_attempts a
         WHERE a.organization_id = s.organization_id AND a.pass_type = '${PASS_TYPE}'
           AND (a.result_status <> 'FAILED_TEMPORARY' OR a.finished_at > datetime('now', '-1 day'))
       )`;
  const db = getDb();
  const rows = db.prepare(
    `SELECT s.organization_id, s.resolved_company_id, o.canonical_name, s.domain,
            COALESCE(NULLIF(s.discovered_jobs_url, ''), 'https://' || s.domain || '/') AS input_url,
            s.source_resolution_status AS prior_status
     FROM organization_discovery_state s
     JOIN organizations o ON o.id = s.organization_id
     JOIN companies c ON c.id = s.resolved_company_id
     WHERE s.domain_identity_status = 'VERIFIED' AND s.domain IS NOT NULL
       AND s.resolved_company_id IS NOT NULL AND c.is_active = 1
       AND COALESCE(s.source_resolution_status, 'NO_SOURCE_RESULT') IN (
         'GENERIC_SUPPORTED', 'UNRESOLVED', 'NO_SOURCE_RESULT', 'FAILED_TEMPORARY'
       )
       ${retryClause}
     ORDER BY CASE COALESCE(s.source_resolution_status, 'NO_SOURCE_RESULT')
                WHEN 'GENERIC_SUPPORTED' THEN 0 WHEN 'UNRESOLVED' THEN 1
                WHEN 'NO_SOURCE_RESULT' THEN 2 ELSE 3 END,
              s.organization_id
     LIMIT ?`
  ).all(boundedLimit) as CandidateRow[];
  const companyStatement = db.prepare("SELECT * FROM companies WHERE id = ?");
  return rows.map((row) => ({
    organizationId: row.organization_id,
    companyId: row.resolved_company_id,
    canonicalName: row.canonical_name,
    domain: row.domain,
    inputUrl: row.input_url,
    priorStatus: row.prior_status,
    company: companyStatement.get(row.resolved_company_id) as Company,
  }));
}

function connectorConflict(organizationId: number, result: DiscoveryResult): string | null {
  if (result.status !== "VERIFIED" || !result.sourceType || !result.atsBoardToken) return null;
  const row = getDb().prepare(
    `SELECT organization_id FROM job_sources
     WHERE organization_id <> ? AND (
       (provider = ? AND source_key = ?) OR (? IS NOT NULL AND source_url = ?)
     ) LIMIT 1`
  ).get(
    organizationId,
    result.sourceType,
    result.atsBoardToken,
    result.discoveredJobsUrl,
    result.discoveredJobsUrl
  ) as { organization_id: number } | undefined;
  return row ? `Connector identity already belongs to organization ${row.organization_id}` : null;
}

function conflictResult(result: DiscoveryResult, reason: string): DiscoveryResult {
  return {
    status: "NEEDS_ADAPTER",
    sourceType: null,
    atsBoardToken: null,
    discoveredJobsUrl: result.discoveredJobsUrl,
    reason: `Connector identity conflict: ${reason}`,
    suspectedAts: "connector_identity_conflict",
  };
}

function persistAttempt(
  candidate: BrowserSourceCandidate,
  result: DiscoveryResult,
  startedAt: string,
  finishedAt: string,
  durationMs: number,
  errorMessage: string | null
): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO organization_source_discovery_attempts (
         organization_id, company_id, pass_type, input_url, prior_status, result_status,
         provider, source_key, source_url, suspected_ats, reason, error_message,
         started_at, finished_at, duration_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      candidate.organizationId,
      candidate.companyId,
      PASS_TYPE,
      candidate.inputUrl,
      candidate.priorStatus,
      result.status,
      result.sourceType,
      result.atsBoardToken,
      result.discoveredJobsUrl,
      result.suspectedAts,
      result.reason,
      errorMessage,
      startedAt,
      finishedAt,
      durationMs
    );

    // Never downgrade a useful generic first-pass result to browser UNRESOLVED. All other browser
    // outcomes are at least as informative and become the current source-discovery state.
    if (!(candidate.priorStatus === "GENERIC_SUPPORTED" && result.status === "UNRESOLVED")) {
      db.prepare(
        `UPDATE organization_discovery_state
         SET source_resolution_status = ?, discovered_jobs_url = COALESCE(?, discovered_jobs_url),
             updated_at = datetime('now')
         WHERE organization_id = ?`
      ).run(result.status, result.discoveredJobsUrl, candidate.organizationId);
    }
  })();
}

export async function discoverBrowserSourceCandidate(
  candidate: BrowserSourceCandidate,
  options: {
    persist?: boolean;
    discoverer?: typeof discoverCompanySourceBrowser;
  } = {}
): Promise<BrowserSourceAttemptResult> {
  const persist = options.persist ?? true;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let error: string | null = null;
  let result: DiscoveryResult;

  try {
    result = await (options.discoverer ?? discoverCompanySourceBrowser)(candidate.inputUrl);
    const conflict = connectorConflict(candidate.organizationId, result);
    if (conflict) result = conflictResult(result, conflict);

    if (persist && result.status !== "UNRESOLVED") {
      try {
        recordDiscoveryResult(candidate.companyId, result);
      } catch (caught) {
        if (!/UNIQUE constraint failed/.test(caught instanceof Error ? caught.message : String(caught))) throw caught;
        result = conflictResult(result, caught instanceof Error ? caught.message : String(caught));
        recordDiscoveryResult(candidate.companyId, result);
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    result = {
      status: "FAILED_TEMPORARY",
      sourceType: null,
      atsBoardToken: null,
      discoveredJobsUrl: null,
      reason: `Browser source discovery failed: ${error}`,
      suspectedAts: null,
    };
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startedMs;
  if (persist) persistAttempt(candidate, result, startedAt, finishedAt, durationMs, error);
  return {
    organizationId: candidate.organizationId,
    companyId: candidate.companyId,
    canonicalName: candidate.canonicalName,
    priorStatus: candidate.priorStatus,
    resultStatus: result.status,
    provider: result.sourceType,
    sourceKey: result.atsBoardToken,
    sourceUrl: result.discoveredJobsUrl,
    reason: result.reason,
    error,
    durationMs,
  };
}

export async function runBrowserSourceSecondPassBatch(options: {
  batchSize?: number;
  concurrency?: number;
  persist?: boolean;
  retryCompleted?: boolean;
} = {}): Promise<BrowserSourceBatchSummary> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const candidates = listBrowserSourceCandidates(options.batchSize ?? 50, {
    retryCompleted: options.retryCompleted,
  });
  const limit = pLimit(Math.max(1, Math.min(Math.trunc(options.concurrency ?? 1), 2)));
  const results = await Promise.all(candidates.map((candidate) => limit(() =>
    discoverBrowserSourceCandidate(candidate, { persist: options.persist })
  )));
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    attempted: results.length,
    verified: results.filter((row) => row.resultStatus === "VERIFIED").length,
    needsAdapter: results.filter((row) => row.resultStatus === "NEEDS_ADAPTER").length,
    generic: results.filter((row) => row.resultStatus === "GENERIC_SUPPORTED").length,
    unresolved: results.filter((row) => row.resultStatus === "UNRESOLVED").length,
    failedTemporary: results.filter((row) => row.resultStatus === "FAILED_TEMPORARY").length,
    conflicts: results.filter((row) => row.reason.startsWith("Connector identity conflict:")).length,
    results,
  };
}
