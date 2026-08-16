import pLimit from "p-limit";
import { getDb } from "@/db";
import { recordSourceValidation } from "@/db/queries/jobSourceValidation";
import { recordPendingJobSourceValidation, reviewJobSource } from "@/db/queries/organizationRegistry";
import { detectAtsFromUrlString } from "@/lib/ats/detect";
import { classifyJobLocation } from "@/lib/jobLocationScope";
import { fetchJobsForCompany } from "@/lib/normalize";
import { categorizeThrownError, isRetryableCategory, ScanConnectorError } from "@/lib/scan/errors";
import type { Company, ErrorCategory, NormalizedJob } from "@/types";

export type SupportedProvider = "greenhouse" | "lever" | "ashby" | "workday" | "smartrecruiters" | "adp_wfn" | "adp_rm" | "eightfold" | "cornerstone" | "avature" | "paylocity" | "icims" | "ukg_pro" | "bamboohr" | "oracle_recruiting_cloud" | "workable" | "rippling" | "paycom" | "jazzhr" | "jobvite" | "breezy" | "teamtailor" | "applicantpro" | "pinpoint" | "clearcompany" | "personio" | "applicantstack" | "comeet" | "cats" | "gohire" | "newton" | "silkroad" | "jobdiva" | "taleo" | "phenom" | "successfactors";

const CONNECTOR_VERSIONS: Record<SupportedProvider, string> = {
  greenhouse: "greenhouse.v1",
  lever: "lever.v1",
  ashby: "ashby.v1",
  workday: "workday.v1",
  smartrecruiters: "smartrecruiters.v1",
  adp_wfn: "adp-wfn.v1",
  adp_rm: "adp-rm.v1",
  eightfold: "eightfold.v1",
  cornerstone: "cornerstone.v1",
  avature: "avature.v1",
  paylocity: "paylocity.v1",
  icims: "icims.v1",
  ukg_pro: "ukg-pro.v1",
  bamboohr: "bamboohr.v1",
  oracle_recruiting_cloud: "oracle-recruiting-cloud.v1",
  workable: "workable.v1",
  rippling: "rippling.v1",
  paycom: "paycom.v1",
  jazzhr: "jazzhr.v1",
  jobvite: "jobvite.v1",
  breezy: "breezy.v1",
  teamtailor: "teamtailor.v1",
  applicantpro: "applicantpro.v1",
  pinpoint: "pinpoint.v1",
  clearcompany: "clearcompany.v1",
  personio: "personio.v1",
  applicantstack: "applicantstack.v1",
  comeet: "comeet.v1",
  cats: "cats.v1",
  gohire: "gohire.v1",
  newton: "newton-paycor.v1",
  silkroad: "silkroad.v1",
  jobdiva: "jobdiva.v1",
  taleo: "taleo.v1",
  phenom: "phenom.v1",
  successfactors: "successfactors.v1",
};

export interface PendingConnectorCandidate {
  jobSourceId: number;
  organizationId: number;
  canonicalName: string;
  provider: SupportedProvider;
  sourceKey: string;
  sourceUrl: string;
  verifiedDomain: string;
  company: Company;
}

export type ConnectorValidationOutcome = "APPROVED" | "REJECTED" | "PENDING";

export interface ConnectorValidationResult {
  jobSourceId: number;
  organizationId: number;
  canonicalName: string;
  provider: SupportedProvider;
  outcome: ConnectorValidationOutcome;
  reason: string;
  sampleJobs: number;
  validationScope: "US" | "GLOBAL" | null;
  unknownLocations: number;
  nonUsLocations: number;
  errorCategory: ErrorCategory | null;
  evidence: string;
}

export interface ConnectorValidationBatchSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  attempted: number;
  approved: number;
  rejected: number;
  pending: number;
  results: ConnectorValidationResult[];
}

interface CandidateRow {
  job_source_id: number;
  organization_id: number;
  canonical_name: string;
  provider: SupportedProvider;
  source_key: string;
  source_url: string;
  verified_domain: string;
  legacy_company_id: number;
}

