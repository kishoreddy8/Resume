import { listScanReadyCompanies } from "@/db/queries/organizationRegistry";
import { getAppSettings } from "@/db/queries/settings";
import type { IncrementalMatchResult } from "@/lib/match/incrementalMatch";
import type { NotificationGenerationResult } from "@/lib/notifications/generateNotifications";
import { runScanWithIncrementalMatching } from "@/lib/scan/runScanWithMatching";
import type { ScanSummary } from "@/types";
import { acquireScanLock, releaseScanLock } from "./lock";
import {
  getSchedulerRuntimeState,
  recordSchedulerTickFailed,
  recordSchedulerTickStarted,
  recordSchedulerTickSucceeded,
} from "./state";
import { isEnabled, isIntervalDue, isWithinWindow } from "./window";

export type SchedulerTickOutcome =
  | { outcome: "SKIPPED_DISABLED" }
  | { outcome: "SKIPPED_OUTSIDE_WINDOW" }
  | { outcome: "SKIPPED_INTERVAL_NOT_DUE" }
  | { outcome: "SKIPPED_LOCK_HELD"; heldSince?: string }
  | { outcome: "SKIPPED_NO_COMPANIES" }
  | {
      outcome: "RAN";
      companiesScanned: number;
      summary: ScanSummary;
      matching: IncrementalMatchResult;
      notifications: NotificationGenerationResult;
    }
  | { outcome: "FAILED"; error: string };

/**
 * One scheduler tick (Phase 4 Stage 1). Evaluates whether a scan should run right now and, if so,
 * runs it via the SAME runScan()/scanCompany() engine every other caller uses (src/lib/scan.ts) —
 * zero forking of the scan engine. Structured-sources-only: company selection reuses
 * listScanReadyCompanies() (src/db/queries/organizationRegistry.ts's existing 30-provider
 * structured-ATS allowlist; career_link is never included there), not a new/duplicated provider
 * list.
 *
 * Never throws. Every path — disabled, outside window, interval not due, lock held (by either a
 * concurrent tick or a manual POST /api/scan, since both share the same lock primitive — see
 * lock.ts), zero eligible companies, or the scan itself throwing — is represented in the returned
 * SchedulerTickOutcome, so a caller (the instrumentation.ts timer, or a test) never needs its own
 * try/catch around this function.
 */
export async function runSchedulerTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
  const settings = getAppSettings();

  if (!isEnabled(settings.scheduler)) {
    return { outcome: "SKIPPED_DISABLED" };
  }
  if (!isWithinWindow(now, settings.scheduler)) {
    return { outcome: "SKIPPED_OUTSIDE_WINDOW" };
  }

  const runtimeState = getSchedulerRuntimeState();
  if (!isIntervalDue(runtimeState.lastStartedAt, settings.scheduler.intervalMinutes, now)) {
    return { outcome: "SKIPPED_INTERVAL_NOT_DUE" };
  }

  const lockResult = acquireScanLock(now);
  if (!lockResult.acquired) {
    return { outcome: "SKIPPED_LOCK_HELD", heldSince: lockResult.heldSince };
  }

  // lastStartedAt intentionally uses the tick's own `now` (the instant this tick evaluated
  // due-ness) — isIntervalDue reads it back for the NEXT tick's decision, so it must stay
  // consistent with the clock this tick reasoned about. lastCompletedAt/lastSuccessfulAt/lastError
  // below deliberately use a fresh real timestamp instead (their default `new Date()`), since a
  // real scan can run for a long time — completion must reflect when it actually finished, not
  // when it started (which could be many minutes earlier for a long-running scan).
  recordSchedulerTickStarted(now);
  try {
    const companies = listScanReadyCompanies();
    if (companies.length === 0) {
      recordSchedulerTickSucceeded();
      return { outcome: "SKIPPED_NO_COMPANIES" };
    }

    // Phase 4 Stages 2 & 4 — the same shared post-scan orchestration POST /api/scan uses (see
    // src/lib/scan/runScanWithMatching.ts's doc comment for the full "one canonical flow" rationale
    // and why a thrown scan error here is deliberately left uncaught by that helper, so it still
    // propagates to THIS try/catch and skips matching/notifications entirely, exactly like a
    // non-incremental scan failure already did before Stage 2).
    const { scan, matching, notifications } = await runScanWithIncrementalMatching(companies);
    recordSchedulerTickSucceeded();
    return { outcome: "RAN", companiesScanned: companies.length, summary: scan, matching, notifications };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSchedulerTickFailed(message);
    return { outcome: "FAILED", error: message };
  } finally {
    // Always release, whether the scan succeeded, failed, or threw before either — never leave the
    // lock held past this tick just because the scan itself errored.
    releaseScanLock();
  }
}
