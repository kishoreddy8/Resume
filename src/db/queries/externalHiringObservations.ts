import { getDb } from "@/db";
import type { ExternalHiringObservationRow } from "@/lib/externalSignals/types";

const OBSERVATION_TTL_DAYS = 21; // within the task's specified 14-30 day window

export interface UpsertObservationInput {
  source: ExternalHiringObservationRow["source"];
  providerJobId: string | null;
  fingerprint: string;
  observedEmployerName: string;
  observedTitle: string;
  observedLocation: string | null;
  observedUrl: string;
  directEmployerUrl: string | null;
  directApplyUrl: string | null;
  employerDomain: string | null;
  postedAt: string | null;
  matchedCompanyId: number | null;
  matchConfidence: ExternalHiringObservationRow["match_confidence"];
  employerRelationship: ExternalHiringObservationRow["employer_relationship"];
  urlClassification: ExternalHiringObservationRow["url_classification"];
  detectedAtsProvider: string | null;
  detectedAtsBoardToken: string | null;
  signalClassification: ExternalHiringObservationRow["signal_classification"];
  decision: ExternalHiringObservationRow["decision"];
  evidenceJson: string;
}

function rowToObservation(row: unknown): ExternalHiringObservationRow {
  return row as ExternalHiringObservationRow;
}

export function getObservation(id: number): ExternalHiringObservationRow | undefined {
  const row = getDb().prepare("SELECT * FROM external_hiring_observations WHERE id = ?").get(id);
  return row ? rowToObservation(row) : undefined;
}

export function getObservationByFingerprint(source: string, fingerprint: string): ExternalHiringObservationRow | undefined {
  const row = getDb()
    .prepare("SELECT * FROM external_hiring_observations WHERE source = ? AND fingerprint = ?")
    .get(source, fingerprint);
  return row ? rowToObservation(row) : undefined;
}

/**
 * Phase 11 dedup/TTL: a repeated sighting of the same (source, fingerprint) refreshes
 * last_observed_at/expires_at and the current classification in place — it never creates a second
 * row. resulting_job_id is preserved across a refresh (never clobbered back to null) once a
 * secondary job has actually been staged for this observation.
 */
export function upsertExternalHiringObservation(input: UpsertObservationInput, now: Date = new Date()): ExternalHiringObservationRow {
  const db = getDb();
  const expiresAt = new Date(now.getTime() + OBSERVATION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const row = db
    .prepare(
      `INSERT INTO external_hiring_observations (
         source, provider_job_id, fingerprint, observed_employer_name, observed_title,
         observed_location, observed_url, direct_employer_url, direct_apply_url, employer_domain,
         posted_at, matched_company_id, match_confidence, employer_relationship, url_classification,
         detected_ats_provider, detected_ats_board_token, signal_classification, decision,
         evidence_json, status, first_observed_at, last_observed_at, expires_at
       ) VALUES (
         @source, @providerJobId, @fingerprint, @observedEmployerName, @observedTitle,
         @observedLocation, @observedUrl, @directEmployerUrl, @directApplyUrl, @employerDomain,
         @postedAt, @matchedCompanyId, @matchConfidence, @employerRelationship, @urlClassification,
         @detectedAtsProvider, @detectedAtsBoardToken, @signalClassification, @decision,
         @evidenceJson, 'ACTIVE', @now, @now, @expiresAt
       )
       ON CONFLICT(source, fingerprint) DO UPDATE SET
         observed_title = excluded.observed_title,
         observed_location = excluded.observed_location,
         observed_url = excluded.observed_url,
         direct_employer_url = excluded.direct_employer_url,
         direct_apply_url = excluded.direct_apply_url,
         employer_domain = excluded.employer_domain,
         posted_at = excluded.posted_at,
         matched_company_id = excluded.matched_company_id,
         match_confidence = excluded.match_confidence,
         employer_relationship = excluded.employer_relationship,
         url_classification = excluded.url_classification,
         detected_ats_provider = excluded.detected_ats_provider,
         detected_ats_board_token = excluded.detected_ats_board_token,
         signal_classification = excluded.signal_classification,
         decision = excluded.decision,
         evidence_json = excluded.evidence_json,
         status = 'ACTIVE',
         last_observed_at = excluded.last_observed_at,
         expires_at = excluded.expires_at,
         updated_at = datetime('now')
       RETURNING *`
    )
    .get({
      ...input,
      now: now.toISOString(),
      expiresAt,
    });
  return rowToObservation(row);
}

export function markObservationResultingJob(id: number, jobId: number): void {
  getDb().prepare("UPDATE external_hiring_observations SET resulting_job_id = ?, updated_at = datetime('now') WHERE id = ?").run(jobId, id);
}

export function listObservationsBySignal(signal: ExternalHiringObservationRow["signal_classification"], limit = 100): ExternalHiringObservationRow[] {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
  return getDb()
    .prepare("SELECT * FROM external_hiring_observations WHERE signal_classification = ? AND status = 'ACTIVE' ORDER BY last_observed_at DESC LIMIT ?")
    .all(signal, boundedLimit) as ExternalHiringObservationRow[];
}

export function listObservationsForCompany(companyId: number): ExternalHiringObservationRow[] {
  return getDb()
    .prepare("SELECT * FROM external_hiring_observations WHERE matched_company_id = ? ORDER BY last_observed_at DESC")
    .all(companyId) as ExternalHiringObservationRow[];
}

/** Phase 11 expiration: marks anything past its TTL as EXPIRED and re-classifies its signal to
 *  EXPIRED too, so a stale observation stops appearing in the COVERAGE_MISMATCH priority queue.
 *  Explicit, not automatic — called only by the shadow runner / a maintenance path, never implicitly
 *  from the pipeline itself (matching this codebase's established "no implicit global side effects"
 *  convention from the Stage 5/6 lifecycle-maintenance decoupling). */
export function expireStaleObservations(now: Date = new Date()): number {
  const result = getDb()
    .prepare(
      `UPDATE external_hiring_observations
       SET status = 'EXPIRED', signal_classification = 'EXPIRED', updated_at = datetime('now')
       WHERE status = 'ACTIVE' AND expires_at < ?`
    )
    .run(now.toISOString());
  return result.changes;
}
