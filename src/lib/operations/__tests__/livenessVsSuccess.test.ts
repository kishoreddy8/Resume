import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { classifyNotificationsHealth } from "../healthRules";

/* ================================================================================================
 * ADMIN-OPS-2 — LIVENESS IS NOT SUCCESS.
 *
 * A process can be alive while doing no useful work, or while failing every useful operation. Each
 * test below pins one place where the two were previously collapsed into a single timestamp, so a
 * future Admin console can say "the scheduler is running but has not scanned anything since
 * yesterday" instead of having to choose between those two facts.
 *
 * Everything runs against a temp database. No production data is touched.
 * ============================================================================================== */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let getSchedulerRuntimeState: typeof import("@/lib/scheduler/state").getSchedulerRuntimeState;
let recordSchedulerTickEvaluated: typeof import("@/lib/scheduler/state").recordSchedulerTickEvaluated;
let recordSchedulerTickSucceeded: typeof import("@/lib/scheduler/state").recordSchedulerTickSucceeded;
let recordScanSucceeded: typeof import("@/lib/scheduler/state").recordScanSucceeded;
let resetSchedulerRuntimeStateForTests: typeof import("@/lib/scheduler/state").resetSchedulerRuntimeStateForTests;
let recordResumeWriterPassCompleted: typeof import("@/lib/resumeQuality/writers/writerState").recordResumeWriterPassCompleted;
let recordResumeWriterPassFailed: typeof import("@/lib/resumeQuality/writers/writerState").recordResumeWriterPassFailed;
let getResumeWriterRuntimeState: typeof import("@/lib/resumeQuality/writers/writerState").getResumeWriterRuntimeState;
let resetAppSettings: typeof import("@/db/queries/settings").resetAppSettings;

const T1 = new Date("2026-08-26T10:00:00.000Z");
const T2 = new Date("2026-08-26T11:00:00.000Z");

/** A pass record whose only outcome is the one under test. `attempted` mirrors outcomes. */
function pass(outcome: string) {
  return {
    attempted: 1,
    outcomes: [{ workflowId: 1, candidateId: 1, outcome } as never],
  } as never;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-ops2-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  ({
    getSchedulerRuntimeState,
    recordSchedulerTickEvaluated,
    recordSchedulerTickSucceeded,
    recordScanSucceeded,
    resetSchedulerRuntimeStateForTests,
  } = await import("@/lib/scheduler/state"));
  ({ recordResumeWriterPassCompleted, recordResumeWriterPassFailed, getResumeWriterRuntimeState } = await import(
    "@/lib/resumeQuality/writers/writerState"
  ));
  ({ resetAppSettings } = await import("@/db/queries/settings"));
  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  getDb().prepare("DELETE FROM settings").run();
  resetSchedulerRuntimeStateForTests();
});

// --- Scheduler: evaluation vs useful work -------------------------------------------------------

test("OPS2-LIVE-01: a recent evaluation proves liveness only — it is not scan success", () => {
  recordSchedulerTickEvaluated(T1);
  const state = getSchedulerRuntimeState();
  assert.equal(state.lastEvaluatedAt, T1.toISOString(), "the tick demonstrably ran");
  assert.equal(state.lastScanSucceededAt, null, "but nothing was scanned, and that must stay visible");
  assert.equal(state.lastStartedAt, null);
});

test("OPS2-SCAN-01: a real scan records success evidence distinct from tick success", () => {
  recordSchedulerTickSucceeded(T1);
  recordScanSucceeded(T1);
  const state = getSchedulerRuntimeState();
  assert.equal(state.lastSuccessfulAt, T1.toISOString());
  assert.equal(state.lastScanSucceededAt, T1.toISOString());
});

test("OPS2-SCAN-01b: a tick that found nothing to scan is NOT recorded as a successful scan", () => {
  /* THE DEFECT THIS CLOSES. runSchedulerTick calls recordSchedulerTickSucceeded on the
   * SKIPPED_NO_COMPANIES path, having scanned nothing. That is a legitimate, healthy tick — but with
   * one shared timestamp it made "the scanner last succeeded at 14:02" true of a system that had not
   * fetched a single job all day. Only the real-scan path calls recordScanSucceeded. */
  recordSchedulerTickEvaluated(T1);
  recordSchedulerTickSucceeded(T1);

  const state = getSchedulerRuntimeState();
  assert.equal(state.lastSuccessfulAt, T1.toISOString(), "the tick did succeed as a tick");
  assert.equal(state.lastScanSucceededAt, null, "no scan ran, so there is no scan success to report");
});

