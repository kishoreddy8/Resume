import { runAgeBasedSweep } from "@/db/queries/jobs";
import { deleteGeneratedFiles } from "@/lib/generatedFiles";

/**
 * The ONE explicit, database-wide lifecycle-maintenance operation (see runAgeBasedSweep's own doc
 * comment) — deliberately separate from runScan()/scanCompany(), which only ever touch the
 * companies they were explicitly asked to scan. Reuses runAgeBasedSweep's exact selection logic for
 * both dry-run and real mode so the two paths can never drift: a dry run and a real run evaluate the
 * identical rows, thresholds, and protection checks, differing only in whether the mutation
 * statements actually execute.
 */
export interface LifecycleMaintenanceOptions {
  /** Compute and report what WOULD be archived/deleted, with zero DB mutation and zero new
   *  suppressed_jobs rows. Defaults to false (a real run) — callers that want the safe preview must
   *  ask for it explicitly, matching runScan's own opt-in philosophy for this exact operation. */
  dryRun?: boolean;
  /** If the projected archive+delete count exceeds this, the run stops before any mutation and
   *  reports the projected counts instead — an explicit blast-radius bound an operator can set,
   *  not an arbitrary hardcoded cap. Undefined = no bound. */
  maxMutations?: number;
  /** Injectable for deterministic tests; defaults to the real current time. */
  now?: Date;
}

export interface LifecycleMaintenanceResult {
  archivedCount: number;
  deletedCount: number;
  /** Distinct companies touched by either the archive or delete band this run. */
  affectedCompanies: number;
  /** Always equal to deletedCount today (every age-based deletion writes exactly one
   *  suppressed_jobs fingerprint) — reported as its own field because it answers a different
   *  question ("how many suppression rows changed") than deletedCount ("how many jobs are gone"). */
  suppressionCount: number;
  durationMs: number;
  dryRun: boolean;
  /** True when maxMutations stopped the run before any write — dryRun is forced true in that case
   *  too, since nothing was mutated. */
  blocked: boolean;
  /** Only set when blocked: the archive+delete count that would have been mutated. */
  projectedCount?: number;
}

export function runLifecycleMaintenance(options: LifecycleMaintenanceOptions = {}): LifecycleMaintenanceResult {
  const startedMs = Date.now();
  const now = options.now ?? new Date();

  // Always evaluate as a dry run first — this is both how the mutation bound is enforced before any
  // write happens, and (when the caller asked for dryRun themselves) the entire answer; no second
  // pass is needed in that case.
  const projected = runAgeBasedSweep(now, { dryRun: true });
  const projectedTotal = projected.archived + projected.deleted.length;
  const affectedCompanies = new Set<number>([...projected.archivedCompanyIds, ...projected.deleted.map((d) => d.companyId)]).size;

  if (options.maxMutations !== undefined && projectedTotal > options.maxMutations) {
    return {
      archivedCount: projected.archived,
      deletedCount: projected.deleted.length,
      affectedCompanies,
      suppressionCount: projected.deleted.length,
      durationMs: Date.now() - startedMs,
      dryRun: true,
      blocked: true,
      projectedCount: projectedTotal,
    };
  }

  if (options.dryRun) {
    return {
      archivedCount: projected.archived,
      deletedCount: projected.deleted.length,
      affectedCompanies,
      suppressionCount: projected.deleted.length,
      durationMs: Date.now() - startedMs,
      dryRun: true,
      blocked: false,
    };
  }

  // Same `now` as the dry pass above — no boundary drift between the projection and the real run.
  const real = runAgeBasedSweep(now);
  for (const job of real.deleted) {
    deleteGeneratedFiles(job.companyName, job.jobId);
  }
  const realAffectedCompanies = new Set<number>([...real.archivedCompanyIds, ...real.deleted.map((d) => d.companyId)]).size;

  return {
    archivedCount: real.archived,
    deletedCount: real.deleted.length,
    affectedCompanies: realAffectedCompanies,
    suppressionCount: real.deleted.length,
    durationMs: Date.now() - startedMs,
    dryRun: false,
    blocked: false,
  };
}
