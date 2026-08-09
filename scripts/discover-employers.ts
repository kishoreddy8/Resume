import { DISCOVERY_BATCH_SIZE, runDiscoveryBatch } from "../src/lib/discovery/batch";

/**
 * Bounded H1B employer source discovery batch — see src/lib/discovery/batch.ts's own module doc
 * comment for the full design (independent batch-size/concurrency, resumable, idempotent, one
 * employer's failure never aborts the batch).
 *
 * Usage: npm run discover-employers [-- --batch-size 20] [--no-browser]
 *
 * Deliberately small by default (DISCOVERY_BATCH_SIZE) and NEVER runs against the full ~44k
 * employer table by design — pass --batch-size explicitly for anything larger, and even then this
 * is a single bounded run, not a loop over the whole table.
 */

function parseArgs() {
  const args = process.argv.slice(2);
  const out: { batchSize?: number; noBrowser?: boolean } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--batch-size") out.batchSize = Number(args[++i]);
    if (args[i] === "--no-browser") out.noBrowser = true;
  }
  return out;
}

async function main() {
  const { batchSize, noBrowser } = parseArgs();
  const effectiveBatchSize = batchSize ?? DISCOVERY_BATCH_SIZE;
  console.log(`Running a bounded discovery batch of up to ${effectiveBatchSize} employers${noBrowser ? " (HTTP-only, no browser fallback)" : ""}...`);

  const summary = await runDiscoveryBatch({ batchSize: effectiveBatchSize, useBrowserFallback: !noBrowser });

  console.log(`\nAttempted: ${summary.employersAttempted} employers in ${summary.durationMs}ms`);
  console.log(`  Domain identity — VERIFIED: ${summary.domainsVerified}, AMBIGUOUS: ${summary.domainsAmbiguous}, UNRESOLVED: ${summary.domainsUnresolved}, FAILED_TEMPORARY: ${summary.domainsFailedTemporary}`);
  console.log(`  Source/ATS — VERIFIED: ${summary.atsVerified}, NEEDS_ADAPTER: ${summary.needsAdapter}, careers pages resolved: ${summary.careersPagesResolved}, UNRESOLVED: ${summary.sourceUnresolved}, FAILED_TEMPORARY: ${summary.sourceFailedTemporary}`);
  if (summary.errors.length > 0) {
    console.log(`\n${summary.errors.length} per-employer error(s) (did not abort the batch):`);
    for (const e of summary.errors) console.log(`  - ${e}`);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Discovery batch failed:", err);
  process.exit(1);
});
