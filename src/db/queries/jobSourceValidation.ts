import { getDb } from "@/db";
import { classifyJobLocation } from "@/lib/jobLocationScope";
import type { ErrorCategory, NormalizedJob } from "@/types";

export type SourceValidationOutcome =
  | "READY_ADDITIVE"
  | "READY_AUTHORITATIVE"
  | "NO_US_JOBS"
  | "NEEDS_ADAPTER"
  | "PENDING"
  | "REJECTED"
  | "FAILED_TEMPORARY";

export interface RecordSourceValidationInput {
  jobSourceId: number;
  validationKind: "STRUCTURED_ATS" | "GENERIC_CAREER_PAGE";
  connectorVersion: string;
  outcome: SourceValidationOutcome;
  extractorType: string | null;
  validationScope: "US" | "GLOBAL" | null;
  sampleLimit: number;
  jobsSeen: number;
  usJobsSeen: number;
  paginationVerified: boolean;
  completenessVerified: boolean;
  canIngest: boolean;
  canCloseMissing: boolean;
  errorCategory: ErrorCategory | null;
  reason: string;
  evidence: Record<string, unknown>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  samples: NormalizedJob[];
}

/** Records one validation attempt and its bounded samples atomically. Sample rows are evidence-only
 * and intentionally never touch the production `jobs` table. */
export function recordSourceValidation(input: RecordSourceValidationInput): number {
  const db = getDb();
  return db.transaction(() => {
    const run = db.prepare(
      `INSERT INTO job_source_validation_runs (
         job_source_id, validation_kind, connector_version, outcome, extractor_type,
         validation_scope, sample_limit, jobs_seen, us_jobs_seen, samples_saved,
         pagination_verified, completeness_verified, can_ingest, can_close_missing,
         error_category, reason, evidence_json, started_at, finished_at, duration_ms
       ) VALUES (
         @jobSourceId, @validationKind, @connectorVersion, @outcome, @extractorType,
         @validationScope, @sampleLimit, @jobsSeen, @usJobsSeen, @samplesSaved,
         @paginationVerified, @completenessVerified, @canIngest, @canCloseMissing,
         @errorCategory, @reason, @evidenceJson, @startedAt, @finishedAt, @durationMs
       ) RETURNING id`
    ).get({
      ...input,
      samplesSaved: input.samples.length,
      paginationVerified: input.paginationVerified ? 1 : 0,
      completenessVerified: input.completenessVerified ? 1 : 0,
      canIngest: input.canIngest ? 1 : 0,
      canCloseMissing: input.canCloseMissing ? 1 : 0,
      evidenceJson: JSON.stringify(input.evidence),
    }) as { id: number };

    const insertSample = db.prepare(
      `INSERT INTO job_source_validation_samples (
         validation_run_id, sample_index, external_id, title, location, location_scope,
         job_url, description_present, posted_at, evidence_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    input.samples.forEach((job, index) => {
      const locationScope = classifyJobLocation(job.location);
      insertSample.run(
        run.id,
        index + 1,
        job.externalId,
        job.title,
        job.location,
        locationScope,
        job.url,
        job.descriptionText || job.descriptionHtml ? 1 : 0,
        job.postedAt,
        JSON.stringify({ raw: job.raw ?? null })
      );
    });
    return run.id;
  })();
}
