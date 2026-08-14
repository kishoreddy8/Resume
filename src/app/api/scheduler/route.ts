import { NextResponse } from "next/server";
import { getAppSettings } from "@/db/queries/settings";
import { getScanLockStatus } from "@/lib/scheduler/lock";
import { getSchedulerRuntimeState } from "@/lib/scheduler/state";
import { nextEligibleRunAt } from "@/lib/scheduler/window";

/**
 * Read-only scheduler status (Phase 4 Stage 1) — user-configurable settings (via the existing
 * generic PATCH /api/settings, which already validates/persists a `scheduler` group with zero route
 * changes) plus program-only runtime/lock state that is never writable through any API. No PATCH
 * handler here on purpose — see src/lib/scheduler/state.ts's module doc comment for why runtime
 * bookkeeping is kept out of any client-writable surface.
 */
export async function GET() {
  const settings = getAppSettings();
  const runtime = getSchedulerRuntimeState();
  const lock = getScanLockStatus();

  return NextResponse.json({
    settings: settings.scheduler,
    runtime,
    lock,
    nextEligibleRunAt: nextEligibleRunAt(settings.scheduler, runtime.lastStartedAt),
  });
}
