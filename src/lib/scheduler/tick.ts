import { listScanReadyCompanies } from "@/db/queries/organizationRegistry";
import { getAppSettings } from "@/db/queries/settings";
import type { IncrementalMatchResult } from "@/lib/match/incrementalMatch";
import type { NotificationGenerationResult } from "@/lib/notifications/generateNotifications";
import { runLifecycleMaintenance, type LifecycleMaintenanceResult } from "@/lib/scan/lifecycleMaintenance";
import { runScanWithIncrementalMatching } from "@/lib/scan/runScanWithMatching";
import { runConnectorRecovery, type RecoveryControllerSummary } from "@/lib/ats/reliability/recoveryController";
import type { ScanSummary } from "@/types";
import { acquireScanLock, releaseScanLock } from "./lock";
import { getLastMaintenanceStartedAt, recordMaintenanceCompleted, recordMaintenanceStarted } from "./maintenanceState";
import {
  getLastReliabilityRunStartedAt,
  recordReliabilityRunCompleted,
  recordReliabilityRunStarted,
} from "./reliabilityState";
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

// Connector Reliability Control Plane V1 — independent of both scan cadence AND
// MAINTENANCE_INTERVAL_MINUTES above, same reasoning: a bounded Discovery V2 rediscovery attempt is
// a real browser render (discoveryConfig.ts's MAX_V2_TOTAL_BUDGET_MS), so it should not fire on
// every scan tick (which can run every few minutes), but genuinely broken connectors deserve
// attention well before a once-a-day maintenance-style cadence — hourly is a reasonable middle
// ground given recoveryController.ts's own 6-hour per-company cooldown already bounds how often any
// SINGLE company can be re-attempted regardless of how often this outer tick fires.
const RELIABILITY_INTERVAL_MINUTES = 60;

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
      /** null when the reliability phase wasn't due this tick (see RELIABILITY_INTERVAL_MINUTES) —
       *  same "absence is not failure" contract as maintenance above. */
      reliability: RecoveryControllerSummary | null;
      /** Set only if the reliability phase was due and threw — isolated for the exact same reason
       *  maintenanceError is: a reliability-controller failure must never turn an already-successful
       *  scan+matching+notifications result into a FAILED tick, and must never block maintenance or
       *  vice versa (Phase 12's explicit independence requirement). */
      reliabilityError?: string;
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
 * Five phases in order: scan -> matching -> notifications (all three inside
 * runScanWithIncrementalMatching) -> maintenance -> connector reliability (Connector Reliability
 * Control Plane V1) — the last two each on their own independent cadence (MAINTENANCE_INTERVAL_MINUTES,
 * RELIABILITY_INTERVAL_MINUTES), neither run every tick, and neither coupled to the other or to
 * scanning itself. Scanning never runs lifecycle maintenance as a side effect — see
 * RunScanOptions.runAgeSweep's doc comment in src/lib/scan.ts for why that coupling was removed —
 * and the reliability phase follows that exact same precedent rather than reintroducing a new
 * coupling. The reliability phase only ever reads scan-produced health state and creates/refreshes
 * ats_source_proposals rows (see recoveryController.ts); it never calls runScan itself, never touches
 * lifecycle maintenance, and has no dependency on (or effect on) the external-signals ingestion
 * pipeline, which remains its own, entirely separate system (src/lib/externalSignals/).
 */
export async function runSchedulerTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
  const settings = getAppSettings();

  // Stage 27 — master kill switch first, then this tick's own switch. A false per-tick flag is
  // reported as the same SKIPPED_DISABLED outcome, so nothing downstream has to learn a new state.
  if (!isEnabled(settings.scheduler) || !settings.scheduler.scanEnabled) {
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

    // Connector Reliability phase — explicit and separate from every phase above, on its own
    // independent cadence (RELIABILITY_INTERVAL_MINUTES), same isolation pattern as maintenance
    // just above (own try/catch, own started/completed bookkeeping, never lets a failure here turn
    // an already-successful scan+matching+notifications+maintenance result into a FAILED tick).
    // Only ever reads scan-produced health state and creates/refreshes proposals; never calls
    // runScan, never touches lifecycle maintenance, never touches external-signals ingestion.
    let reliability: RecoveryControllerSummary | null = null;
    let reliabilityError: string | undefined;
    if (isIntervalDue(getLastReliabilityRunStartedAt(), RELIABILITY_INTERVAL_MINUTES, now)) {
      recordReliabilityRunStarted(now);
      try {
        reliability = await runConnectorRecovery();
      } catch (err) {
        reliabilityError = err instanceof Error ? err.message : String(err);
      } finally {
        recordReliabilityRunCompleted();
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
      reliability,
      ...(reliabilityError ? { reliabilityError } : {}),
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
