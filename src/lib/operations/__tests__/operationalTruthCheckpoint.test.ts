import assert from "node:assert/strict";
import { HEALTH_PRESENTATION } from "@/lib/admin/healthPresentation";
import test from "node:test";
import { classifySchedulerHealth, classifySystemHealth, SCHEDULER_TICK_LIVENESS_TIMEOUT_MINUTES } from "../healthRules";
import type { HealthStatus } from "../healthRules";
import { getAtsCapability } from "../atsCapability";
import { automatedSourceTypes } from "@/lib/apply/agent/selectAdapter";
import type { SchedulerRuntimeState } from "@/lib/scheduler/state";
import type { SchedulerSettings } from "@/lib/scheduler/window";
import type { SourceType } from "@/types";

/* ================================================================================================
 * ADMIN-OPS-1.1 CHECKPOINT — adversarial coverage for the cases the implementation phase did not
 * defend: corrupt persisted timestamps, and exhaustive health-to-display mapping.
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

const systemBase = {
  workerRunning: false,
  workerEverReported: false,
  lastEvaluatedAt: null as string | null,
  runtimeCompatibility: "UNKNOWN" as const,
  now: NOW,
};

// --- Corrupt / impossible persisted liveness -----------------------------------------------------

test("OPS1.1-HEALTH-01: an unparseable liveness timestamp never yields HEALTHY", () => {
  /* These values are free text in the `settings` table. NaN arithmetic makes every comparison false,
   * so a naive staleness check reads corrupt data as "not stale" and the caller concludes HEALTHY —
   * a green verdict derived from unreadable data. */
  const corrupt = runtime({ lastEvaluatedAt: "not-a-timestamp" });
  assert.equal(classifySchedulerHealth({ settings: scheduler(), runtime: corrupt, now: NOW }), "NO_DATA");

  const corruptSystem = classifySystemHealth({ ...systemBase, schedulerHost: "web", lastEvaluatedAt: "" });
  assert.equal(corruptSystem, "NO_DATA");
});

test("OPS1.1-HEALTH-01b: a future liveness timestamp is not evidence of a past evaluation", () => {
  const future = new Date(NOW.getTime() + 60 * 60_000).toISOString();
  assert.equal(classifySchedulerHealth({ settings: scheduler(), runtime: runtime({ lastEvaluatedAt: future }), now: NOW }), "NO_DATA");
  assert.equal(classifySystemHealth({ ...systemBase, schedulerHost: "web", lastEvaluatedAt: future }), "NO_DATA");
});

test("OPS1.1-HEALTH-01c: a corrupt timestamp does not fabricate a red alarm either", () => {
  /* Unreadable means unproven in BOTH directions. Reporting ERROR would be just as invented as
   * reporting HEALTHY, and would train an operator to ignore a real ERROR. */
  const corrupt = classifySystemHealth({ ...systemBase, schedulerHost: "web", lastEvaluatedAt: "garbage" });
  assert.notEqual(corrupt, "ERROR");
  assert.notEqual(corrupt, "HEALTHY");
});

test("OPS1.1-SCHED-02: a genuinely stale evaluation is still ERROR after the corrupt-value fix", () => {
  const stale = runtime({
    lastEvaluatedAt: minutesAgo(SCHEDULER_TICK_LIVENESS_TIMEOUT_MINUTES + 1),
    lastSuccessfulAt: minutesAgo(90),
    lastStartedAt: minutesAgo(91),
  });
  assert.equal(classifySchedulerHealth({ settings: scheduler(), runtime: stale, now: NOW }), "ERROR");
});

test("OPS1.1-SYSTEM-02: a disabled scheduler outranks liveness and never reads as a failure", () => {
  /* recordSchedulerTickEvaluated runs BEFORE the enabled check, so a disabled scheduler still has a
   * fresh timestamp. DISABLED must win regardless — an operator switch is not a fault. */
  const disabledButAlive = runtime({ lastEvaluatedAt: minutesAgo(1) });
  assert.equal(classifySchedulerHealth({ settings: scheduler({ enabled: false }), runtime: disabledButAlive, now: NOW }), "DISABLED");

  const disabledAndStale = runtime({ lastEvaluatedAt: minutesAgo(600) });
  assert.equal(classifySchedulerHealth({ settings: scheduler({ enabled: false }), runtime: disabledAndStale, now: NOW }), "DISABLED");
});