test("OPS2-SCAN-02: a later no-op tick cannot overwrite or erase earlier real scan success", () => {
  recordScanSucceeded(T1);
  recordSchedulerTickSucceeded(T2); // a later tick with nothing to do

  const state = getSchedulerRuntimeState();
  assert.equal(state.lastScanSucceededAt, T1.toISOString(), "the real scan's success must survive");
  assert.equal(state.lastSuccessfulAt, T2.toISOString(), "tick-level success moves independently");
});

test("OPS2-SCAN-03: evaluation alone never fabricates started/success evidence", () => {
  recordSchedulerTickEvaluated(T1);
  recordSchedulerTickEvaluated(T2);
  const state = getSchedulerRuntimeState();
  assert.equal(state.lastStartedAt, null, "a skipped tick started no scan");
  assert.equal(state.lastSuccessfulAt, null);
  assert.equal(state.lastScanSucceededAt, null);
  assert.equal(state.lastFailedAt, null, "and a skip is emphatically not a failure");
});

// --- Writer: running vs produced ----------------------------------------------------------------

test("OPS2-WRITER-01: a pass that produced nothing does not record writer success", () => {
  /* A pass that generated no content may have found nothing queued, or had everything skipped or
   * blocked. All legitimate; none of them is the writer having produced a resume. */
  recordResumeWriterPassCompleted({ attempted: 0, outcomes: [] } as never, 120);
  const state = getResumeWriterRuntimeState();
  assert.equal(state.lastCompletedAt !== null, true, "the pass did finish");
  assert.equal(state.lastSuccessAt, null, "but no resume was produced");
});

test("OPS2.1-WRITER-01: every outcome that proves content was generated records writer success", () => {
  /* THE CORRECTED CONTRACT. READY, FAILED and IMPROVEMENT_RUNNING all return from the same point in
   * processOneWorkflow, after the CLI ran successfully — they differ only in what the quality gate
   * then decided. This field measures the WRITER, so all three count. Counting READY alone would
   * report "never succeeded" on an install where every workflow legitimately goes to human review
   * while the writer produced a resume every single pass. */
  for (const outcome of ["READY", "FAILED", "IMPROVEMENT_RUNNING"]) {
    getDb().prepare("DELETE FROM settings").run();
    recordResumeWriterPassCompleted(pass(outcome), 4000, T1);
    assert.equal(
      getResumeWriterRuntimeState().lastSuccessAt,
      T1.toISOString(),
      `${outcome} proves the writer generated content and must count as writer success`
    );
  }
});

test("OPS2.1-WRITER-01b: outcomes where no content was generated are NOT writer success", () => {
  /* Exceptions never reach the product-verdict branch — processOneWorkflow catches them and returns
   * ERROR — so these genuinely mean no resume was produced. */
  for (const outcome of ["TECHNICAL_FAILURE", "ERROR", "SKIPPED_CLAIMED", "BLOCKED_MAX_ATTEMPTS", "SUBSCRIPTION_LIMIT_REACHED", "AUTH_REQUIRED"]) {
    getDb().prepare("DELETE FROM settings").run();
    recordResumeWriterPassCompleted(pass(outcome), 4000, T1);
    assert.equal(
      getResumeWriterRuntimeState().lastSuccessAt,
      null,
      `${outcome} produced no resume and must never read as writer success`
    );
  }
});

test("OPS2.1-WRITER-01c: the field means PRODUCED, not PUBLISHED — and does not claim otherwise", () => {
  /* A gate-rejected best-attempt package is writer success but not a publication. Admin must not
   * read this timestamp as "a resume was published"; that is a workflow-status question. */
  recordResumeWriterPassCompleted(pass("FAILED"), 4000, T1);
  const state = getResumeWriterRuntimeState();
  assert.equal(state.lastSuccessAt, T1.toISOString(), "the writer did produce a resume");
  assert.equal(state.lastOutcome, "COMPLETED", "and the pass itself completed without technical failure");
});

test("OPS2-WRITER-03: a later failure leaves earlier success evidence intact and distinguishable", () => {
  recordResumeWriterPassCompleted(pass("READY"), 4000, T1);
  recordResumeWriterPassFailed("claude cli timed out", T2);

  const state = getResumeWriterRuntimeState();
  assert.equal(state.lastSuccessAt, T1.toISOString(), "the writer really did work once — that fact survives");
  assert.equal(state.lastCompletedAt, T2.toISOString(), "and the failure is the most recent completion");
  assert.equal(state.lastOutcome, "FAILED");
  assert.notEqual(state.lastSuccessAt, state.lastCompletedAt, "success and completion must not collapse");
});

// --- Notifications: evidence, not a lifetime count ----------------------------------------------

