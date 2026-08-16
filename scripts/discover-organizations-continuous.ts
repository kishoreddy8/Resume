import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getDb } from "../src/db";
import { organizationDiscoveryCounts } from "../src/db/queries/organizationDiscovery";
import { runOrganizationDiscoveryBatch } from "../src/lib/discovery/organizationBatch";

const PROJECT_DIR = process.cwd();
const DATA_DIR = path.join(PROJECT_DIR, "data");
const LOCK_PATH = path.join(DATA_DIR, "ats-discovery-worker.lock");
const REPORT_DIR = path.join(DATA_DIR, "discovery-reports");
const REPORT_LOG = path.join(REPORT_DIR, "cohorts.jsonl");
const LATEST_REPORT = path.join(REPORT_DIR, "latest.json");
const BATCH_SIZE = 2000;
const SUCCESS_PAUSE_MS = Number.parseInt(process.env.CAREER_OPS_DISCOVERY_PAUSE_MS ?? "300000", 10);
const MAX_FAILURE_PAUSE_MS = 60 * 60 * 1000;

interface WorkerReport {
  status: "completed" | "failed" | "campaign_complete";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  batchSize: number;
  attempted: number;
  saved: number;
  errors: number;
  searched: number;
  remaining: number;
  domainsVerified: number;
  structuredPending: number;
  structuredApproved: number;
  manifestVerified: boolean;
  errorMessages: string[];
}

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
    fs.writeFileSync(LOCK_PATH, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, {
      flag: "wx",
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const existing = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as { pid?: number };
      if (existing.pid && pidIsAlive(existing.pid)) return false;
    } catch {
      // An unreadable lock cannot identify a live owner and is safe to replace.
    }
    fs.unlinkSync(LOCK_PATH);
    fs.writeFileSync(LOCK_PATH, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, {
      flag: "wx",
    });
    return true;
  }
}