test("OPS1.1-SYSTEM-01: web host is judged on tick liveness and never requires a worker", () => {
  const aliveNoWorker = classifySystemHealth({
    ...systemBase,
    schedulerHost: "web",
    workerRunning: false,
    workerEverReported: false,
    lastEvaluatedAt: minutesAgo(1),
  });
  assert.equal(aliveNoWorker, "HEALTHY");
});

// --- OPS1.1-DISPLAY-01: exhaustive presentation mapping -----------------------------------------

const ALL_HEALTH_STATUSES: HealthStatus[] = ["HEALTHY", "WARNING", "ERROR", "DISABLED", "NO_DATA"];

/**
 * UI-ADMIN-1 — these three tests now read an EXPORTED map instead of regexing a local function out
 * of admin/page.tsx.
 *
 * The invariant they protect is unchanged and is the reason they exist: no health state may fall
 * through to a default, and no failure may be drawn in a reassuring tone. What changed is that the
 * page no longer owns a private translation table. It used to, because the API returned bare status
 * enums with no summary, reason or evidence, so the page had to invent presentation for verdicts it
 * could not explain. ADMIN-OPS-5 finished the server contract and the console now renders the five
 * statuses directly, so the mapping is typed, exported and exhaustive by construction — a stronger
 * guarantee than a regex over source could give, and one a new status cannot slip past.
 */
test("OPS1.1-DISPLAY-01: every health state has an explicit presentation — none falls through", () => {
  for (const status of ALL_HEALTH_STATUSES) {
    const presentation = HEALTH_PRESENTATION[status];
    assert.ok(presentation, `${status} has no presentation and would fall through`);
    assert.ok(presentation.label.length > 0, `${status} must render a text label, not colour alone`);
    assert.ok(presentation.symbol.length > 0, `${status} must carry a non-colour symbol`);
    assert.ok(presentation.meaning.length > 0, `${status} must state what it claims`);
  }
});

test("OPS1.1-DISPLAY-01b: each state resolves to a truthful tone", () => {
  const expectedTone: Record<HealthStatus, string> = {
    HEALTHY: "positive",
    WARNING: "warning",
    ERROR: "critical",
    DISABLED: "neutral",
    NO_DATA: "neutral",
  };
  for (const status of ALL_HEALTH_STATUSES) {
    assert.equal(HEALTH_PRESENTATION[status].tone, expectedTone[status], `${status} must not render as another tone`);
  }
});

test("OPS1.1-DISPLAY-01c: no failure state can render with a positive tone", () => {
  for (const status of ["ERROR", "WARNING"] as HealthStatus[]) {
    assert.notEqual(HEALTH_PRESENTATION[status].tone, "positive", `${status} rendering as positive would be a false green`);
  }
  /* NO_DATA is explicitly allowed to be neutral, but never positive. */
  assert.notEqual(HEALTH_PRESENTATION.NO_DATA.tone, "positive");

  /* DISABLED and NO_DATA share the neutral tone, so they must be distinguishable by every other
   * channel — otherwise "switched off" and "never observed" read as the same thing. */
  assert.notEqual(HEALTH_PRESENTATION.DISABLED.label, HEALTH_PRESENTATION.NO_DATA.label);
  assert.notEqual(HEALTH_PRESENTATION.DISABLED.symbol, HEALTH_PRESENTATION.NO_DATA.symbol);
  assert.notEqual(HEALTH_PRESENTATION.DISABLED.meaning, HEALTH_PRESENTATION.NO_DATA.meaning);
});

// --- OPS1.1-ATS: no circular inference -----------------------------------------------------------

test("OPS1.1-ATS-03: recognition is never inferred from the runtime registry", () => {
  /* If recognition were derived from adapter presence it would collapse to the three automated
   * platforms — the opposite of the truth, since detect.ts handles far more than it can automate. */
  const automated = automatedSourceTypes();
  const notAutomated = (["ashby", "icims", "taleo"] as SourceType[]).filter((s) => !automated.includes(s));
  for (const platform of [...automated, ...notAutomated]) {
    assert.equal(
      getAtsCapability(platform).recognition,
      "UNKNOWN",
      `${platform}: recognition must stay UNKNOWN regardless of adapter presence`
    );
  }
});

test("OPS1.1-ATS-01/02: catalogue membership and validation never grant application capability", () => {
  for (const platform of ["ashby", "phenom", "successfactors"] as SourceType[]) {
    const cap = getAtsCapability(platform);
    assert.equal(cap.canAttemptApplication, false);
    assert.equal(cap.validation, "UNKNOWN", "no validation evidence is derivable in this worktree");
  }
  /* And the converse: having an adapter is not validation evidence. */
  assert.equal(getAtsCapability("workday").validation, "UNKNOWN");
});
