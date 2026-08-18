import fs from "node:fs";
import path from "node:path";
import { runGuardedWriterPass } from "@/lib/resumeQuality/writers/writerWorkerCore";

/**
 * Stage 12 — the automatic external-writer worker's process entrypoint. Follows the exact convention
 * already established by scripts/check-connector-health-continuous.ts (singleton lock via atomic
 * wx-create + pid-liveness stale-lock recovery, poll loop with batch/idle pauses and exponential
 * backoff on error, JSONL + atomic-rename latest.json reporting). All actual per-workflow logic
 * (claim, export, invoke Claude CLI, import, review, notify) lives in
 * src/lib/resumeQuality/writers/writerWorkerCore.ts, which this thin wrapper calls every tick — that
 * SAME call is also the startup reconciliation scan, since it's the very first thing this loop does.
 *
 * Stage 26 — this script is no longer REQUIRED for automatic tailoring: the same worker core now runs
 * on the scheduled resume-writer tick inside the app process (src/lib/resumeQuality/writers/tick.ts,
 * registered in src/instrumentation.ts). It is kept as an optional operator tool for draining a
 * backlog on demand, outside the configured automation window, or with the app stopped. It now goes
 * through runGuardedWriterPass, so it shares the machine-wide writer lease with the tick and the two
 * can never invoke Claude concurrently — its own file lock below is retained unchanged as the
 * additional single-instance guard for this process.
 *
 * Run via: npm run resume-writer-worker-continuous
 */

const DATA_DIR = path.resolve("data");
const LOCK_PATH = path.join(DATA_DIR, "resume-writer-worker.lock");
const REPORT_DIR = path.join(DATA_DIR, "resume-writer-worker-reports");
const BATCH_PAUSE_MS = 60_000;
const IDLE_PAUSE_MS = 5 * 60_000;

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
  try {
    fs.writeFileSync(LOCK_PATH, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as { pid?: number };
      if (lock.pid && pidIsAlive(lock.pid)) return false;
    } catch {
      // Stale/unreadable lock — fall through and reclaim.
    }
    fs.unlinkSync(LOCK_PATH);
    fs.writeFileSync(LOCK_PATH, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: "wx" });
    return true;
  }
}

function releaseLock(): void {
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as { pid?: number };
    if (lock.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {
    // No-op.
  }
}

function writeReport(summary: Awaited<ReturnType<typeof runGuardedWriterPass>>): void {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.appendFileSync(path.join(REPORT_DIR, "batches.jsonl"), `${JSON.stringify({ ...summary, at: new Date().toISOString() })}\n`);
  const temp = path.join(REPORT_DIR, `latest.${process.pid}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(summary, null, 2)}\n`);
  fs.renameSync(temp, path.join(REPORT_DIR, "latest.json"));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  if (!acquireLock()) {
    console.log("Another resume-writer worker owns the lock; exiting.");
    return;
  }
  process.on("exit", releaseLock);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  let failurePause = 60_000;
  let firstPass = true;

  while (true) {
    try {
      const summary = await runGuardedWriterPass();
      if (firstPass) {
        console.log(`Startup reconciliation: found ${summary.pending} workflow(s) awaiting writer.`);
        firstPass = false;
      }
      if (!summary.ran) {
        // The scheduled tick (or another operator pass) holds the lease — wait, never run alongside it.
        console.log(`Writer lease held since ${summary.heldSince ?? "unknown"}; waiting.`);
        await sleep(BATCH_PAUSE_MS);
        continue;
      }
      if (summary.attempted === 0) {
        await sleep(IDLE_PAUSE_MS);
        continue;
      }
      writeReport(summary);
      console.log(`Resume writer batch: ${summary.attempted} workflow(s) processed — ${JSON.stringify(summary.outcomes.map((o) => o.outcome))}`);
      failurePause = 60_000;
      await sleep(BATCH_PAUSE_MS);
    } catch (error) {
      console.error(`Resume writer batch failed: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(failurePause);
      failurePause = Math.min(60 * 60_000, failurePause * 2);
    }
  }
}

main().catch((error) => {
  console.error("Continuous resume writer worker failed:", error);
  process.exit(1);
});
