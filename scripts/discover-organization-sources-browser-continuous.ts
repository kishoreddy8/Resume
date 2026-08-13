import fs from "node:fs";
import path from "node:path";
import { runBrowserSourceSecondPassBatch } from "../src/lib/discovery/browserSourceSecondPass";

const PROJECT_DIR = process.cwd();
const DATA_DIR = path.join(PROJECT_DIR, "data");
const LOCK_PATH = path.join(DATA_DIR, "ats-browser-discovery-worker.lock");
const REPORT_DIR = path.join(DATA_DIR, "browser-source-discovery-reports");
const REPORT_LOG = path.join(REPORT_DIR, "batches.jsonl");
const LATEST_REPORT = path.join(REPORT_DIR, "latest.json");
const BATCH_SIZE = 25;
const CONCURRENCY = 1;
const SUCCESS_PAUSE_MS = Number.parseInt(process.env.CAREER_OPS_BROWSER_DISCOVERY_PAUSE_MS ?? "120000", 10);
const IDLE_PAUSE_MS = Number.parseInt(process.env.CAREER_OPS_BROWSER_DISCOVERY_IDLE_MS ?? "300000", 10);
const MAX_FAILURE_PAUSE_MS = 60 * 60 * 1000;

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
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
      const existing = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as { pid?: number };
      if (existing.pid && pidIsAlive(existing.pid)) return false;
    } catch {
      // An unreadable lock cannot prove a live owner.
    }
    fs.unlinkSync(LOCK_PATH);
    fs.writeFileSync(LOCK_PATH, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: "wx" });
    return true;
  }
}

function releaseLock(): void {
  try {
    const existing = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as { pid?: number };
    if (existing.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {
    // Missing or replaced locks need no cleanup.
  }
}

function writeReport(report: Awaited<ReturnType<typeof runBrowserSourceSecondPassBatch>>): void {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.appendFileSync(REPORT_LOG, `${JSON.stringify(report)}\n`);
  const temporary = `${LATEST_REPORT}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(temporary, LATEST_REPORT);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (!acquireLock()) {
    console.log("Another CareerOps browser source-discovery worker owns the lock; exiting.");
    return;
  }
  process.on("exit", releaseLock);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  let failurePauseMs = 5 * 60 * 1000;
  while (true) {
    try {
      const summary = await runBrowserSourceSecondPassBatch({
        batchSize: BATCH_SIZE,
        concurrency: CONCURRENCY,
      });
      if (summary.attempted === 0) {
        console.log("No verified-domain browser candidates are currently eligible; checking again after the idle pause.");
        await sleep(IDLE_PAUSE_MS);
        continue;
      }
      writeReport(summary);
      console.log(
        `Browser batch complete: ${summary.attempted} attempted, ${summary.verified} structured, ` +
          `${summary.needsAdapter} need adapters, ${summary.generic} generic, ` +
          `${summary.unresolved} unresolved, ${summary.failedTemporary} temporary failures.`
      );
      failurePauseMs = 5 * 60 * 1000;
      await sleep(SUCCESS_PAUSE_MS);
    } catch (error) {
      console.error(
        `Browser discovery batch failed: ${error instanceof Error ? error.message : String(error)}. ` +
          `Retrying after ${Math.round(failurePauseMs / 60000)} minute(s).`
      );
      await sleep(failurePauseMs);
      failurePauseMs = Math.min(MAX_FAILURE_PAUSE_MS, failurePauseMs * 2);
    }
  }
}

main().catch((error) => {
  console.error("Continuous browser source-discovery worker failed:", error);
  process.exit(1);
});