function releaseLock(): void {
  try {
    const existing = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as { pid?: number };
    if (existing.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {
    // Missing/already-replaced locks need no cleanup.
  }
}

function runNpmScript(script: string, args: string[] = []): void {
  const result = spawnSync("/usr/local/bin/npm", ["run", script, ...(args.length ? ["--", ...args] : [])], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PATH: `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${script} exited with status ${result.status ?? "unknown"}`);
}

function connectorCounts(): { approved: number; pending: number } {
  return getDb()
    .prepare(
      `SELECT
         SUM(CASE WHEN review_status = 'APPROVED' THEN 1 ELSE 0 END) AS approved,
         SUM(CASE WHEN review_status = 'PENDING' THEN 1 ELSE 0 END) AS pending
       FROM job_sources
       WHERE provider IN ('greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'adp_wfn',
                          'paylocity', 'icims', 'ukg_pro', 'bamboohr', 'oracle_recruiting_cloud',
                          'workable', 'rippling', 'paycom', 'jazzhr', 'jobvite', 'breezy', 'teamtailor', 'applicantpro', 'pinpoint', 'clearcompany', 'personio', 'applicantstack', 'comeet', 'cats', 'gohire', 'newton', 'silkroad', 'jobdiva', 'taleo', 'adp_rm', 'eightfold', 'cornerstone', 'avature', 'successfactors')`
    )
    .get() as { approved: number; pending: number };
}

function writeReport(report: WorkerReport): void {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.appendFileSync(REPORT_LOG, `${JSON.stringify(report)}\n`, "utf8");
  const temporary = `${LATEST_REPORT}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, LATEST_REPORT);
}

function notify(report: WorkerReport): void {
  const message =
    report.status === "campaign_complete"
      ? `ATS discovery complete: ${report.searched.toLocaleString()} companies searched.`
      : report.status === "completed"
        ? `Cohort saved ${report.saved.toLocaleString()}/${report.attempted.toLocaleString()}. ` +
          `${report.searched.toLocaleString()} searched; ${report.remaining.toLocaleString()} remaining.`
        : `ATS discovery cohort failed. Retrying automatically; ${report.remaining.toLocaleString()} remaining.`;
  spawnSync("/usr/bin/osascript", [
    "-e",
    `display notification ${JSON.stringify(message)} with title "CareerOps ATS discovery"`,
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exportVerifyAndReport(input: Omit<WorkerReport, "structuredApproved" | "structuredPending" | "manifestVerified">): Promise<WorkerReport> {
  try {
    // Review stays a distinct gate from discovery, but newly found supported sources should not
    // wait for a person to launch the bounded validator. Sources with an empty/transient result
    // carry validation evidence and are excluded by its 24-hour cooldown query.
    runNpmScript("validate-pending-connectors", ["--batch-size", "500", "--sample-size", "3", "--concurrency", "3"]);
  } catch (error) {
    // Connector validation is additive. A provider outage must not turn an otherwise completed
    // discovery cohort into a failed/repeated cohort; preserve the error and continue exporting.
    console.error("Post-cohort pending connector validation failed:", error);
  }
  runNpmScript("export-ats-source");
  runNpmScript("verify-ats-source");
  const connectors = connectorCounts();
  return {
    ...input,
    structuredApproved: connectors.approved ?? 0,
    structuredPending: connectors.pending ?? 0,
    manifestVerified: true,
  };
}

async function main(): Promise<void> {
  if (!acquireLock()) {
    console.log("Another CareerOps ATS discovery worker already owns the lock; exiting.");
    return;
  }
  process.on("exit", releaseLock);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  let failurePauseMs = 5 * 60 * 1000;
  while (true) {
    const before = organizationDiscoveryCounts();
    if (before.pending === 0) {
      const now = new Date().toISOString();
      const connectors = connectorCounts();
      try {
        runNpmScript("validate-pending-connectors", ["--batch-size", "500", "--sample-size", "3", "--concurrency", "3"]);
      } catch (error) {
        console.error("Final pending connector validation failed:", error);
      }
      runNpmScript("export-ats-source");
      runNpmScript("verify-ats-source");
      const report: WorkerReport = {
        status: "campaign_complete",
        startedAt: now,
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        batchSize: BATCH_SIZE,
        attempted: 0,
        saved: 0,
        errors: 0,
        searched: before.searched,
        remaining: 0,
        domainsVerified: 0,
        structuredPending: connectors.pending ?? 0,
        structuredApproved: connectors.approved ?? 0,
        manifestVerified: true,
        errorMessages: [],
      };
      writeReport(report);
      notify(report);
      return;
    }

    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    try {
      console.log(`Starting ATS discovery cohort at checkpoint ${before.searched.toLocaleString()}; ${before.pending.toLocaleString()} remaining.`);
      const summary = await runOrganizationDiscoveryBatch({ batchSize: Math.min(BATCH_SIZE, before.pending), useBrowserFallback: false });
      const after = organizationDiscoveryCounts();
      const report = await exportVerifyAndReport({
        status: after.pending === 0 ? "campaign_complete" : "completed",
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        batchSize: BATCH_SIZE,
        attempted: summary.employersAttempted,
        saved: after.searched - before.searched,
        errors: summary.errors.length,
        searched: after.searched,
        remaining: after.pending,
        domainsVerified: summary.domainsVerified,
        errorMessages: summary.errors,
      });
      writeReport(report);
      notify(report);
      console.log(`Cohort complete: ${report.saved.toLocaleString()} saved; ${report.remaining.toLocaleString()} remaining. Next cohort starts after the safety pause.`);
      failurePauseMs = 5 * 60 * 1000;
      if (after.pending === 0) return;
      if (after.pending > 0) await sleep(SUCCESS_PAUSE_MS);
    } catch (error) {
      const after = organizationDiscoveryCounts();
      const connectors = connectorCounts();
      const message = error instanceof Error ? error.message : String(error);
      const report: WorkerReport = {
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        batchSize: BATCH_SIZE,
        attempted: 0,
        saved: after.searched - before.searched,
        errors: 1,
        searched: after.searched,
        remaining: after.pending,
        domainsVerified: 0,
        structuredPending: connectors.pending ?? 0,
        structuredApproved: connectors.approved ?? 0,
        manifestVerified: false,
        errorMessages: [message],
      };
      writeReport(report);
      notify(report);
      console.error(`Cohort failed: ${message}. Retrying after ${Math.round(failurePauseMs / 60000)} minute(s).`);
      await sleep(failurePauseMs);
      failurePauseMs = Math.min(MAX_FAILURE_PAUSE_MS, failurePauseMs * 2);
    }
  }
}

main().catch((error) => {
  console.error("Continuous ATS discovery worker failed:", error);
  process.exit(1);
});
