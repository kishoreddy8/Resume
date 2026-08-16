import pLimit from "p-limit";
import { getDb } from "@/db";
import { fetchJobsForCompany } from "@/lib/normalize";
import { categorizeThrownError, isRetryableCategory } from "@/lib/scan/errors";
import type { Company, ErrorCategory } from "@/types";

export const CONNECTOR_HEALTH_CHECKER_VERSION = "careerops.connector-health.v1";
type SupportedProvider = "greenhouse" | "lever" | "ashby" | "workday" | "smartrecruiters" | "adp_wfn" | "adp_rm" | "eightfold" | "cornerstone" | "avature" | "paylocity" | "icims" | "ukg_pro" | "bamboohr" | "oracle_recruiting_cloud" | "workable" | "rippling" | "paycom" | "jazzhr" | "jobvite" | "breezy" | "teamtailor" | "applicantpro" | "pinpoint" | "clearcompany" | "personio" | "applicantstack" | "comeet" | "cats" | "gohire" | "newton" | "silkroad" | "jobdiva" | "taleo" | "phenom" | "successfactors";

export type ConnectorHealthOutcome = "HEALTHY_JOBS" | "HEALTHY_EMPTY" | "FAILED_TEMPORARY" | "FAILED_HARD";

export interface ConnectorHealthCandidate {
  jobSourceId: number;
  organizationId: number;
  companyId: number;
  canonicalName: string;
  provider: SupportedProvider;
  company: Company;
}

export interface ConnectorHealthResult {
  jobSourceId: number;
  organizationId: number;
  companyId: number;
  canonicalName: string;
  provider: SupportedProvider;
  outcome: ConnectorHealthOutcome;
  jobsSeen: number;
  sampleExternalId: string | null;
  sampleTitle: string | null;
  latencyMs: number;
  errorCategory: ErrorCategory | null;
  errorMessage: string | null;
}

export interface ConnectorHealthBatchSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  attempted: number;
  healthyJobs: number;
  healthyEmpty: number;
  failedTemporary: number;
  failedHard: number;
  results: ConnectorHealthResult[];
}

interface CandidateRow {
  job_source_id: number;
  organization_id: number;
  legacy_company_id: number;
  canonical_name: string;
  provider: SupportedProvider;
}

export function listConnectorHealthCandidates(
  limit = 10,
  options: { retryNow?: boolean; intervalHours?: number } = {}
): ConnectorHealthCandidate[] {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
  const intervalHours = Math.max(1, Math.min(Math.trunc(options.intervalHours ?? 24), 168));
  const eligibility = options.retryNow ? "" : `AND NOT EXISTS (
    SELECT 1 FROM connector_health_check_runs h
    WHERE h.job_source_id=js.id AND h.checker_version=?
      AND h.finished_at > datetime('now', '-' || ? || ' hours')
  )`;
  const db = getDb();
  const rows = db.prepare(
    `WITH eligible AS (
       SELECT js.id AS job_source_id, js.organization_id, js.legacy_company_id,
              o.canonical_name, js.provider,
              COALESCE((SELECT MAX(h.finished_at) FROM connector_health_check_runs h
                        WHERE h.job_source_id=js.id AND h.checker_version=?), '') AS last_check,
              ROW_NUMBER() OVER (PARTITION BY js.provider ORDER BY
                COALESCE((SELECT MAX(h2.finished_at) FROM connector_health_check_runs h2
                          WHERE h2.job_source_id=js.id AND h2.checker_version=?), ''), js.id) AS provider_rank
       FROM job_sources js
       JOIN organizations o ON o.id=js.organization_id
       JOIN companies c ON c.id=js.legacy_company_id
       WHERE js.is_active=1 AND js.is_authoritative=1 AND js.resolution_status='VERIFIED'
         AND js.review_status='APPROVED'
         AND js.provider IN ('greenhouse','lever','ashby','workday','smartrecruiters','adp_wfn','adp_rm','eightfold','cornerstone','avature','paylocity','icims','ukg_pro','bamboohr','oracle_recruiting_cloud','workable','rippling','paycom','jazzhr','jobvite','breezy','teamtailor','applicantpro','pinpoint','clearcompany','personio','applicantstack','comeet','cats','gohire','newton','silkroad','jobdiva','taleo','phenom','successfactors')
         AND c.is_active=1 ${eligibility}
     )
     SELECT job_source_id, organization_id, legacy_company_id, canonical_name, provider
     FROM eligible
     ORDER BY provider_rank, last_check, provider, job_source_id
     LIMIT ?`
  ).all(...(options.retryNow
    ? [CONNECTOR_HEALTH_CHECKER_VERSION, CONNECTOR_HEALTH_CHECKER_VERSION, boundedLimit]
    : [CONNECTOR_HEALTH_CHECKER_VERSION, CONNECTOR_HEALTH_CHECKER_VERSION,
       CONNECTOR_HEALTH_CHECKER_VERSION, intervalHours, boundedLimit])) as CandidateRow[];
  const getCompany = db.prepare("SELECT * FROM companies WHERE id=?");
  return rows.map((row) => ({
    jobSourceId: row.job_source_id,
    organizationId: row.organization_id,
    companyId: row.legacy_company_id,
    canonicalName: row.canonical_name,
    provider: row.provider,
    company: getCompany.get(row.legacy_company_id) as Company,
  }));
}

