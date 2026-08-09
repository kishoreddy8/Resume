import { getDb } from "@/db";
import type { DiscoveryRun } from "@/types";

/** Query layer for discovery_runs — batch-level observability, mirrors src/db/queries/scanRuns.ts
 *  and match_runs' own shape/reasoning exactly. One row per bounded batch run
 *  (src/lib/discovery/batch.ts); per-employer detail lives on employer_identity_resolutions/
 *  companies themselves, never duplicated here. */

export interface RecordDiscoveryRunInput {
  startedAt: string;
  finishedAt: string;
  employersAttempted: number;
  domainsVerified: number;
  domainsAmbiguous: number;
  domainsUnresolved: number;
  domainsFailedTemporary: number;
  careersPagesResolved: number;
  atsVerified: number;
  needsAdapter: number;
  sourceUnresolved: number;
  sourceFailedTemporary: number;
  durationMs: number;
  errorSummary: string | null;
}

export function recordDiscoveryRun(input: RecordDiscoveryRunInput): DiscoveryRun {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO discovery_runs (
         started_at, finished_at, employers_attempted, domains_verified, domains_ambiguous,
         domains_unresolved, domains_failed_temporary, careers_pages_resolved, ats_verified,
         needs_adapter, source_unresolved, source_failed_temporary, duration_ms, error_summary
       ) VALUES (
         @startedAt, @finishedAt, @employersAttempted, @domainsVerified, @domainsAmbiguous,
         @domainsUnresolved, @domainsFailedTemporary, @careersPagesResolved, @atsVerified,
         @needsAdapter, @sourceUnresolved, @sourceFailedTemporary, @durationMs, @errorSummary
       )`
    )
    .run(input);
  return getDb().prepare("SELECT * FROM discovery_runs WHERE id = ?").get(result.lastInsertRowid) as DiscoveryRun;
}

export function listDiscoveryRuns(limit = 50): DiscoveryRun[] {
  return getDb().prepare("SELECT * FROM discovery_runs ORDER BY started_at DESC LIMIT ?").all(limit) as DiscoveryRun[];
}
