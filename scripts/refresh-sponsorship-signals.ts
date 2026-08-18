import { refreshSponsorshipSignals } from "../src/lib/jobIntel/backfillJobIntelligence";

/**
 * Stage 25B — recompute jobs.sponsorship_polarity / h1b_combined_confidence from each job's already
 * stored description, using the SAME scanSponsorshipLanguage() + combineH1bConfidence() pair the
 * scan path uses. No network access, no provider calls, no second classifier.
 *
 * Usage:
 *   npm run refresh-sponsorship-signals            # DRY RUN — prints every differing row
 *   npm run refresh-sponsorship-signals -- --apply # writes only the rows that actually differ
 */
function main() {
  const apply = process.argv.includes("--apply");
  const result = refreshSponsorshipSignals({ dryRun: !apply });

  console.log(`${apply ? "APPLY" : "DRY RUN"} — scanned ${result.scanned} active job(s)`);
  console.log(`rows whose recomputed sponsorship signal DIFFERS: ${result.differing}`);
  console.log("transitions:", JSON.stringify(result.transitions, null, 0));
  console.log("");
  for (const row of result.rows) {
    console.log(
      `  job ${String(row.jobId).padStart(6)} | ${row.currentPolarity.padEnd(8)} -> ${row.recomputedPolarity.padEnd(8)} | ` +
        `${row.currentConfidence.padEnd(14)} -> ${row.recomputedConfidence.padEnd(14)} | ${row.company.slice(0, 26).padEnd(26)} | ${row.title.slice(0, 44)}`
    );
    if (row.snippet) console.log(`           evidence: ${row.snippet}`);
  }
  if (apply) console.log(`\nUpdated ${result.updated} row(s).`);
  else console.log(`\nNothing written. Re-run with --apply to update these ${result.differing} row(s).`);
}

main();
