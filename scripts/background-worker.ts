import fs from "node:fs";
import path from "node:path";
import { describeSchedulerHost, SCHEDULER_HOST_ENV_VAR, workerProcessOwnsScheduler } from "@/lib/scheduler/host";
import { WorkerScheduler, type TickName } from "@/lib/scheduler/workerScheduler";

/**
 * Stage 28 — CareerOps' background worker process.
 *
 * Runs the SAME four scheduled ticks the Next.js instrumentation has always run — scan, production
 * cycle, job evaluation, resume writer — in their own process, so a long ingestion pass or a
 * multi-second SQLite evaluation scan can no longer block the web server's event loop. Stage 27
 * measured that blocking directly: 99.6% CPU in the web process and HTTP 000 for ~30 minutes.
 *
 * Deliberately NOT a rewrite. It imports runSchedulerTick / runProductionCycleTick /
 * runJobEvaluationTick / runResumeWriterTick unchanged and drives them on the same 60-second check
 * interval, with the same run-once-immediately restart catch-up. Every decision about whether work is
 * actually due — enabled flags, window, timezone, per-tick cadence, leases — still lives inside those
 * functions and is untouched. What changed is only which process calls them.
 *
 * Single-instance, two ways over:
 *   1. Ownership: it refuses to start unless CAREER_OPS_SCHEDULER_HOST=worker, the same value the web
 *      process reads to decide whether to arm its own timers. One value, so both cannot be armed.
 *   2. A pid lockfile with liveness+stale recovery, matching the convention every other continuous
 *      script in this repo already uses (data/*.lock).
 *
 * Beyond that, the existing DB leases remain authoritative, so even a misconfiguration cannot produce
 * two concurrent writer passes or duplicate an approved workflow.
 *
 * Run via: CAREER_OPS_SCHEDULER_HOST=worker npm run background-worker
 */

const DATA_DIR = path.resolve("data");
const LOCK_PATH = path.join(DATA_DIR, "background-worker.lock");
const STATUS_PATH = path.join(DATA_DIR, "background-worker-status.json");

interface LockFile {
  pid: number;
  startedAt: string;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireLock(): boolean {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload: LockFile = { pid: process.pid, startedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(LOCK_PATH, `${JSON.stringify(payload)}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const existing = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as Partial<LockFile>;
      if (existing.pid && pidIsAlive(existing.pid)) return false;
    } catch {
      // Unreadable lock — treat as stale and reclaim below.
    }
    fs.unlinkSync(LOCK_PATH);
    fs.writeFileSync(LOCK_PATH, `${JSON.stringify(payload)}\n`, { flag: "wx" });
    return true;
  }
}

function releaseLock(): void {
  try {
    const existing = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as Partial<LockFile>;
    if (existing.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {
    // Nothing to release.
  }
}

/** Atomic status write, so the operations panel can report the worker without racing a partial file. */
function writeStatus(status: Record<string, unknown>): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATUS_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
    fs.renameSync(tmp, STATUS_PATH);
  } catch {
    // Status reporting must never take the worker down.
  }
}

async function main(): Promise<void> {
  if (!workerProcessOwnsScheduler()) {
    console.error(
      `Refusing to start: ${SCHEDULER_HOST_ENV_VAR} is not "worker".\n` +
        `${describeSchedulerHost()}\n` +
        `Start with: ${SCHEDULER_HOST_ENV_VAR}=worker npm run background-worker`
    );
    process.exitCode = 1;
    return;
  }

  if (!acquireLock()) {
    console.error("Another CareerOps background worker already holds the lock; exiting.");
    process.exitCode = 1;
    return;
  }

  const { runSchedulerTick } = await import("@/lib/scheduler/tick");
  const { runProductionCycleTick } = await import("@/lib/production/tick");
  const { runJobEvaluationTick } = await import("@/lib/match/tick");
  const { runResumeWriterTick } = await import("@/lib/resumeQuality/writers/tick");
  const { closeDbConnection } = await import("@/db");
  const { handleDbFailure } = await import("@/db/health");

  const startedAt = new Date().toISOString();
  let shuttingDown = false;

  console.log(`CareerOps background worker started (pid ${process.pid}). ${describeSchedulerHost()}`);

  // Mirrors instrumentation.ts's own classification: a poisoned SQLite handle is discarded so the
  // next tick gets a healthy one, rather than logging the same error forever. Re-thrown so the
  // scheduler records the failure against the tick that produced it and keeps that tick's own timer
  // alive — one failing subsystem must never stop the others being dispatched.
  const withDbRecovery = (scope: TickName, fn: () => Promise<unknown>) => async () => {
    try {
      return await fn();
    } catch (err) {
      const outcome = handleDbFailure(err, closeDbConnection);
      if (outcome === "unrelated") console.error(`[${scope}] unexpected error:`, err);
      else console.error(`[${scope}] database connection failure; recovery outcome: ${outcome}`);
      throw err;
    }
  };

  /**
   * Stage 29 — each tick now runs on its OWN timer with its own in-flight guard, replacing the single
   * sequential pass that ran the resume writer last, behind a production cycle that routinely exceeds
   * ten minutes. See workerScheduler.ts for why independent dispatch is safe here (better-sqlite3 is
   * synchronous and Node single-threaded, so this changes interleaving, not database concurrency).
   */
  const scheduler = new WorkerScheduler({
    resumeWriter: withDbRecovery("resumeWriter", () => runResumeWriterTick()),
    jobEvaluation: withDbRecovery("jobEvaluation", () => runJobEvaluationTick()),
    scan: withDbRecovery("scan", () => runSchedulerTick()),
    productionCycle: withDbRecovery("productionCycle", () => runProductionCycleTick()),
  });

  const statusTimer = setInterval(() => {
    if (shuttingDown) return;
    const snapshot = scheduler.snapshot();
    writeStatus({
      pid: process.pid,
      startedAt,
      lastTickAt: new Date().toISOString(),
      host: "worker",
      currentActivity: snapshot.currentActivity,
      heavySlotHeldBy: snapshot.heavySlotHeldBy,
      ticks: snapshot.ticks,
    });
  }, 15_000);

  await scheduler.start();

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nCareerOps background worker shutting down (${signal}).`);
    scheduler.stop();
    clearInterval(statusTimer);
    writeStatus({
      pid: process.pid,
      startedAt,
      stoppedAt: new Date().toISOString(),
      host: "worker",
      currentActivity: "IDLE",
      ticks: scheduler.snapshot().ticks,
    });
    releaseLock();
    // In-flight synchronous tick work finishes on its own; the leases it holds go stale and are
    // reclaimed by a later pass, which is the same recovery path a crash already exercises.
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", releaseLock);
}

main().catch((error) => {
  console.error("CareerOps background worker failed to start:", error);
  releaseLock();
  process.exit(1);
});
