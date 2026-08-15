import { requireActiveCandidate } from "../src/db/queries/candidates";
import {
  DEFAULT_REMATCH_PAGE_SIZE,
  MAX_REMATCH_PAGE_SIZE,
  rematchCandidateAllPages,
} from "../src/lib/match/rematchCandidate";

/**
 * Phase 4 Stage 5 — full candidate rematch, run locally to completion.
 *
 * Usage:
 *   npm run rematch-candidate -- <candidateId> [--limit N]
 *
 * This is a thin argv wrapper: every page, every match and every notification decision comes from
 * rematchCandidateAllPages -> rematchCandidateJobsPage, the exact same service
 * POST /api/candidates/[candidateId]/rematch calls. There is deliberately no matching, job-selection
 * or notification logic in this file — a second implementation here is precisely what would drift
 * from Phase 2/Stage 4 semantics.
 *
 * Run this rather than looping the HTTP endpoint by hand: at production scale a full walk is ~403 s
 * (~19.4k jobs x ~20 ms on cache misses), which is exactly what the API's one-page-per-request
 * contract exists to keep out of a Next.js request.
 */

function parseArgs(argv: string[]): { candidateId: number; limit: number } | { error: string } {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const candidateId = Number(positional[0]);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return { error: "Usage: npm run rematch-candidate -- <candidateId> [--limit N]" };
  }

  const limitFlag = argv.find((a) => a.startsWith("--limit"));
  let limit = DEFAULT_REMATCH_PAGE_SIZE;
  if (limitFlag) {
    const rawValue = limitFlag.includes("=") ? limitFlag.split("=")[1] : argv[argv.indexOf(limitFlag) + 1];
    const parsed = Number(rawValue);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_REMATCH_PAGE_SIZE) {
      return { error: `--limit must be an integer between 1 and ${MAX_REMATCH_PAGE_SIZE}` };
    }
    limit = parsed;
  }

  return { candidateId, limit };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    process.exitCode = 1;
    return;
  }

  const candidate = requireActiveCandidate(args.candidateId);
  if (!candidate) {
    console.error(`Candidate ${args.candidateId} is not an active candidate.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Rematching ${candidate.display_name} (candidate ${candidate.id}) in pages of ${args.limit}...`);

  const totals = rematchCandidateAllPages({
    candidateId: args.candidateId,
    limit: args.limit,
    onPage: (page, pageNumber) => {
      console.log(
        `  page ${pageNumber}: processed ${page.pairsAttempted}/${page.jobsConsidered} | ` +
          `created ${page.resultsCreated} | reused ${page.resultsReused} | failures ${page.failures.length} | ` +
          `notifications ${page.notifications.created} | cursor ${page.nextCursor ?? "-"}`
      );
      for (const failure of page.failures) {
        console.log(`    ! ${failure.dedupeKey ?? "(page)"}: ${failure.reason}`);
      }
    },
  });

  console.log(
    `\nDone. ${totals.pages} page(s), ${totals.pairsAttempted} pair(s) processed.\n` +
      `  Created ${totals.resultsCreated}\n` +
      `  Reused ${totals.resultsReused}\n` +
      `  Failures ${totals.failures.length}\n` +
      `  Ready for tailoring ${totals.readyForTailoring} | Needs review ${totals.needsReview} | Blocked ${totals.blocked}\n` +
      `  Notifications created ${totals.notificationsCreated} (failures ${totals.notificationFailures})`
  );
}

main();
