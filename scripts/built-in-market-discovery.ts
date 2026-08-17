import { DEFAULT_SEARCH_ROLES } from "../src/lib/externalSignals/types";
import { searchBuiltInAcrossRoles } from "../src/lib/externalSignals/providers";
import { processExternalListing } from "../src/lib/externalSignals/pipeline";
import {
  getBuiltInRunState,
  recordBuiltInRunFailed,
  recordBuiltInRunStarted,
  recordBuiltInRunSucceeded,
  describeBuiltInRunMode,
} from "../src/lib/externalSignals/builtInRunState";

/**
 * Stage 13 — the market-wide, multi-role Built In discovery entry point. Covers BOTH existing-
 * company job discovery and new-employer onboarding (when --onboard-new-employers is passed), using
 * the SAME processExternalListing() pipeline as scripts/external-jobs-shadow.ts — no second
 * persistence path. Default behavior is pure shadow/classification: zero DB writes at all unless
 * --persist-observations is passed; secondary-job insertion and new-employer onboarding each require
 * their own additionally-explicit flag; Discovery V2 bridging requires --trigger-discovery-v2. No
 * lifecycle maintenance, no scan, no matching, no tailoring, no notification — this script's own code
 * never calls any of those paths at all, regardless of flags.
 *
 * This is the recommended cron/scheduler entry point for Stage 13's Phase 12 cadence recommendation
 * (see the Stage 13 final report) — invoke it externally (e.g. a system cron or a lightweight process
 * scheduler) with the desired persistence flags; it deliberately does NOT register itself with
 * CareerOps' own ATS scheduler (tick.ts), keeping the "external is independent of ATS scheduling"
 * property Stage 11/12 established.
 *
 * Usage:
 *   npm run built-in-market-discovery -- --max-total 30
 *   npm run built-in-market-discovery -- --max-total 30 --persist-observations --persist-secondary-jobs
 *   npm run built-in-market-discovery -- --max-total 30 --persist-observations --persist-secondary-jobs --onboard-new-employers
 */
async function main() {
  const args = process.argv;

  const maxTotalIndex = args.indexOf("--max-total");
  const maxTotal = maxTotalIndex >= 0 ? Number.parseInt(args[maxTotalIndex + 1] ?? "", 10) : 30;
  if (!Number.isInteger(maxTotal) || maxTotal < 1 || maxTotal > 50) {
    throw new Error("--max-total must be an integer from 1 to 50 — this is a manual/bounded tool, not a bulk scrape");
  }

  const limitPerRoleIndex = args.indexOf("--limit-per-role");
  const limitPerRole = limitPerRoleIndex >= 0 ? Number.parseInt(args[limitPerRoleIndex + 1] ?? "", 10) : 10;
  if (!Number.isInteger(limitPerRole) || limitPerRole < 1 || limitPerRole > 20) {
    throw new Error("--limit-per-role must be an integer from 1 to 20");
  }

  const persistObservations = args.includes("--persist-observations");
  const persistSecondaryJobs = args.includes("--persist-secondary-jobs");
  const onboardNewEmployers = args.includes("--onboard-new-employers");
  const triggerDiscoveryV2 = args.includes("--trigger-discovery-v2");
  if (persistSecondaryJobs && !persistObservations) throw new Error("--persist-secondary-jobs requires --persist-observations");
  if (onboardNewEmployers && !persistObservations) throw new Error("--onboard-new-employers requires --persist-observations");
  if (triggerDiscoveryV2 && !persistObservations) throw new Error("--trigger-discovery-v2 requires --persist-observations");

  const runState = getBuiltInRunState();
  const mode = describeBuiltInRunMode(runState);
  console.log(
    `Built In market discovery — mode=${mode} (last successful run: ${runState.lastSuccessfulAt ?? "never"}), roles=${DEFAULT_SEARCH_ROLES.length}, max-total=${maxTotal}, limit-per-role=${limitPerRole}`
  );
  console.log(
    `Persist observations: ${persistObservations}. Persist secondary jobs: ${persistSecondaryJobs}. Onboard new employers: ${onboardNewEmployers}. Trigger Discovery V2: ${triggerDiscoveryV2}.\n`
  );

  recordBuiltInRunStarted();
  try {
    const rawResults = await searchBuiltInAcrossRoles(DEFAULT_SEARCH_ROLES, { limitPerRole, maxTotalUnique: maxTotal });
    console.log(`Fetched ${rawResults.length} unique listing(s) across ${DEFAULT_SEARCH_ROLES.length} role queries.\n`);

    for (const raw of rawResults) {
      const result = await processExternalListing("built_in", raw, { persistObservations, persistSecondaryJobs, onboardNewEmployers, triggerDiscoveryV2 });
      console.log(`── ${result.normalized.title} @ ${result.normalized.employerName} ──`);
      console.log(`  location: ${result.normalized.location ?? "(none)"}`);
      console.log(`  apply/direct: ${result.normalized.directEmployerUrl ?? result.normalized.applyUrl ?? "(none)"}`);
      console.log(`  company match: ${result.match.companyId ?? "(none)"} (${result.match.confidence}) — ${result.match.reason}`);
      if (result.newEmployerOnboarding) {
        console.log(`  new-employer onboarding: ${result.newEmployerOnboarding.outcome} — ${result.newEmployerOnboarding.reason}`);
        if (result.newEmployerOnboarding.proposalCreated) {
          console.log(`  ATS proposal created: #${result.newEmployerOnboarding.proposalCreated.id} (${result.newEmployerOnboarding.proposalCreated.status})`);
        }
      }
      console.log(`  employer relationship: ${result.employerRelationship}`);
      console.log(`  url classification: ${result.urlClassification.classification}${result.urlClassification.provider ? ` (${result.urlClassification.provider}/${result.urlClassification.boardToken})` : ""}`);
      console.log(`  signal: ${result.signalClassification} | decision: ${result.decision}`);
      if (result.observation) console.log(`  PERSISTED: observation #${result.observation.id}`);
      if (result.stagedJob) console.log(`  SECONDARY JOB: ${result.stagedJob.outcome} (jobId=${result.stagedJob.jobId})`);
      if (result.discoveryBridge) console.log(`  DISCOVERY V2: ${result.discoveryBridge.outcome} — ${result.discoveryBridge.candidateCount} candidate(s), ${result.discoveryBridge.proposalsCreated.length} proposal(s) created`);
      console.log("");
    }

    recordBuiltInRunSucceeded();
    console.log(persistObservations ? "Run complete. Database writes performed per the flags above." : "Run complete. Zero database writes — pure classification only.");
  } catch (error) {
    recordBuiltInRunFailed(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

main().catch((error) => {
  console.error("Built In market discovery failed:", error);
  process.exit(1);
});
