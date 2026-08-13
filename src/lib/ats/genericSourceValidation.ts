import pLimit from "p-limit";
import { getDb } from "@/db";
import { recordSourceValidation, type SourceValidationOutcome } from "@/db/queries/jobSourceValidation";
import { recordPendingJobSourceValidation, reviewJobSource } from "@/db/queries/organizationRegistry";
import { scrapeCareerPageDetailed, type ScrapeResult } from "@/lib/ats/genericPlaywright";
import { classifyJobLocation } from "@/lib/jobLocationScope";
import { categorizeThrownError, isRetryableCategory } from "@/lib/scan/errors";
import type { ErrorCategory, NormalizedJob } from "@/types";

export const GENERIC_VALIDATOR_VERSION = "generic-source-validator.v1";

export interface GenericSourceCandidate {
  jobSourceId: number;
  organizationId: number;
  companyId: number;
  canonicalName: string;
  sourceUrl: string;
  verifiedDomain: string;
}

export interface GenericSourceValidationResult {
  validationRunId: number | null;
  jobSourceId: number;
  organizationId: number;
  canonicalName: string;
  outcome: SourceValidationOutcome;
  extractorType: ScrapeResult["extractorType"] | null;
  jobsSeen: number;
  usJobsSeen: number;
  samplesSaved: number;
  canIngest: boolean;
  canCloseMissing: false;
  reason: string;
  errorCategory: ErrorCategory | null;
}

interface CandidateRow {
  job_source_id: number;
  organization_id: number;
  company_id: number;
  canonical_name: string;
  source_url: string;
  verified_domain: string;
}

export function listGenericSourceValidationCandidates(
  limit = 25,
  options: { retryNow?: boolean } = {}
): GenericSourceCandidate[] {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
  const retryClause = options.retryNow
    ? ""
    : `AND NOT EXISTS (
         SELECT 1 FROM job_source_validation_runs vr
         WHERE vr.job_source_id = js.id
           AND vr.validation_kind = 'GENERIC_CAREER_PAGE'
           AND vr.connector_version = ?
           AND vr.finished_at > datetime('now', '-7 days')
       )`;
  const params: unknown[] = [];
  if (!options.retryNow) params.push(GENERIC_VALIDATOR_VERSION);
  params.push(boundedLimit);
  const rows = getDb().prepare(
    `SELECT js.id AS job_source_id, js.organization_id, js.legacy_company_id AS company_id,
            o.canonical_name, js.source_url, c.verified_domain
     FROM job_sources js
     JOIN organizations o ON o.id = js.organization_id
     JOIN companies c ON c.id = js.legacy_company_id
     WHERE js.is_active = 1
       AND js.provider = 'career_link'
       AND js.resolution_status = 'GENERIC_SUPPORTED'
       AND js.review_status = 'PENDING'
       AND js.source_url IS NOT NULL
       AND c.domain_identity_status = 'VERIFIED'
       AND c.verified_domain IS NOT NULL
       ${retryClause}
     ORDER BY COALESCE(js.last_validated_at, '') ASC, js.id ASC
     LIMIT ?`
  ).all(...params) as CandidateRow[];
  return rows.map((row) => ({
    jobSourceId: row.job_source_id,
    organizationId: row.organization_id,
    companyId: row.company_id,
    canonicalName: row.canonical_name,
    sourceUrl: row.source_url,
    verifiedDomain: row.verified_domain,
  }));
}

function validateGenericSample(job: NormalizedJob): string | null {
  if (!job.title.trim()) return "Job title is empty";
  if (classifyJobLocation(job.location) !== "US") return "Job lacks explicit U.S. location evidence";
  try {
    const url = new URL(job.url);
    if (url.protocol !== "https:") return "Job URL is not HTTPS";
  } catch {
    return "Job URL is invalid";
  }
  return null;
}

