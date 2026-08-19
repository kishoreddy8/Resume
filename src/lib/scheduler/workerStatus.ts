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

const STATUS_PATH = path.join(path.resolve("data"), "background-worker-status.json");
const LOCK_PATH = path.join(path.resolve("data"), "background-worker.lock");

/** A worker that has not written a status line for this long is not considered live. */
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

export function readBackgroundWorkerStatus(now: Date = new Date()): BackgroundWorkerStatus {
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
  };

  let raw: string;
  try {
    raw = fs.readFileSync(STATUS_PATH, "utf-8");
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

  let parsed: Partial<BackgroundWorkerStatus> & { stoppedAt?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...base, running: false, detail: "The background worker status file is unreadable." };
  }

  const pid = typeof parsed.pid === "number" ? parsed.pid : null;
  const lastStatusAt = parsed.lastStatusAt ?? null;
  const alive = pid !== null && pidIsAlive(pid) && fs.existsSync(LOCK_PATH);
  const fresh = lastStatusAt !== null && now.getTime() - new Date(lastStatusAt).getTime() <= STATUS_STALE_AFTER_MS;
  const running = Boolean(alive && fresh && !parsed.stoppedAt);

  return {
    ...base,
    pid,
    startedAt: parsed.startedAt ?? null,
    lastStatusAt,
    currentActivity: running ? (parsed.currentActivity ?? "IDLE") : null,
    heavySlotHeldBy: running ? (parsed.heavySlotHeldBy ?? null) : null,
    ticks: running ? (parsed.ticks ?? null) : null,
    running,
    detail: running
      ? `Background worker running (pid ${pid}).`
      : parsed.stoppedAt
      ? `The background worker shut down at ${parsed.stoppedAt}.`
      : alive
      ? "The background worker process exists but has not reported status recently."
      : "The background worker is not running.",
  };
}
