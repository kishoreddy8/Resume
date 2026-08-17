import { backfillJobIntelligence } from "../src/lib/jobIntel/backfillJobIntelligence";

/**
 * Stage 24A — one-shot bounded backfill for active jobs ingested before structured intelligence
 * extraction ran for their source. Safe to re-run repeatedly (see backfillJobIntelligence's own doc
 * comment for idempotency) — run it again with the same or a higher --limit until candidatesFound
 * reaches 0.
 *
 * Usage:
 *   npx tsx scripts/backfill-job-intelligence.ts --limit 200
 *   npx tsx scripts/backfill-job-intelligence.ts            (defaults to 200)
 */
async function main() {
  const limitIndex = process.argv.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number.parseInt(process.argv[limitIndex + 1] ?? "", 10) : 200;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--limit must be a positive integer");
  }

  console.log(`Job intelligence backfill — bounded to ${limit} candidates...`);
  const t0 = Date.now();
  const result = backfillJobIntelligence(limit);
  const durationMs = Date.now() - t0;

  console.log(JSON.stringify({ ...result, durationMs }, null, 2));
  console.log(
    `\n${result.succeeded}/${result.candidatesFound} succeeded, ${result.failed} failed, ` +
      `${result.descriptionsNormalized} descriptions normalized, ${durationMs}ms.`
  );
  if (result.candidatesFound === limit) {
    console.log("Candidate count hit the batch limit — more jobs likely remain; re-run to continue.");
  }
  if (result.errors.length > 0) {
    console.error("Errors:", result.errors);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
