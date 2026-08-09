import { getDb } from "@/db";
import type {
  DomainIdentityResult,
  EmployerIdentityResolution,
} from "@/types";

/**
 * Query layer for employer_identity_resolutions — the H1B legal employer -> resolved public
 * company/domain SOURCE-DISCOVERY mapping (see schema.sql's CRITICAL BOUNDARY comment on this
 * table). One row per h1b_sponsors.id, current-state (latest attempt), never an append-only log —
 * mirrors src/db/queries/companies.ts's recordDiscoveryResult pattern exactly.
 *
 * NOTHING in this file reads or writes companies.h1b_confidence, jobs.h1b_combined_confidence,
 * src/lib/h1b/combineSignal.ts, or any job_match_results/candidate_settings row. This module only
 * ever touches employer_identity_resolutions and (on a VERIFIED/AMBIGUOUS terminal outcome)
 * companies' domain-identity columns — never companies' H1B match columns, never any Phase 2 table.
 */

export function getEmployerIdentityResolution(h1bSponsorId: number): EmployerIdentityResolution | undefined {
  return getDb()
    .prepare("SELECT * FROM employer_identity_resolutions WHERE h1b_sponsor_id = ?")
    .get(h1bSponsorId) as EmployerIdentityResolution | undefined;
}

export function listEmployerIdentityResolutions(): EmployerIdentityResolution[] {
  return getDb()
    .prepare("SELECT * FROM employer_identity_resolutions ORDER BY attempted_at DESC")
    .all() as EmployerIdentityResolution[];
}

/**
 * Persists the result of running the domain-resolution waterfall (resolveDomain.ts) for one H1B
 * employer. Upserts on h1b_sponsor_id (idempotent — re-running resolution for the same employer
 * overwrites its prior attempt, exactly like companies.recordDiscoveryResult does for source
 * resolution). resolved_at is set only for terminal outcomes (VERIFIED/AMBIGUOUS/UNRESOLVED);
 * FAILED_TEMPORARY leaves it null so retry-eligibility (src/lib/discovery/priority.ts) can tell a
 * transient failure apart from a settled result.
 *
 * Deliberately does NOT touch companies.h1b_* / jobs.h1b_combined_confidence / job_match_results —
 * see this file's module doc comment.
 */
export function recordEmployerIdentityResolution(
  h1bSponsorId: number,
  result: DomainIdentityResult,
  resolvedCompanyId: number | null
): EmployerIdentityResolution {
  const db = getDb();
  const isTerminal = result.status !== "FAILED_TEMPORARY";
  db.prepare(
    `INSERT INTO employer_identity_resolutions (
       h1b_sponsor_id, resolved_company_id, domain_identity_status, domain, resolution_method,
       resolution_confidence, evidence, channels_checked, careers_checked_at,
       careers_source_resolution_status, discovered_jobs_url, attempted_at, resolved_at, updated_at
     ) VALUES (
       @h1bSponsorId, @resolvedCompanyId, @status, @domain, @method, @confidence, @evidence,
       @channelsChecked, @careersCheckedAt, @careersSourceResolutionStatus, @discoveredJobsUrl,
       datetime('now'), @resolvedAt, datetime('now')
     )
     ON CONFLICT(h1b_sponsor_id) DO UPDATE SET
       resolved_company_id = excluded.resolved_company_id,
       domain_identity_status = excluded.domain_identity_status,
       domain = excluded.domain,
       resolution_method = excluded.resolution_method,
       resolution_confidence = excluded.resolution_confidence,
       evidence = excluded.evidence,
       channels_checked = excluded.channels_checked,
       careers_checked_at = excluded.careers_checked_at,
       careers_source_resolution_status = excluded.careers_source_resolution_status,
       discovered_jobs_url = excluded.discovered_jobs_url,
       attempted_at = datetime('now'),
       resolved_at = excluded.resolved_at,
       updated_at = datetime('now')`
  ).run({
    h1bSponsorId,
    resolvedCompanyId,
    status: result.status,
    domain: result.domain,
    method: result.method,
    confidence: result.confidence,
    evidence: JSON.stringify(result.evidence),
    channelsChecked: JSON.stringify(result.channelsChecked),
    careersCheckedAt: result.careersEvidence?.checkedAt ?? null,
    careersSourceResolutionStatus: result.careersEvidence?.sourceResolutionStatus ?? null,
    discoveredJobsUrl: result.careersEvidence?.discoveredJobsUrl ?? null,
    resolvedAt: isTerminal ? new Date().toISOString() : null,
  });
  return getEmployerIdentityResolution(h1bSponsorId)!;
}

/** Attaches only the additive careers-evidence snapshot to an already-recorded resolution —
 *  used when careers/ATS discovery runs (possibly much later than domain verification) so the
 *  cache is filled in without re-deciding domain_identity_status. Never touches that status. */
export function recordCareersEvidence(
  h1bSponsorId: number,
  careers: { checkedAt: string; sourceResolutionStatus: string | null; discoveredJobsUrl: string | null }
): void {
  getDb()
    .prepare(
      `UPDATE employer_identity_resolutions SET
        careers_checked_at = @checkedAt,
        careers_source_resolution_status = @sourceResolutionStatus,
        discovered_jobs_url = @discoveredJobsUrl,
        updated_at = datetime('now')
       WHERE h1b_sponsor_id = @h1bSponsorId`
    )
    .run({ h1bSponsorId, ...careers });
}

export function deleteEmployerIdentityResolution(h1bSponsorId: number): void {
  getDb().prepare("DELETE FROM employer_identity_resolutions WHERE h1b_sponsor_id = ?").run(h1bSponsorId);
}
