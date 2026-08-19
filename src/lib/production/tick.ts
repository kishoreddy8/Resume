import { getAppSettings } from "@/db/queries/settings";
import { listScanReadyCompaniesForRotation } from "@/db/queries/organizationRegistry";
import { isEnabled, isIntervalDue, isWithinWindow } from "@/lib/scheduler/window";
import { runProductionCycle } from "./orchestrator";
import { getProductionCycleRuntimeState } from "./state";
import type { ProductionCycleSummary } from "./types";

/**
 * Stage 23 — bounded scheduled production cycles. See listScanReadyCompaniesForRotation's doc
 * comment (src/db/queries/organizationRegistry.ts) for the batch-size math: ~100 companies keeps a
 * single cycle to roughly 6-7 minutes end-to-end against real providers (derived from Stage 22's
 * observed ~0.39 companies/sec ATS-scan throughput plus Built In/Discovery V2/reliability's mostly
 * fixed per-cycle overhead), instead of the ~3h41m+ a full unbounded 981-company run was observed to
 * take.
 */
export const PRODUCTION_CYCLE_BATCH_SIZE = 100;

/**
 * Independent of scheduler.intervalMinutes, which governs the OLD scan+matching+notifications tick
 * (src/lib/scheduler/tick.ts) — the production cycle is a separate system with its own cadence need,
 * following the exact same "fixed, documented, not user-configurable" precedent tick.ts already uses
 * for MAINTENANCE_INTERVAL_MINUTES/RELIABILITY_INTERVAL_MINUTES rather than adding a new settings
 * surface. 15 minutes comfortably exceeds the observed ~6-7 minute per-batch runtime, and fits
 * roughly 8-12 ticks inside a multi-hour early-morning window — enough for ~981 companies / 100 per
 * batch ≈ 10 batches to fully rotate through every scan-ready company well before 7am.
 */
export const PRODUCTION_CYCLE_INTERVAL_MINUTES = 15;

export type ProductionCycleTickOutcome =
  | { outcome: "SKIPPED_DISABLED" }
  | { outcome: "SKIPPED_OUTSIDE_WINDOW" }
  | { outcome: "SKIPPED_INTERVAL_NOT_DUE" }
  | { outcome: "SKIPPED_LOCK_HELD"; heldSince?: string }
  | { outcome: "SKIPPED_NO_COMPANIES" }
  | { outcome: "RAN"; summary: ProductionCycleSummary }
  | { outcome: "FAILED"; error: string };

/**
 * One scheduled production-cycle tick. Reuses the SAME automation window/timezone/enabled settings
 * as the existing scan scheduler (settings.scheduler, via src/lib/scheduler/window.ts's pure
 * isEnabled/isWithinWindow/isIntervalDue checks) — this is the one place a CareerOps operator already
 * configures "when is background automation allowed to run" (including IANA timezone handling, e.g.
 * America/Chicago), so the production cycle honors it too instead of introducing a second, parallel
 * settings surface. Company selection is always the bounded, fair rotation (see
 * listScanReadyCompaniesForRotation) — never the full scan-ready population — so a scheduled tick can
 * never reproduce the ~3h41m unbounded runtime Stage 22 observed.
 *
 * Never throws — every path (disabled, outside window, interval not due, lock held, no companies due,
 * or the cycle itself throwing) resolves to a ProductionCycleTickOutcome, matching runSchedulerTick's
 * own contract so a caller (instrumentation.ts's timer) never needs its own try/catch.
 */
export async function runProductionCycleTick(now: Date = new Date()): Promise<ProductionCycleTickOutcome> {
  const settings = getAppSettings();
  // Stage 27 — master kill switch, then this tick's own switch (see settings.ts schedulerSchema).
  if (!isEnabled(settings.scheduler) || !settings.scheduler.productionEnabled) {
    return { outcome: "SKIPPED_DISABLED" };
  }
  if (!isWithinWindow(now, settings.scheduler)) {
    return { outcome: "SKIPPED_OUTSIDE_WINDOW" };
  }

  const runtime = getProductionCycleRuntimeState();
  if (!isIntervalDue(runtime.lastStartedAt, PRODUCTION_CYCLE_INTERVAL_MINUTES, now)) {
    return { outcome: "SKIPPED_INTERVAL_NOT_DUE" };
  }

  const batch = listScanReadyCompaniesForRotation(PRODUCTION_CYCLE_BATCH_SIZE);
  if (batch.length === 0) {
    return { outcome: "SKIPPED_NO_COMPANIES" };
  }

  try {
    const summary = await runProductionCycle({ atsCompanies: batch }, now);
    return { outcome: "RAN", summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // runProductionCycle's own lease (see orchestrator.ts) is the single source of truth for
    // mutual exclusion — this maps its "already running" throw onto the same SKIPPED_LOCK_HELD
    // outcome shape runSchedulerTick uses, rather than duplicating a second pre-check with its own
    // race window.
    if (message.includes("already running")) {
      return { outcome: "SKIPPED_LOCK_HELD" };
    }
    return { outcome: "FAILED", error: message };
  }
}
