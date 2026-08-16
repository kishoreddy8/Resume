import { listRediscoveryEligibleCompanies } from "../src/db/queries/organizationRegistry";
import { attemptSourceRediscovery } from "../src/lib/ats/sourceRediscovery";

/**
 * ATS Source Self-Healing, Stage 2 — manual, bounded, SHADOW-ONLY runner.
 *
 * Finds companies whose active source shows strong, specific evidence of staleness
 * (consecutive_failures >= 2 with last_error_category = 'invalid_config' — see
 * listRediscoveryEligibleCompanies's own doc comment for exactly why), re-runs discovery, validates
 * any candidate it finds, and prints a structured recommendation.
 *
 * SHADOW MODE: this script NEVER writes to companies, job_sources, jobs, or any other production
 * table — it is a pure read (network I/O to re-run discovery/validate a candidate aside). Nothing it
 * finds is applied automatically; AUTO_REPLACE_CANDIDATE means "would be eligible for a future,
 * separately-authorized automatic-replacement stage," not "already replaced."
 *
 * NOT wired into the scheduler — deliberately manual, run by a human, small batches, so real
 * production evidence can be gathered before any automation is considered.
 *
 * Usage: npm run rediscover-sources-shadow -- --limit 5
 */
async function main() {
  const limitIndex = process.argv.indexOf("--limit");
  const requestedLimit = limitIndex >= 0 ? Number.parseInt(process.argv[limitIndex + 1] ?? "", 10) : 5;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 25) {
    throw new Error("--limit must be an integer from 1 to 25 (default 5) — this is a manual, bounded shadow tool, not a bulk scan");
  }

  const eligible = listRediscoveryEligibleCompanies(requestedLimit);
  if (eligible.length === 0) {
    console.log("No companies currently meet the rediscovery eligibility bar (consecutive_failures >= 2 AND last_error_category = 'invalid_config').");
    return;
  }

  console.log(`Shadow rediscovery — ${eligible.length} eligible compan${eligible.length === 1 ? "y" : "ies"} (read-only, no mutation):\n`);

  for (const { company, jobSourceId, provider } of eligible) {
    console.log(`── ${company.name} (company id ${company.id}, job_source id ${jobSourceId}) ──`);
    console.log(`  current source: ${provider} / ${company.ats_board_token ?? "(no token)"}`);
    console.log(`  failure history: ${company.consecutive_failures} consecutive, last_error_category=${company.last_error_category}`);

    const result = await attemptSourceRediscovery(company);

    console.log(`  candidate: ${result.candidateSource ? `${result.candidateSource.sourceType} / ${result.candidateSource.atsBoardToken}` : "(none found)"}`);
    console.log(`  discovery outcome: ${result.discoveryOutcome}`);
    console.log(`  same as current: ${result.sameAsCurrent}`);
    console.log(`  provider changed: ${result.providerChanged}`);
    console.log(`  validation: ${result.validationOutcome}${result.validationReason ? ` — ${result.validationReason}` : ""}`);
    console.log(`  confidence: ${result.confidence ?? "(n/a)"}`);
    console.log(`  RECOMMENDED ACTION: ${result.recommendedAction}`);
    console.log(`  evidence:`);
    for (const line of result.evidence) console.log(`    - ${line}`);
    console.log("");
  }

  console.log("Shadow run complete. No source, job_sources, job, or lifecycle data was modified.");
}

main().catch((error) => {
  console.error("Shadow rediscovery run failed:", error);
  process.exit(1);
});
