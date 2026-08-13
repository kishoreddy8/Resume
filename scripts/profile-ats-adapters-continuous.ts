import fs from "node:fs";
import path from "node:path";
import { runAdapterProfileBatch } from "../src/lib/ats/adapterProfiler";

const DATA_DIR = path.resolve("data");
const LOCK_PATH = path.join(DATA_DIR, "ats-adapter-profiler-worker.lock");
const REPORT_DIR = path.join(DATA_DIR, "adapter-profiler-reports");
const SUCCESS_PAUSE_MS = 120_000;
const IDLE_PAUSE_MS = 600_000;

function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
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
    } catch { /* Unreadable locks cannot establish a live owner. */ }
    fs.unlinkSync(LOCK_PATH);
    fs.writeFileSync(LOCK_PATH, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: "wx" });
    return true;
  }
}

function releaseLock(): void {
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as { pid?: number };
    if (lock.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch { /* Missing/replaced locks need no cleanup. */ }
}

function writeReport(summary: Awaited<ReturnType<typeof runAdapterProfileBatch>>): void {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.appendFileSync(path.join(REPORT_DIR, "batches.jsonl"), `${JSON.stringify(summary)}\n`);
  const temporary = path.join(REPORT_DIR, `latest.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`);
  fs.renameSync(temporary, path.join(REPORT_DIR, "latest.json"));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  if (!acquireLock()) { console.log("Another ATS adapter profiler owns the lock; exiting."); return; }
  process.on("exit", releaseLock);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  let failurePauseMs = 5 * 60_000;
  while (true) {
    try {
      const summary = await runAdapterProfileBatch({ batchSize: 6, samplesPerProvider: 3, concurrency: 1 });
      if (summary.attempted === 0) { await sleep(IDLE_PAUSE_MS); continue; }
      writeReport(summary);
      console.log(`Adapter profiler: ${summary.attempted} attempted, ${summary.publicEndpointEvidence} endpoint evidence, ` +
        `${summary.pageReachable} reachable, ${summary.blockedOrEmpty} blocked/empty, ${summary.failedTemporary} temporary.`);
      failurePauseMs = 5 * 60_000;
      await sleep(SUCCESS_PAUSE_MS);
    } catch (error) {
      console.error(`Adapter profiler batch failed: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(failurePauseMs);
      failurePauseMs = Math.min(60 * 60_000, failurePauseMs * 2);
    }
  }
}

main().catch((error) => { console.error("Continuous ATS adapter profiler failed:", error); process.exit(1); });