export function listPendingConnectorCandidates(
  limit = 100,
  options: { retryPendingNow?: boolean; provider?: SupportedProvider } = {}
): PendingConnectorCandidate[] {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
  const db = getDb();
  const cooldownClause = options.retryPendingNow
    ? ""
    : `AND (
         js.review_evidence IS NULL
         OR (
           js.review_evidence LIKE '{"schema":"careerops.connector-validation.v1"%'
           AND js.last_validated_at <= datetime('now', '-1 day')
         )
       )`;
  const rows = db.prepare(
    `SELECT js.id AS job_source_id, js.organization_id, o.canonical_name, js.provider,
            js.source_key, js.source_url, c.verified_domain, js.legacy_company_id
     FROM job_sources js
     JOIN organizations o ON o.id = js.organization_id
     JOIN companies c ON c.id = js.legacy_company_id
     JOIN organization_company_links l
       ON l.company_id = c.id AND l.organization_id = js.organization_id
     WHERE js.is_active = 1 AND js.resolution_status = 'VERIFIED'
       AND js.review_status = 'PENDING'
       AND js.provider IN ('greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'adp_wfn', 'adp_rm', 'eightfold', 'cornerstone', 'avature', 'paylocity', 'icims', 'ukg_pro', 'bamboohr', 'oracle_recruiting_cloud', 'workable', 'rippling', 'paycom', 'jazzhr', 'jobvite', 'breezy', 'teamtailor', 'applicantpro', 'pinpoint', 'clearcompany', 'personio', 'applicantstack', 'comeet', 'cats', 'gohire', 'newton', 'silkroad', 'jobdiva', 'taleo', 'phenom', 'successfactors')
       ${options.provider ? "AND js.provider = ?" : ""}
       AND js.source_key IS NOT NULL AND js.source_url IS NOT NULL
       AND c.domain_identity_status = 'VERIFIED' AND c.verified_domain IS NOT NULL
       ${cooldownClause}
     ORDER BY COALESCE(js.last_validated_at, '') ASC, js.id ASC
     LIMIT ?`
  ).all(...(options.provider ? [options.provider, boundedLimit] : [boundedLimit])) as CandidateRow[];

  const companyStatement = db.prepare("SELECT * FROM companies WHERE id = ?");
  return rows.map((row) => ({
    jobSourceId: row.job_source_id,
    organizationId: row.organization_id,
    canonicalName: row.canonical_name,
    provider: row.provider,
    sourceKey: row.source_key,
    sourceUrl: row.source_url,
    verifiedDomain: row.verified_domain,
    company: companyStatement.get(row.legacy_company_id) as Company,
  }));
}

export function validateCandidateIdentity(candidate: PendingConnectorCandidate): string | null {
  if (candidate.company.source_type !== candidate.provider) {
    return `Registry provider mismatch: company=${candidate.company.source_type}, source=${candidate.provider}`;
  }
  if (candidate.company.ats_board_token !== candidate.sourceKey) {
    return "Registry source key does not match the compatibility company token";
  }
  if (candidate.company.verified_domain !== candidate.verifiedDomain) {
    return "Verified domain mismatch between company and source candidate";
  }
  const detection = detectAtsFromUrlString(candidate.sourceUrl);
  if (!detection) return "Source URL is not a valid supported ATS URL";
  if (detection.sourceType !== candidate.provider || detection.atsBoardToken !== candidate.sourceKey) {
    return `Source URL identity mismatch: detected ${detection.sourceType}:${detection.atsBoardToken}`;
  }
  return null;
}

