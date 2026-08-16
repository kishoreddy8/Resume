import { getCompany } from "../src/db/queries/companies";
import { isLiveProviderConfigured, getProvider } from "../src/lib/externalSignals/providers";
import { processExternalListing } from "../src/lib/externalSignals/pipeline";
import { DEFAULT_SEARCH_ROLES, type ExternalSignalSource } from "../src/lib/externalSignals/types";

/**
 * Stage 7 — the ONLY manual command that reaches Google Jobs / Indeed. Default behavior is pure
 * shadow/classification: zero DB writes at all (not even an observation row) unless
 * --persist-observations is passed; secondary jobs-table insertion requires the additionally-explicit
 * --persist-secondary-jobs; Discovery V2 bridging requires the additionally-explicit
 * --trigger-discovery-v2. No company mutation, no proposal approval, no scan, no matching, no
 * tailoring, no notification, no lifecycle maintenance — this script's own code never calls any of
 * those paths at all, regardless of flags.
 *
 * Usage:
 *   npm run external-jobs-shadow -- --source indeed --limit 10
 *   npm run external-jobs-shadow -- --source google --limit 10 --persist-observations
 *   npm run external-jobs-shadow -- --source indeed --company-id 530 --persist-observations --persist-secondary-jobs --trigger-discovery-v2
 */
async function main() {
  const sourceIndex = process.argv.indexOf("--source");
  const sourceArg = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : null;
  if (sourceArg !== "google" && sourceArg !== "indeed") {
    throw new Error("--source must be one of: google, indeed");
  }
  const source: ExternalSignalSource = sourceArg === "google" ? "google_jobs" : "indeed";

  const limitIndex = process.argv.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number.parseInt(process.argv[limitIndex + 1] ?? "", 10) : 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("--limit must be an integer from 1 to 20 — this is a manual, bounded tool, not a bulk scrape");
  }

  const companyIdIndex = process.argv.indexOf("--company-id");
  const requestedCompanyId = companyIdIndex >= 0 ? Number.parseInt(process.argv[companyIdIndex + 1] ?? "", 10) : null;
  if (companyIdIndex >= 0 && (!requestedCompanyId || requestedCompanyId < 1)) {
    throw new Error("--company-id must be a positive integer");
  }

  const persistObservations = process.argv.includes("--persist-observations");
  const persistSecondaryJobs = process.argv.includes("--persist-secondary-jobs");
  const triggerDiscoveryV2 = process.argv.includes("--trigger-discovery-v2");
  if (persistSecondaryJobs && !persistObservations) {
    throw new Error("--persist-secondary-jobs requires --persist-observations (a secondary job always traces back to a persisted observation)");
  }
  if (triggerDiscoveryV2 && !persistObservations) {
    throw new Error("--trigger-discovery-v2 requires --persist-observations");
  }

  const live = isLiveProviderConfigured();
  console.log(
    live
      ? `External hiring-signal shadow run — source=${source}, limit=${limit}, LIVE (APIFY_API_TOKEN configured).`
      : `External hiring-signal shadow run — source=${source}, limit=${limit}, FIXTURE MODE (LIVE_PROVIDER_NOT_CONFIGURED — set APIFY_API_TOKEN for real data).`
  );
  console.log(
    `Persist observations: ${persistObservations}. Persist secondary jobs: ${persistSecondaryJobs}. Trigger Discovery V2: ${triggerDiscoveryV2}.\n`
  );

  const provider = getProvider(source);
  const role = DEFAULT_SEARCH_ROLES[0];
  const companyName = requestedCompanyId ? getCompany(requestedCompanyId)?.name ?? null : null;
  const query = { role, location: "United States", limit };
  const rawResults = await provider.search(query);

  console.log(`Fetched ${rawResults.length} raw result(s) for query "${role}"${companyName ? ` (scoped context: ${companyName})` : ""}.\n`);

  for (const raw of rawResults.slice(0, limit)) {
    const result = await processExternalListing(source, raw, { persistObservations, persistSecondaryJobs, triggerDiscoveryV2 });
    console.log(`── ${result.normalized.title} @ ${result.normalized.employerName} ──`);
    console.log(`  location: ${result.normalized.location ?? "(none)"}`);
    console.log(`  listing: ${result.normalized.listingUrl}`);
    console.log(`  apply/direct: ${result.normalized.directEmployerUrl ?? result.normalized.applyUrl ?? "(none)"}`);
    console.log(`  company match: ${result.match.companyId ?? "(none)"} (${result.match.confidence}) — ${result.match.reason}`);
    console.log(`  employer relationship: ${result.employerRelationship}`);
    console.log(`  url classification: ${result.urlClassification.classification}${result.urlClassification.provider ? ` (${result.urlClassification.provider}/${result.urlClassification.boardToken})` : ""}`);
    console.log(`  signal: ${result.signalClassification} | decision: ${result.decision}`);
    if (result.observation) console.log(`  PERSISTED: observation #${result.observation.id}`);
    if (result.stagedJob) console.log(`  SECONDARY JOB: ${result.stagedJob.outcome} (jobId=${result.stagedJob.jobId})`);
    if (result.discoveryBridge) console.log(`  DISCOVERY V2: ${result.discoveryBridge.outcome} — ${result.discoveryBridge.candidateCount} candidate(s), ${result.discoveryBridge.proposalsCreated.length} proposal(s) created`);
    console.log("");
  }

  console.log(
    persistObservations
      ? "Shadow run complete. Only external_hiring_observations rows (and, if requested, secondary jobs/ats_source_proposals rows) were written. Nothing was approved, no scan ran, no lifecycle maintenance ran."
      : "Shadow run complete. Zero database writes — pure classification only."
  );
}

main().catch((error) => {
  console.error("External hiring-signal shadow run failed:", error);
  process.exit(1);
});