export async function validateGenericSource(
  candidate: GenericSourceCandidate,
  options: {
    sampleSize?: number;
    persist?: boolean;
    scraper?: typeof scrapeCareerPageDetailed;
  } = {}
): Promise<GenericSourceValidationResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const sampleSize = Math.max(1, Math.min(Math.trunc(options.sampleSize ?? 3), 3));
  const persist = options.persist ?? true;
  let outcome: SourceValidationOutcome = "PENDING";
  let extractorType: ScrapeResult["extractorType"] | null = null;
  let jobsSeen = 0;
  let usJobsSeen = 0;
  let samples: NormalizedJob[] = [];
  let reason = "";
  let errorCategory: ErrorCategory | null = null;
  let detectedAts: ScrapeResult["detectedAts"] | undefined;

  try {
    const result = await (options.scraper ?? scrapeCareerPageDetailed)(candidate.sourceUrl);
    extractorType = result.extractorType;
    detectedAts = result.detectedAts;
    jobsSeen = result.jobs.length;
    const usJobs = result.jobs.filter((job) => classifyJobLocation(job.location) === "US");
    usJobsSeen = usJobs.length;
    samples = usJobs.filter((job) => validateGenericSample(job) === null).slice(0, sampleSize);

    if (detectedAts) {
      outcome = "NEEDS_ADAPTER";
      reason = `Embedded supported ATS detected (${detectedAts.source}:${detectedAts.token}); convert and validate the structured source instead of approving the generic page`;
      samples = [];
    } else if (samples.length > 0) {
      outcome = "READY_ADDITIVE";
      reason = `Validated ${samples.length} explicit U.S. job sample${samples.length === 1 ? "" : "s"}; generic source may add/update jobs but can never close missing jobs`;
    } else if (jobsSeen > 0) {
      outcome = "NO_US_JOBS";
      reason = "Job candidates were found, but none had sufficient explicit U.S. location evidence";
    } else {
      outcome = "PENDING";
      reason = "No positively identified job postings were found on the rendered career page";
    }
  } catch (error) {
    errorCategory = categorizeThrownError(error);
    outcome = isRetryableCategory(errorCategory) ? "FAILED_TEMPORARY" : "REJECTED";
    reason = error instanceof Error ? error.message : String(error);
  }

  const canIngest = outcome === "READY_ADDITIVE";
  const finishedAt = new Date().toISOString();
  const evidence = {
    schema: "careerops.source-validation.v1",
    connectorVersion: GENERIC_VALIDATOR_VERSION,
    canonicalName: candidate.canonicalName,
    organizationId: candidate.organizationId,
    verifiedDomain: candidate.verifiedDomain,
    sourceUrl: candidate.sourceUrl,
    extractorType,
    detectedAts: detectedAts ?? null,
    outcome,
    reason,
    productionLoadScope: "US_ONLY",
    canIngest,
    canCloseMissing: false,
    paginationVerified: false,
    completenessVerified: false,
    jobsSeen,
    usJobsSeen,
    samples: samples.map((job) => ({
      externalId: job.externalId,
      title: job.title,
      location: job.location,
      url: job.url,
      descriptionPresent: Boolean(job.descriptionText || job.descriptionHtml),
      postedAt: job.postedAt,
    })),
    errorCategory,
  };

  let validationRunId: number | null = null;
  if (persist) {
    validationRunId = recordSourceValidation({
      jobSourceId: candidate.jobSourceId,
      validationKind: "GENERIC_CAREER_PAGE",
      connectorVersion: GENERIC_VALIDATOR_VERSION,
      outcome,
      extractorType,
      validationScope: samples.length > 0 ? "US" : null,
      sampleLimit: sampleSize,
      jobsSeen,
      usJobsSeen,
      paginationVerified: false,
      completenessVerified: false,
      canIngest,
      canCloseMissing: false,
      errorCategory,
      reason,
      evidence,
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs,
      samples,
    });
    const evidenceJson = JSON.stringify(evidence);
    if (outcome === "READY_ADDITIVE") reviewJobSource(candidate.jobSourceId, "APPROVED", evidenceJson);
    else if (outcome === "REJECTED") reviewJobSource(candidate.jobSourceId, "REJECTED", evidenceJson);
    else recordPendingJobSourceValidation(candidate.jobSourceId, evidenceJson);
  }

  return {
    validationRunId,
    jobSourceId: candidate.jobSourceId,
    organizationId: candidate.organizationId,
    canonicalName: candidate.canonicalName,
    outcome,
    extractorType,
    jobsSeen,
    usJobsSeen,
    samplesSaved: samples.length,
    canIngest,
    canCloseMissing: false,
    reason,
    errorCategory,
  };
}

export async function runGenericSourceValidationBatch(options: {
  batchSize?: number;
  sampleSize?: number;
  concurrency?: number;
  persist?: boolean;
  retryNow?: boolean;
} = {}) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const candidates = listGenericSourceValidationCandidates(options.batchSize ?? 25, {
    retryNow: options.retryNow,
  });
  const limit = pLimit(Math.max(1, Math.min(Math.trunc(options.concurrency ?? 1), 2)));
  const results = await Promise.all(candidates.map((candidate) => limit(() =>
    validateGenericSource(candidate, {
      sampleSize: options.sampleSize,
      persist: options.persist,
    })
  )));
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    attempted: results.length,
    readyAdditive: results.filter((row) => row.outcome === "READY_ADDITIVE").length,
    needsAdapter: results.filter((row) => row.outcome === "NEEDS_ADAPTER").length,
    noUsJobs: results.filter((row) => row.outcome === "NO_US_JOBS").length,
    pending: results.filter((row) => row.outcome === "PENDING").length,
    failedTemporary: results.filter((row) => row.outcome === "FAILED_TEMPORARY").length,
    rejected: results.filter((row) => row.outcome === "REJECTED").length,
    results,
  };
}
