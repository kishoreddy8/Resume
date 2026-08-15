import { runScan, type RunScanOptions } from "@/lib/scan";
import { incrementalMatchAffectedJobs, type IncrementalMatchResult } from "@/lib/match/incrementalMatch";
import { generateNotificationsForIncrementalMatches, type NotificationGenerationResult } from "@/lib/notifications/generateNotifications";
import type { Company, ScanSummary } from "@/types";

/**
 * Phase 4 Stages 2 & 4 — the ONE canonical post-scan flow: runScan(), then (as separate stages,
 * never interleaved inside scanCompany() itself) incrementalMatchAffectedJobs() for whatever
 * ScanSummary.affectedJobDedupeKeys came back, then generateNotificationsForIncrementalMatches() for
 * whatever pairs incremental matching just evaluated. Both POST /api/scan
 * (src/app/api/scan/route.ts) and the scheduler tick (src/lib/scheduler/tick.ts) call this same
 * function — there is no separate "manual scan post-processing" vs. "scheduled scan
 * post-processing" implementation, and now no separate notification path either. The function name
 * and result shape are kept stable across the Stage 4 addition (a new `notifications` field, not a
 * rename or restructure) — per the explicit "avoid unnecessary churn" instruction, since the
 * existing name still accurately describes what this does.
 *
 * Deliberately does NOT wrap `runScan()` in a try/catch: if the scan itself throws (a catastrophic
 * failure, distinct from a per-company error already captured inside ScanSummary.errors), that
 * exception propagates straight to this function's caller and neither incremental matching nor
 * notification generation is ever reached — "if scan itself fails catastrophically, do not run
 * incremental matching [or notifications]" holds by construction, not by an explicit check. A
 * per-company scan error does NOT throw (scanCompany()'s own catch block always returns a
 * ScanResult), so runScan() reliably returns normally even when some companies failed; matching then
 * naturally processes only the affected jobs actually admitted from the companies that succeeded.
 *
 * A failure inside incremental matching, or inside notification generation, is already isolated
 * per-pair inside each of those functions respectively — neither ever throws for a single pair's
 * problem, both always return a result object. Notification generation is additionally wrapped in
 * its OWN try/catch here (belt-and-suspenders on top of its internal per-pair isolation): its
 * batch-loading phase (resolving jobs/candidate states for every evaluated pair, before the per-pair
 * loop starts) runs outside that internal try/catch, so a genuinely unexpected throw there could
 * otherwise propagate out of this function and take the already-successful `scan`/`matching` results
 * down with it — exactly the "a notification persistence failure should be observable but should
 * not rewrite scan/match success into failure" requirement this guards.
 */
export interface ScanWithMatchingResult {
  scan: ScanSummary;
  matching: IncrementalMatchResult;
  notifications: NotificationGenerationResult;
}

const EMPTY_MATCH_RESULT: IncrementalMatchResult = {
  jobsRequested: 0,
  jobsResolved: 0,
  candidatesConsidered: 0,
  pairsAttempted: 0,
  resultsCreated: 0,
  resultsReused: 0,
  failures: [],
  evaluatedPairs: [],
  readyForTailoring: 0,
  needsReview: 0,
  blocked: 0,
};

const EMPTY_NOTIFICATION_RESULT: NotificationGenerationResult = {
  evaluated: 0,
  created: 0,
  skipped: 0,
  failures: [],
};

export async function runScanWithIncrementalMatching(
  companies: Company[],
  options: RunScanOptions = {}
): Promise<ScanWithMatchingResult> {
  const scan = await runScan(companies, options);

  // Zero affected jobs is a safe no-op — neither the matcher nor the notification generator is
  // invoked at all, not just invoked with an empty list (see test coverage: "not invoked" is
  // asserted, not just "returns empty").
  if (scan.affectedJobDedupeKeys.length === 0) {
    return { scan, matching: EMPTY_MATCH_RESULT, notifications: EMPTY_NOTIFICATION_RESULT };
  }

  const matching = incrementalMatchAffectedJobs({ dedupeKeys: scan.affectedJobDedupeKeys });

  // Phase 2 matching must remain pure from notification side effects — notification generation is
  // never called from inside incrementalMatchAffectedJobs/evaluateJobMatch/insertJobMatchResult,
  // only here, as an explicit, separate step after matching has fully completed. Wrapped in its own
  // try/catch (see the module doc comment above) so even an unexpected notification-side crash can
  // never turn an already-successful scan+matching result into a thrown error for the caller.
  let notifications: NotificationGenerationResult;
  if (matching.evaluatedPairs.length === 0) {
    notifications = EMPTY_NOTIFICATION_RESULT;
  } else {
    try {
      notifications = generateNotificationsForIncrementalMatches(matching);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notifications = {
        evaluated: matching.evaluatedPairs.length,
        created: 0,
        skipped: 0,
        failures: matching.evaluatedPairs.map((pair) => ({
          candidateId: pair.candidateId,
          dedupeKey: pair.dedupeKey,
          reason: message,
        })),
      };
    }
  }

  return { scan, matching, notifications };
}