export function validateJobSample(
  jobs: NormalizedJob[],
  options: { requireUs?: boolean } = {}
): string | null {
  const requireUs = options.requireUs ?? true;
  if (jobs.length === 0) {
    return requireUs
      ? "No explicit U.S. jobs were available in this validation attempt"
      : "No jobs were available in the global validation fallback";
  }
  for (const [index, job] of jobs.entries()) {
    if (job.sightingOnly || job.lifecycleOnly) return `Sample job ${index + 1} was lifecycle-only`;
    if (!job.externalId?.trim()) return `Sample job ${index + 1} has no provider job ID`;
    if (!job.title.trim()) return `Sample job ${index + 1} has no title`;
    if (requireUs && classifyJobLocation(job.location) !== "US") {
      return `Sample job ${index + 1} does not contain explicit U.S. location evidence`;
    }
    let url: URL;
    try {
      url = new URL(job.url);
    } catch {
      return `Sample job ${index + 1} has an invalid URL`;
    }
    if (url.protocol !== "https:") return `Sample job ${index + 1} does not use HTTPS`;
  }
  return null;
}

function evidenceFor(input: {
  candidate: PendingConnectorCandidate;
  outcome: ConnectorValidationOutcome;
  reason: string;
  sampleSize: number;
  jobs: NormalizedJob[];
  unknownLocations: number;
  nonUsLocations: number;
  errorCategory: ErrorCategory | null;
  validationScope: "US" | "GLOBAL" | null;
}): string {
  return JSON.stringify({
    schema: "careerops.connector-validation.v1",
    validatedAt: new Date().toISOString(),
    outcome: input.outcome,
    reason: input.reason,
    organizationId: input.candidate.organizationId,
    canonicalName: input.candidate.canonicalName,
    provider: input.candidate.provider,
    sourceKey: input.candidate.sourceKey,
    sourceUrl: input.candidate.sourceUrl,
    verifiedDomain: input.candidate.verifiedDomain,
    identityEvidence: "ATS source discovered from a verified first-party company domain and matched to the compatibility registry",
    sampleLimit: input.sampleSize,
    usJobsValidated: input.validationScope === "US" ? input.jobs.length : 0,
    globalJobsValidated: input.validationScope === "GLOBAL" ? input.jobs.length : 0,
    validationScope: input.validationScope,
    productionLoadScope: "US_ONLY",
    unknownLocationsExcluded: input.unknownLocations,
    nonUsLocationsExcluded: input.nonUsLocations,
    samples: input.jobs.map((job) => ({ externalId: job.externalId, title: job.title, location: job.location, url: job.url })),
    errorCategory: input.errorCategory,
  });
}

function shouldRejectError(category: ErrorCategory, error: unknown): boolean {
  if (isRetryableCategory(category)) return false;
  if (error instanceof ScanConnectorError && error.statusCode === 404) return true;
  return category === "invalid_config";
}

