import { runScan, type RunScanOptions } from "@/lib/scan";
import { incrementalMatchAffectedJobs, type IncrementalMatchResult } from "@/lib/match/incrementalMatch";
import type { Company, ScanSummary } from "@/types";

/**
 * Phase 4 Stage 2 — the ONE canonical post-scan flow: runScan() then, as a separate stage (never
 * interleaved inside scanCompany() itself), incrementalMatchAffectedJobs() for whatever
 * ScanSummary.affectedJobDedupeKeys came back. Both POST /api/scan (src/app/api/scan/route.ts) and
 * the scheduler tick (src/lib/scheduler/tick.ts) call this same function — there is no separate
 * "manual scan post-processing" vs. "scheduled scan post-processing" implementation.
 *
 * Deliberately does NOT wrap `runScan()` in a try/catch: if the scan itself throws (a catastrophic
 * failure, distinct from a per-company error already captured inside ScanSummary.errors), that
 * exception propagates straight to this function's caller and incrementalMatchAffectedJobs is never
 * reached — "if scan itself fails catastrophically, do not run incremental matching" holds by
 * construction, not by an explicit check. A per-company scan error does NOT throw (scanCompany()'s
 * own catch block always returns a ScanResult), so runScan() reliably returns normally even when some
 * companies failed; matching then naturally processes only the affected jobs actually admitted from
 * the companies that succeeded.
 *
 * A failure inside incremental matching (an individual pair's evaluateJobMatch/insertJobMatchResult
 * call throwing) is already isolated per-pair inside incrementalMatchAffectedJobs itself — it always
 * returns a result object, never throws — so `scan` and `matching` below are always both populated
 * from this function; a matching-side problem can never retroactively invalidate the scan result.
 */
export interface ScanWithMatchingResult {
  scan: ScanSummary;
  matching: IncrementalMatchResult;
}

const EMPTY_MATCH_RESULT: IncrementalMatchResult = {
  jobsRequested: 0,
  jobsResolved: 0,
  candidatesConsidered: 0,
  pairsAttempted: 0,
  resultsCreated: 0,
  resultsReused: 0,
  failures: [],
  readyForTailoring: 0,
  needsReview: 0,
  blocked: 0,
};

export async function runScanWithIncrementalMatching(
  companies: Company[],
  options: RunScanOptions = {}
): Promise<ScanWithMatchingResult> {
  const scan = await runScan(companies, options);

  // Zero affected jobs is a safe no-op — the matcher is never invoked at all, not just invoked with
  // an empty list (see test coverage: "matcher not invoked" is asserted, not just "returns empty").
  if (scan.affectedJobDedupeKeys.length === 0) {
    return { scan, matching: EMPTY_MATCH_RESULT };
  }

  const matching = incrementalMatchAffectedJobs({ dedupeKeys: scan.affectedJobDedupeKeys });
  return { scan, matching };
}