test("OPS2-NOTIFY-01: no recent notification evidence cannot report HEALTHY", () => {
  /* The old input was a LIFETIME count, so this card turned green on the first notification ever
   * created and could never turn back. There is no failure evidence for this pipeline anywhere in
   * the database, so the only honest verdicts are HEALTHY (recent output) or NO_DATA. */
  assert.equal(classifyNotificationsHealth({ createdInWindow: 0, everCreated: 0 }), "NO_DATA");
  assert.equal(
    classifyNotificationsHealth({ createdInWindow: 0, everCreated: 5000 }),
    "NO_DATA",
    "output months ago is not evidence of health today"
  );
});

test("OPS2-NOTIFY-01b: recent output is HEALTHY, and the verdict is never a fault", () => {
  assert.equal(classifyNotificationsHealth({ createdInWindow: 3, everCreated: 3 }), "HEALTHY");
  for (const input of [
    { createdInWindow: 0, everCreated: 0 },
    { createdInWindow: 0, everCreated: 10 },
    { createdInWindow: 10, everCreated: 10 },
  ]) {
    const verdict = classifyNotificationsHealth(input);
    assert.notEqual(verdict, "ERROR", "claiming a fault would require failure evidence that is never persisted");
    assert.notEqual(verdict, "WARNING");
  }
});

// --- Reset safety for the new runtime keys ------------------------------------------------------

test("OPS2-RESET-01: the new operational runtime keys survive resetAppSettings", () => {
  const db = getDb();
  recordScanSucceeded(T1);
  recordResumeWriterPassCompleted(pass("READY"), 4000, T1);

  resetAppSettings();

  assert.equal(
    getSchedulerRuntimeState().lastScanSucceededAt,
    T1.toISOString(),
    "scheduler_runtime.last_scan_succeeded_at is operational state, not a user setting"
  );
  assert.equal(
    getResumeWriterRuntimeState().lastSuccessAt,
    T1.toISOString(),
    "resume_writer.last_success_at is operational state, not a user setting"
  );
  const rows = db.prepare("SELECT key FROM settings").all() as { key: string }[];
  assert.ok(rows.some((r) => r.key === "scheduler_runtime.last_scan_succeeded_at"));
  assert.ok(rows.some((r) => r.key === "resume_writer.last_success_at"));
});

test("OPS2-SECRETS-01: the new operational evidence holds timestamps only, no payloads", () => {
  recordScanSucceeded(T1);
  recordResumeWriterPassCompleted(pass("READY"), 4000, T1);

  for (const key of ["scheduler_runtime.last_scan_succeeded_at", "resume_writer.last_success_at"]) {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string };
    assert.match(row.value, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, `${key} must be an ISO timestamp and nothing else`);
  }
});

// --- OPS2.1 checkpoint: the evidence must actually reach a consumer, and must not steer the engine

test("OPS2.1-WRITER-03: writer success evidence is surfaced by getResumeWriterHealth, not collected-and-hidden", async () => {
  /* Evidence nothing reads is the same collected-but-invisible pattern this programme keeps finding
   * (connector_health_check_runs). Pin that this one reaches the health object Admin consumes. */
  const { getResumeWriterHealth } = await import("@/lib/resumeQuality/writers/writerHealth");
  recordResumeWriterPassCompleted(pass("READY"), 4000, T1);

  assert.equal(
    getResumeWriterHealth().lastSuccessAt,
    T1.toISOString(),
    "the API must expose when the writer last produced a resume"
  );

  /* And the two fields move independently: a later failure advances completion while success holds. */
  recordResumeWriterPassFailed("claude cli timed out", T2);
  const after = getResumeWriterHealth();
  assert.equal(after.lastSuccessAt, T1.toISOString(), "success history survives a later failure");
  assert.equal(after.lastPassCompletedAt, T2.toISOString(), "completion tracks the most recent pass");
});

test("OPS2.1-BEHAVIOR-01: the writer tick's scheduling decision reads lastStartedAt, never the new success field", async () => {
  /* The engine DOES read this state object (tick.ts uses lastStartedAt for isIntervalDue), so adding
   * a field here is only safe while no scheduling path consults it. Asserted against source because
   * the seam is which property the decision reads, not an observable behaviour. */
  const fs = await import("node:fs");
  const path = await import("node:path");
  const tick = fs.readFileSync(path.join(process.cwd(), "src/lib/resumeQuality/writers/tick.ts"), "utf8");
  assert.match(tick, /isIntervalDue\(getResumeWriterRuntimeState\(\)\.lastStartedAt/);
  assert.doesNotMatch(tick, /lastSuccessAt/, "observability must never gate whether the writer runs");

  const schedulerTick = fs.readFileSync(path.join(process.cwd(), "src/lib/scheduler/tick.ts"), "utf8");
  assert.doesNotMatch(schedulerTick, /lastScanSucceededAt/, "scan scheduling must not consult scan-success evidence");
});