export async function checkConnectorHealth(
  candidate: ConnectorHealthCandidate,
  options: { persist?: boolean; fetcher?: typeof fetchJobsForCompany } = {}
): Promise<ConnectorHealthResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let jobsSeen = 0;
  let sampleExternalId: string | null = null;
  let sampleTitle: string | null = null;
  let outcome: ConnectorHealthOutcome;
  let errorCategory: ErrorCategory | null = null;
  let errorMessage: string | null = null;
  try {
    const jobs = await (options.fetcher ?? fetchJobsForCompany)(candidate.company, {
      maxJobs: 1,
      usOnly: false,
      maxAttempts: 2,
      timeoutMs: 15_000,
    });
    jobsSeen = jobs.length;
    sampleExternalId = jobs[0]?.externalId?.trim() || null;
    sampleTitle = jobs[0]?.title?.trim() || null;
    outcome = jobs.length > 0 ? "HEALTHY_JOBS" : "HEALTHY_EMPTY";
  } catch (error) {
    errorCategory = categorizeThrownError(error);
    errorMessage = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
    outcome = isRetryableCategory(errorCategory) ? "FAILED_TEMPORARY" : "FAILED_HARD";
  }
  const finishedAt = new Date().toISOString();
  const latencyMs = Date.now() - startedMs;
  const result: ConnectorHealthResult = {
    jobSourceId: candidate.jobSourceId,
    organizationId: candidate.organizationId,
    companyId: candidate.companyId,
    canonicalName: candidate.canonicalName,
    provider: candidate.provider,
    outcome,
    jobsSeen,
    sampleExternalId,
    sampleTitle,
    latencyMs,
    errorCategory,
    errorMessage,
  };
  if (options.persist ?? true) {
    getDb().prepare(
      `INSERT INTO connector_health_check_runs (
         job_source_id, organization_id, company_id, provider, checker_version, outcome,
         jobs_seen, sample_external_id, sample_title, latency_ms, error_category, error_message,
         evidence_json, started_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      candidate.jobSourceId, candidate.organizationId, candidate.companyId, candidate.provider,
      CONNECTOR_HEALTH_CHECKER_VERSION, outcome, jobsSeen, sampleExternalId, sampleTitle,
      latencyMs, errorCategory, errorMessage,
      JSON.stringify({ schema: CONNECTOR_HEALTH_CHECKER_VERSION, readOnly: true, maxJobs: 1,
        productionJobsMutated: false, approvalMutated: false }), startedAt, finishedAt
    );
  }
  return result;
}

export async function runConnectorHealthBatch(options: {
  batchSize?: number;
  concurrency?: number;
  persist?: boolean;
  retryNow?: boolean;
  intervalHours?: number;
} = {}): Promise<ConnectorHealthBatchSummary> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const candidates = listConnectorHealthCandidates(options.batchSize ?? 10, {
    retryNow: options.retryNow,
    intervalHours: options.intervalHours,
  });
  const limit = pLimit(Math.max(1, Math.min(Math.trunc(options.concurrency ?? 2), 2)));
  const results = await Promise.all(candidates.map((candidate) => limit(() => checkConnectorHealth(candidate, {
    persist: options.persist,
  }))));
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    attempted: results.length,
    healthyJobs: results.filter((row) => row.outcome === "HEALTHY_JOBS").length,
    healthyEmpty: results.filter((row) => row.outcome === "HEALTHY_EMPTY").length,
    failedTemporary: results.filter((row) => row.outcome === "FAILED_TEMPORARY").length,
    failedHard: results.filter((row) => row.outcome === "FAILED_HARD").length,
    results,
  };
}
