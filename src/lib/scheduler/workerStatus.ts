import fs from "node:fs";
import path from "node:path";
import { describeSchedulerHost, getConfiguredSchedulerHost, type SchedulerHost } from "./host";
import type { TickName, TickRuntimeState } from "./workerScheduler";

/**
 * Stage 29 — reads the background worker's own status file so Operations can say what is running.
 *
 * Deliberately a plain read with no inference: when the worker is not running, or its status file is
 * missing or unreadable, this reports `running: false` and leaves the detail null rather than
 * guessing. It never estimates an ETA, and never claims a tick is running because it "should" be.
 */

export const STATUS_FILENAME = "background-worker-status.json";
export const LOCK_FILENAME = "background-worker.lock";

/**
 * How old a status line may be before the DETAIL is described as stale.
 *
 * Stage 30.1 — this no longer decides whether the worker is running. A synchronous heavy tick (a
 * scan or an ingestion pass) blocks the worker's event loop, so its own status timer cannot fire
 * while that tick runs; the file legitimately stops being refreshed even though the process is
 * perfectly alive and doing exactly what it should. Liveness is decided by the process and its lock,
 * which is what "running" actually means; this threshold only governs how much to trust the
 * activity detail alongside it.
 */
const STATUS_STALE_AFTER_MS = 3 * 60_000;

export interface BackgroundWorkerStatus {
  running: boolean;
  schedulerHost: SchedulerHost;
  schedulerHostDescription: string;
  pid: number | null;
  startedAt: string | null;
  lastStatusAt: string | null;
  /** WRITER / EVALUATION / SCAN / PRODUCTION / IDLE, straight from the worker. */
  currentActivity: TickName | "IDLE" | null;
  heavySlotHeldBy: TickName | null;
  ticks: Record<string, TickRuntimeState> | null;
  /** True when the worker is alive but its last status write is older than the staleness window —
   *  normal while a synchronous heavy tick holds the event loop. The activity detail is then a
   *  snapshot from `lastStatusAt`, not a live reading. */
  statusStale: boolean;
  sourceRevision: string | null;
  contractVersion: string | null;
  runtimeLoadedAt: string | null;
  /** Reported by the worker itself; never inferred from workflow database state. */
  activeWorkflowId: number | null;
  /** Why the status is not live, when it is not. Never a fabricated reason. */
  detail: string;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Reads the worker's own status file. `dataDir` exists so this is testable against a fixture
 * directory; production callers use the default and read the real one.
 */
export function readBackgroundWorkerStatus(now: Date = new Date(), dataDir: string = path.resolve("data")): BackgroundWorkerStatus {
  const statusPath = path.join(dataDir, STATUS_FILENAME);
  const lockPath = path.join(dataDir, LOCK_FILENAME);
  const schedulerHost = getConfiguredSchedulerHost();
  const base = {
    schedulerHost,
    schedulerHostDescription: describeSchedulerHost(),
    pid: null,
    startedAt: null,
    lastStatusAt: null,
    currentActivity: null,
    heavySlotHeldBy: null,
    ticks: null,
    statusStale: false,
    sourceRevision: null,
    contractVersion: null,
    runtimeLoadedAt: null,
    activeWorkflowId: null,
  };

  let raw: string;
  try {
    raw = fs.readFileSync(statusPath, "utf-8");
  } catch {
    return {
      ...base,
      running: false,
      detail:
        schedulerHost === "worker"
          ? "The background worker has never reported status. Start it with `CAREER_OPS_SCHEDULER_HOST=worker npm run background-worker`."
          : "No background worker status file. Scheduled work is not hosted by a separate worker in this configuration.",
    };
  }

  let parsed: Partial<BackgroundWorkerStatus> & { stoppedAt?: string; lastTickAt?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...base, running: false, detail: "The background worker status file is unreadable." };
  }

  const pid = typeof parsed.pid === "number" ? parsed.pid : null;
  // Stage 30.1 — `lastStatusAt` is the canonical field. `lastTickAt` is accepted as the legacy name a
  // worker started before this fix still writes, so an already-running worker reports correctly
  // without being restarted.
  const lastStatusAt = parsed.lastStatusAt ?? parsed.lastTickAt ?? null;
  const alive = pid !== null && pidIsAlive(pid) && fs.existsSync(lockPath);
  const statusStale =
    alive && (lastStatusAt === null || now.getTime() - new Date(lastStatusAt).getTime() > STATUS_STALE_AFTER_MS);

  // "Running" means the process is alive and owns the lock. It deliberately does NOT depend on how
  // recently the status file was written: reporting a healthy worker as STOPPED because a long
  // synchronous scan stopped its timer firing was the exact defect this fixes.
  const running = Boolean(alive && !parsed.stoppedAt);

  return {
    ...base,
    pid,
    startedAt: parsed.startedAt ?? null,
    lastStatusAt,
    currentActivity: running ? (parsed.currentActivity ?? "IDLE") : null,
    heavySlotHeldBy: running ? (parsed.heavySlotHeldBy ?? null) : null,
    ticks: running ? (parsed.ticks ?? null) : null,
    sourceRevision: typeof parsed.sourceRevision === "string" ? parsed.sourceRevision : null,
    contractVersion: typeof parsed.contractVersion === "string" ? parsed.contractVersion : null,
    runtimeLoadedAt: typeof parsed.runtimeLoadedAt === "string" ? parsed.runtimeLoadedAt : null,
    activeWorkflowId: typeof parsed.activeWorkflowId === "number" ? parsed.activeWorkflowId : null,
    running,
    statusStale,
    detail: parsed.stoppedAt
      ? `The background worker shut down at ${parsed.stoppedAt}.`
      : running && statusStale
      ? `Background worker running (pid ${pid}), but its last status write was ${lastStatusAt ?? "never"} — normal while a long synchronous tick holds the event loop. The activity shown is from that moment, not live.`
      : running
      ? `Background worker running (pid ${pid}).`
      : "The background worker is not running.",
  };
}