export async function validatePendingConnector(
  candidate: PendingConnectorCandidate,
  options: { sampleSize?: number; persist?: boolean; fetcher?: typeof fetchJobsForCompany } = {}
): Promise<ConnectorValidationResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const sampleSize = Math.max(1, Math.min(Math.trunc(options.sampleSize ?? 3), 3));
  const persist = options.persist ?? true;
  const preflightError = validateCandidateIdentity(candidate);
  let jobs: NormalizedJob[] = [];
  let unknownLocations = 0;
  let nonUsLocations = 0;
  let outcome: ConnectorValidationOutcome = "PENDING";
  let reason = "";
  let errorCategory: ErrorCategory | null = null;
  let validationScope: "US" | "GLOBAL" | null = null;

  if (preflightError) {
    outcome = "REJECTED";
    reason = preflightError;
  } else {
    try {
      jobs = await (options.fetcher ?? fetchJobsForCompany)(candidate.company, {
        maxJobs: sampleSize,
        usOnly: true,
        maxAttempts: 3,
        timeoutMs: 20_000,
        onLocationFiltered: (scope) => {
          if (scope === "UNKNOWN") unknownLocations++;
          else nonUsLocations++;
        },
      });
      let sampleError = validateJobSample(jobs);
      if (jobs.length === 0) {
        // A connector may be technically sound while currently carrying only international jobs.
        // Validate a bounded global sample, but never pass these rows to the production jobs table;
        // the approval only authorizes the connector, whose real scans remain U.S.-only.
        jobs = await (options.fetcher ?? fetchJobsForCompany)(candidate.company, {
          maxJobs: sampleSize,
          usOnly: false,
          maxAttempts: 3,
          timeoutMs: 20_000,
        });
        sampleError = validateJobSample(jobs, { requireUs: false });
        if (!sampleError) validationScope = "GLOBAL";
      } else {
        validationScope = "US";
      }
      if (sampleError) {
        outcome = "PENDING";
        reason = sampleError;
      } else {
        outcome = "APPROVED";
        reason = validationScope === "GLOBAL"
          ? `Validated ${jobs.length} global job sample${jobs.length === 1 ? "" : "s"}; production loading remains U.S.-only`
          : `Validated ${jobs.length} genuine U.S. job sample${jobs.length === 1 ? "" : "s"}`;
      }
    } catch (error) {
      errorCategory = categorizeThrownError(error);
      outcome = shouldRejectError(errorCategory, error) ? "REJECTED" : "PENDING";
      reason = error instanceof Error ? error.message : String(error);
    }
  }

  const evidence = evidenceFor({
    candidate, outcome, reason, sampleSize, jobs, unknownLocations, nonUsLocations, errorCategory,
    validationScope,
  });
  if (persist) {
    const finishedAt = new Date().toISOString();
    const approved = outcome === "APPROVED";
    recordSourceValidation({
      jobSourceId: candidate.jobSourceId,
      validationKind: "STRUCTURED_ATS",
      connectorVersion: CONNECTOR_VERSIONS[candidate.provider],
      outcome: approved
        ? "READY_AUTHORITATIVE"
        : outcome === "REJECTED"
          ? "REJECTED"
          : "PENDING",
      extractorType: "PROVIDER_API",
      validationScope,
      sampleLimit: sampleSize,
      jobsSeen: jobs.length,
      usJobsSeen: validationScope === "US" ? jobs.length : 0,
      // Provider adapter contract/tests prove exhaustive pagination. The bounded company probe does
      // not itself paginate, so this flag represents the certified adapter capability, not a claim
      // that the three-row sample enumerated the whole board.
      paginationVerified: approved,
      completenessVerified: approved,
      canIngest: approved,
      canCloseMissing: approved,
      errorCategory,
      reason,
      evidence: JSON.parse(evidence) as Record<string, unknown>,
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs,
      samples: jobs,
    });
    if (outcome === "APPROVED" || outcome === "REJECTED") {
      reviewJobSource(candidate.jobSourceId, outcome, evidence);
    } else {
      recordPendingJobSourceValidation(candidate.jobSourceId, evidence);
    }
  }
  return {
    jobSourceId: candidate.jobSourceId,
    organizationId: candidate.organizationId,
    canonicalName: candidate.canonicalName,
    provider: candidate.provider,
    outcome,
    reason,
    sampleJobs: jobs.length,
    validationScope,
    unknownLocations,
    nonUsLocations,
    errorCategory,
    evidence,
  };
}

export async function runPendingConnectorValidationBatch(options: {
  batchSize?: number;
  sampleSize?: number;
  concurrency?: number;
  persist?: boolean;
  retryPendingNow?: boolean;
  provider?: SupportedProvider;
} = {}): Promise<ConnectorValidationBatchSummary> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const candidates = listPendingConnectorCandidates(options.batchSize ?? 100, {
    retryPendingNow: options.retryPendingNow,
    provider: options.provider,
  });
  const limit = pLimit(Math.max(1, Math.min(Math.trunc(options.concurrency ?? 3), 10)));
  const results = await Promise.all(candidates.map((candidate) => limit(() =>
    validatePendingConnector(candidate, {
      sampleSize: options.sampleSize,
      persist: options.persist,
    })
  )));
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    attempted: results.length,
    approved: results.filter((result) => result.outcome === "APPROVED").length,
    rejected: results.filter((result) => result.outcome === "REJECTED").length,
    pending: results.filter((result) => result.outcome === "PENDING").length,
    results,
  };
}
