import { runLifecycleMaintenance } from "../src/lib/scan/lifecycleMaintenance";

/**
 * The ONLY manual command that intentionally runs the database-wide age-based lifecycle sweep
 * (archive 8-10 day unapplied jobs, permanently delete >10 day unapplied jobs — see
 * runAgeBasedSweep's own doc comment in src/db/queries/jobs.ts for the exact policy). runScan()/
 * scripts/scan.ts never trigger this as a side effect — see RunScanOptions.runAgeSweep's doc
 * comment in src/lib/scan.ts for why that coupling was removed after a real incident.
 *
 * Usage:
 *   npm run lifecycle-maintenance -- --dry-run
 *   npm run lifecycle-maintenance -- --max-mutations 500
 *   npm run lifecycle-maintenance
 */
async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const maxMutationsIndex = process.argv.indexOf("--max-mutations");
  const maxMutations = maxMutationsIndex >= 0 ? Number.parseInt(process.argv[maxMutationsIndex + 1] ?? "", 10) : undefined;
  if (maxMutationsIndex >= 0 && (!Number.isInteger(maxMutations) || (maxMutations as number) < 1)) {
    throw new Error("--max-mutations must be a positive integer");
  }

  console.log(
    dryRun
      ? "Lifecycle maintenance — DRY RUN (calculating projected archive/delete counts, zero DB mutation, zero suppressed_jobs rows)..."
      : `Lifecycle maintenance — REAL RUN${maxMutations !== undefined ? ` (bounded to ${maxMutations} mutations)` : ""}...`
  );

  const result = runLifecycleMaintenance({ dryRun, maxMutations });

  if (result.blocked) {
    console.log(
      `BLOCKED: projected ${result.projectedCount} mutations (${result.archivedCount} archive, ${result.deletedCount} delete) ` +
        `exceeds --max-mutations ${maxMutations}. Nothing was changed. Re-run with a higher bound, ` +
        `or without --max-mutations, to proceed.`
    );
    process.exit(1);
  }

  console.log(
    `${result.dryRun ? "Projected" : "Applied"}: ${result.archivedCount} archived, ${result.deletedCount} deleted ` +
      `(${result.suppressionCount} suppression fingerprint(s) written), ${result.affectedCompanies} compan${result.affectedCompanies === 1 ? "y" : "ies"} affected, ` +
      `${result.durationMs}ms.`
  );
  if (result.dryRun && !dryRun) {
    // Shouldn't happen (dryRun input mirrors result.dryRun unless blocked, already handled above),
    // kept only as a defensive assertion so a future refactor can't silently desync the two.
    throw new Error("Internal inconsistency: result reports dryRun=true but --dry-run was not requested and the run was not blocked");
  }
}

main().catch((error) => {
  console.error("Lifecycle maintenance failed:", error);
  process.exit(1);
});
