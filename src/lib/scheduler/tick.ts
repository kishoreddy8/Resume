import { listScanReadyCompanies } from "@/db/queries/organizationRegistry";
import { getAppSettings } from "@/db/queries/settings";
import type { IncrementalMatchResult } from "@/lib/match/incrementalMatch";
import type { NotificationGenerationResult } from "@/lib/notifications/generateNotifications";
import { runLifecycleMaintenance, type LifecycleMaintenanceResult } from "@/lib/scan/lifecycleMaintenance";
import { runScanWithIncrementalMatching } from "@/lib/scan/runScanWithMatching";
import type { ScanSummary } from "@/types";
import { acquireScanLock, releaseScanLock } from "./lock";
import { getLastMaintenanceStartedAt, recordMaintenanceCompleted, recordMaintenanceStarted } from "./maintenanceState";
import {
  getSchedulerRuntimeState,
  recordSchedulerTickFailed,
  recordSchedulerTickStarted,
  recordSchedulerTickSucceeded,
} from "./state";
import { isEnabled, isIntervalDue, isWithinWindow } from "./window";

// Independent of scheduler.intervalMinutes (which governs how often SCANS run — as often as every
// few minutes). Lifecycle maintenance is a calendar-age sweep, not a freshness check, so it doesn't
// need to run on every tick — a conservative, fixed daily cadence matches the same "every 24 hours"
// convention this codebase already uses for other global background maintenance (see
// connector_health_check_runs). Not user-configurable: adding a persisted setting for a single fixed
// constant would be unnecessary surface area for something with no real reason to change per-user.
const MAINTENANCE_INTERVAL_MINUTES = 24 * 60;

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
      /** null when maintenance wasn't due this tick (see MAINTENANCE_INTERVAL_MINUTES) — a tick
       *  scanning/matching successfully is not evidence maintenance ran, or vice versa. */
      maintenance: LifecycleMaintenanceResult | null;
      /** Set only if maintenance was due and threw — isolated so a maintenance failure never turns
       *  an already-successful scan+matching+notifications result into a FAILED tick. */
      maintenanceError?: string;
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
 *
 * Four phases in order: scan -> matching -> notifications (all three inside
 * runScanWithIncrementalMatching) -> maintenance (this function's own, gated by its own independent
 * MAINTENANCE_INTERVAL_MINUTES cadence, not run every tick). Scanning itself never runs lifecycle
 * maintenance as a side effect — see RunScanOptions.runAgeSweep's doc comment in src/lib/scan.ts for
 * why that coupling was removed.
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

    // Maintenance phase — explicit and separate from the scan/matching phases above, on its own
    // independent cadence (see MAINTENANCE_INTERVAL_MINUTES). This is the ONLY place the automatic
    // scheduler ever calls runLifecycleMaintenance(); scanning itself never triggers it (see
    // RunScanOptions.runAgeSweep's doc comment in src/lib/scan.ts).
    let maintenance: LifecycleMaintenanceResult | null = null;
    let maintenanceError: string | undefined;
    if (isIntervalDue(getLastMaintenanceStartedAt(), MAINTENANCE_INTERVAL_MINUTES, now)) {
      recordMaintenanceStarted(now);
      try {
        maintenance = runLifecycleMaintenance();
      } catch (err) {
        maintenanceError = err instanceof Error ? err.message : String(err);
      } finally {
        recordMaintenanceCompleted();
      }
    }

    return {
      outcome: "RAN",
      companiesScanned: companies.length,
      summary: scan,
      matching,
      notifications,
      maintenance,
      ...(maintenanceError ? { maintenanceError } : {}),
    };
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
