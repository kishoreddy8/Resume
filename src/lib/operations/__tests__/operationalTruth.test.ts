import assert from "node:assert/strict";
import test from "node:test";
import { classifySchedulerHealth, classifySystemHealth, SCHEDULER_TICK_LIVENESS_TIMEOUT_MINUTES } from "../healthRules";
import { buildHealth, isStale } from "../subsystemHealth";
import { getAtsCapability, isRealAtsPlatform, summarizeAtsCapabilities } from "../atsCapability";
import { automatedSourceTypes } from "@/lib/apply/agent/selectAdapter";
import type { SchedulerRuntimeState } from "@/lib/scheduler/state";
import type { SchedulerSettings } from "@/lib/scheduler/window";
import type { SourceType } from "@/types";

/* ================================================================================================
 * ADMIN-OPS-1 — OPERATIONAL TRUTH FOUNDATION
 *
 * Every test here exercises a real exported function against real inputs. Nothing regexes source.
 * ============================================================================================== */

const NOW = new Date("2026-08-26T12:00:00.000Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

function scheduler(overrides: Partial<SchedulerSettings> = {}): SchedulerSettings {
  return {
    enabled: true,
    scanEnabled: true,
    productionEnabled: true,
    evaluationEnabled: true,
    writerEnabled: true,
    intervalMinutes: 60,
    windowStartHour: 0,
    windowEndHour: 24,
    timezone: "UTC",
    ...overrides,
  };
}

function runtime(overrides: Partial<SchedulerRuntimeState> = {}): SchedulerRuntimeState {
  return {
    lastEvaluatedAt: null,
    lastStartedAt: null,
    lastScanSucceededAt: null,
    lastCompletedAt: null,
    lastSuccessfulAt: null,
    lastFailedAt: null,
    lastError: null,
    ...overrides,
  };
}

// --- OPS1-HEALTH: the evidence contract ---------------------------------------------------------

test("OPS1-HEALTH-01: a positive verdict cannot be built without evidence", () => {
  assert.throws(
    () =>
      buildHealth({
        status: "HEALTHY",
        summary: "Everything is fine",
        evidence: [],
        observedAt: NOW.toISOString(),
        staleAfterMs: null,
        reasonCode: "FABRICATED",
        repairability: "UNKNOWN",
      }),
    /cites no evidence/,
    "HEALTHY with no observations is the exact inference this phase exists to forbid"
  );
});

test("OPS1-HEALTH-01b: NO_DATA is the only status allowed to be evidence-free", () => {
  const verdict = buildHealth({
    status: "NO_DATA",
    summary: "Nothing has been observed yet.",
    evidence: [],
    observedAt: null,
    staleAfterMs: null,
    reasonCode: "NEVER_OBSERVED",
    repairability: "UNKNOWN",
  });
  assert.equal(verdict.status, "NO_DATA");
});

test("OPS1-HEALTH-02: positive evidence is retained on the verdict, not just summarised", () => {
  const verdict = buildHealth({
    status: "HEALTHY",
    summary: "Scan tick evaluated 30 seconds ago.",
    evidence: [{ label: "lastEvaluatedAt", value: minutesAgo(0.5) }],
    observedAt: minutesAgo(0.5),
    staleAfterMs: 5 * 60_000,
    reasonCode: "TICK_ALIVE",
    repairability: "AUTO_RECOVERABLE",
  });
  assert.equal(verdict.evidence.length, 1);
  assert.equal(verdict.evidence[0].label, "lastEvaluatedAt");
});

test("OPS1-HEALTH-03: stale evidence is distinguishable from current evidence", () => {
  const window = { staleAfterMs: 5 * 60_000 };
  assert.equal(isStale({ observedAt: minutesAgo(1), ...window }, NOW), false, "recent is not stale");
  assert.equal(isStale({ observedAt: minutesAgo(30), ...window }, NOW), true, "old is stale");
});

test("OPS1-HEALTH-03b: never-observed is NOT stale — that is NO_DATA, a different claim", () => {
  assert.equal(isStale({ observedAt: null, staleAfterMs: 5 * 60_000 }, NOW), false);
  assert.equal(isStale({ observedAt: minutesAgo(9999), staleAfterMs: null }, NOW), false, "a non-decaying fact never goes stale");
});

// --- OPS1-SCHED: scheduler truth -----------------------------------------------------------------

test("OPS1-HEALTH-04 / OPS1-SCHED-01: the real default configuration is not falsely degraded", () => {
  /* The shipped default is scheduler.enabled=false (src/lib/settings.ts). That is an operator
   * choice, and it must read as DISABLED — not as a fault, and not as healthy either. */
  assert.equal(classifySchedulerHealth({ settings: scheduler({ enabled: false }), runtime: runtime(), now: NOW }), "DISABLED");
});

test("OPS1-HEALTH-05: enabled-but-never-observed is NO_DATA, never HEALTHY", () => {
  assert.equal(classifySchedulerHealth({ settings: scheduler(), runtime: runtime(), now: NOW }), "NO_DATA");
});

test("OPS1-SCHED-02: a successful evaluation with no work due still counts as liveness", () => {
  /* This is the defect the new lastEvaluatedAt signal closes. The tick evaluated a minute ago and
   * legitimately decided nothing was due, so it has never recorded a scan attempt. That is a
   * working scheduler, and before this signal existed it was indistinguishable from a dead one. */
  const state = runtime({ lastEvaluatedAt: minutesAgo(1), lastStartedAt: null });
  assert.equal(classifySchedulerHealth({ settings: scheduler(), runtime: state, now: NOW }), "HEALTHY");
});

test("OPS1-SCHED-02b: liveness comes from evaluation, not from a scan having run", () => {
  const evaluatedOnly = runtime({ lastEvaluatedAt: minutesAgo(2) });
  const neverEvaluated = runtime({ lastEvaluatedAt: null });
  assert.notEqual(
    classifySchedulerHealth({ settings: scheduler(), runtime: evaluatedOnly, now: NOW }),
    classifySchedulerHealth({ settings: scheduler(), runtime: neverEvaluated, now: NOW })
  );
});

test("OPS1-SCHED-03: a stale evaluation outranks a previously successful scan", () => {
  /* A long-dead scheduler still carries whatever outcome it last recorded. Reporting HEALTHY on the
   * strength of a success from hours ago, while nothing has evaluated since, is precisely the
   * false-positive this ordering prevents. */
  const state = runtime({
    lastEvaluatedAt: minutesAgo(SCHEDULER_TICK_LIVENESS_TIMEOUT_MINUTES + 30),
    lastStartedAt: minutesAgo(120),
    lastCompletedAt: minutesAgo(119),
    lastSuccessfulAt: minutesAgo(119),
  });
  assert.equal(classifySchedulerHealth({ settings: scheduler(), runtime: state, now: NOW }), "ERROR");
});

test("OPS1-SCHED-03b: a real scan failure is still distinguishable from a no-op evaluation", () => {
  const failed = runtime({
    lastEvaluatedAt: minutesAgo(1),
    lastStartedAt: minutesAgo(10),
    lastCompletedAt: minutesAgo(9),
    lastFailedAt: minutesAgo(9),
    lastError: "connector exploded",
  });
  const noop = runtime({ lastEvaluatedAt: minutesAgo(1) });
  assert.equal(classifySchedulerHealth({ settings: scheduler(), runtime: failed, now: NOW }), "ERROR");
  assert.equal(classifySchedulerHealth({ settings: scheduler(), runtime: noop, now: NOW }), "HEALTHY");
});

// --- OPS1-WORKER / system host truth -------------------------------------------------------------

const systemBase = {
  workerRunning: false,
  workerEverReported: false,
  lastEvaluatedAt: null as string | null,
  runtimeCompatibility: "UNKNOWN" as const,
  now: NOW,
};

test("OPS1-SCHED-01b: host=web with a live tick is HEALTHY even though no worker exists", () => {
  /* The headline defect. On the default host the web process owns the ticks and there is
   * deliberately no separate worker, so the old `worker.running ? HEALTHY : DEGRADED` could only
   * ever report DEGRADED on a correctly-configured machine. */
  const status = classifySystemHealth({
    ...systemBase,
    schedulerHost: "web",
    workerRunning: false,
    lastEvaluatedAt: minutesAgo(1),
  });
  assert.equal(status, "HEALTHY");
});

test("OPS1-WORKER-01: a missing worker heartbeat cannot produce a false HEALTHY", () => {
  const status = classifySystemHealth({ ...systemBase, schedulerHost: "worker", workerRunning: false, workerEverReported: true });
  assert.equal(status, "ERROR");
});

test("OPS1-WORKER-01b: a worker that never reported is NO_DATA, not a crash claim", () => {
  const status = classifySystemHealth({ ...systemBase, schedulerHost: "worker", workerRunning: false, workerEverReported: false });
  assert.equal(status, "NO_DATA", "never started and died are different facts");
});

test("OPS1-WORKER-01c: host=worker with a live worker is HEALTHY", () => {
  assert.equal(classifySystemHealth({ ...systemBase, schedulerHost: "worker", workerRunning: true }), "HEALTHY");
});

test("OPS1-HEALTH-04b: host=none is DISABLED, not broken", () => {
  assert.equal(classifySystemHealth({ ...systemBase, schedulerHost: "none" }), "DISABLED");
});

test("OPS1-HEALTH-05b: host=web that has never evaluated is NO_DATA, not HEALTHY", () => {
  assert.equal(classifySystemHealth({ ...systemBase, schedulerHost: "web", lastEvaluatedAt: null }), "NO_DATA");
});

test("OPS1-SCHED-03c: host=web with a stale tick is ERROR", () => {
  const status = classifySystemHealth({
    ...systemBase,
    schedulerHost: "web",
    lastEvaluatedAt: minutesAgo(SCHEDULER_TICK_LIVENESS_TIMEOUT_MINUTES + 10),
  });
  assert.equal(status, "ERROR");
});

test("a runtime MISMATCH is fail-closed and outranks a live host", () => {
  const status = classifySystemHealth({
    ...systemBase,
    schedulerHost: "web",
    lastEvaluatedAt: minutesAgo(1),
    runtimeCompatibility: "MISMATCH",
  });
  assert.equal(status, "ERROR", "the writer refuses work regardless of who is alive");
});

// --- OPS1-CONNECTOR: capability truth ------------------------------------------------------------

test("OPS1-CONNECTOR-01: detection capability is never presented as runtime adapter capability", () => {
  /* `phenom` and `ashby` have no runtime adapter on this branch. Whatever recognition support may
   * exist elsewhere, neither may ever report as automatable. */
  for (const platform of ["ashby", "phenom", "icims"] as SourceType[]) {
    const cap = getAtsCapability(platform);
    assert.equal(cap.automation, "NONE", `${platform} has no runtime adapter`);
    assert.equal(cap.canAttemptApplication, false, `${platform} must never read as auto-apply ready`);
  }
});

test("OPS1-CONNECTOR-02: detection-only platforms cannot be classified as proven auto-apply ready", () => {
  const automated = new Set(automatedSourceTypes());
  const detectionOnly = (["ashby", "icims", "workable", "taleo", "successfactors"] as SourceType[]).filter(
    (s) => !automated.has(s)
  );
  assert.ok(detectionOnly.length > 0, "fixture sanity: these are not automated on this branch");
  for (const platform of detectionOnly) {
    assert.equal(getAtsCapability(platform).canAttemptApplication, false);
  }
});

test("OPS1-CONNECTOR-03: runtime adapter presence and validation evidence remain distinct", () => {
  const workday = getAtsCapability("workday");
  assert.equal(workday.automation, "RUNTIME_ADAPTER", "workday is in the runtime registry");
  assert.equal(workday.canAttemptApplication, true);
  assert.equal(
    workday.validation,
    "UNKNOWN",
    "having an adapter is not evidence that the adapter still matches live markup"
  );
});

test("OPS1-CONNECTOR-03b: automation is read from the engine's own registry, never a parallel list", () => {
  for (const platform of automatedSourceTypes()) {
    assert.equal(getAtsCapability(platform).canAttemptApplication, true, `${platform} is really automatable`);
  }
});

test("OPS1-CONNECTOR-03c: recognition is reported UNKNOWN, not inferred from adapter presence", () => {
  /* The capability registry that would answer recognition is not on this branch. Inferring it from
   * the runtime registry would be circular and would silently shrink recognition to three
   * platforms — the opposite of the truth. */
  assert.equal(getAtsCapability("workday").recognition, "UNKNOWN");
  assert.equal(getAtsCapability("ashby").recognition, "UNKNOWN");
});

test("meta sources are not counted as real ATS platforms", () => {
  assert.equal(isRealAtsPlatform("career_link"), false);
  assert.equal(isRealAtsPlatform("google_jobs"), false);
  assert.equal(isRealAtsPlatform("workday"), true);
});

test("OPS1-CONNECTOR-02b: the summary never reports more automatable platforms than really exist", () => {
  const platforms: SourceType[] = ["workday", "greenhouse", "lever", "ashby", "phenom", "career_link"];
  const counts = summarizeAtsCapabilities(platforms);
  assert.equal(counts.runtimeAdapters, 3, "workday/greenhouse/lever only; career_link excluded as meta");
  assert.equal(counts.validated, 0, "no validation evidence is derivable in this worktree");
  assert.ok(counts.runtimeAdapters <= automatedSourceTypes().length);
});

// --- OPS1-REPAIR ---------------------------------------------------------------------------------

test("OPS1-REPAIR-01: repairability cannot claim a path that does not exist", () => {
  /* There is no worker-restart endpoint in this codebase — a web process cannot spawn an OS
   * process. Classifying it as MANUAL_REPAIR_AVAILABLE would promise a button that cannot exist. */
  const verdict = buildHealth({
    status: "ERROR",
    summary: "The configured background worker is not running.",
    evidence: [{ label: "schedulerHost", value: "worker" }, { label: "workerRunning", value: "false" }],
    observedAt: NOW.toISOString(),
    staleAfterMs: null,
    reasonCode: "WORKER_NOT_RUNNING",
    repairability: "NOT_REPAIRABLE_FROM_ADMIN",
  });
  assert.equal(verdict.repairability, "NOT_REPAIRABLE_FROM_ADMIN");
  assert.notEqual(verdict.repairability, "AUTO_RECOVERABLE");
});

test("OPS1-REPAIR-01b: a configuration state is classified as configuration, not failure", () => {
  const verdict = buildHealth({
    status: "DISABLED",
    summary: "Scheduled work is switched off in Settings.",
    evidence: [{ label: "scheduler.enabled", value: "false" }],
    observedAt: NOW.toISOString(),
    staleAfterMs: null,
    reasonCode: "SCHEDULER_DISABLED",
    repairability: "CONFIGURATION_REQUIRED",
  });
  assert.equal(verdict.status, "DISABLED");
  assert.equal(verdict.repairability, "CONFIGURATION_REQUIRED");
});
