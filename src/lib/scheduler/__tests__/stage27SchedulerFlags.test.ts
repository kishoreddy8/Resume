import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * Stage 27 — per-tick automation flags.
 *
 * The rules that matter more than the feature itself:
 *   - the master switch still overrides everything (nothing runs when it is off)
 *   - each flag gates ONLY its own tick
 *   - an installation with none of these keys set behaves exactly as it did before Stage 27
 *   - and, above all, no flag can cause tailoring to be approved or an application to be submitted
 *
 * Runs against an isolated temp database; the real data/app.db is never opened.
 */

let tmpDbDir: string;
let tmpDataDir: string;

let getAppSettings: typeof import("@/db/queries/settings").getAppSettings;
let updateAppSettings: typeof import("@/db/queries/settings").updateAppSettings;
let runSchedulerTick: typeof import("../tick").runSchedulerTick;
let runProductionCycleTick: typeof import("@/lib/production/tick").runProductionCycleTick;
let runJobEvaluationTick: typeof import("@/lib/match/tick").runJobEvaluationTick;
let runResumeWriterTick: typeof import("@/lib/resumeQuality/writers/tick").runResumeWriterTick;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s27-sched-db-"));
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s27-sched-data-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_GENERATED_DIR = tmpDataDir;
  // Belt and braces: no tick in this file may ever reach a real, billed Claude process.
  process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI = "1";

  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {
      // Ignore.
    }
    global.__careerOpsDb = undefined;
  }

  const { getDb } = await import("@/db/index");
  ({ getAppSettings, updateAppSettings } = await import("@/db/queries/settings"));
  ({ runSchedulerTick } = await import("../tick"));
  ({ runProductionCycleTick } = await import("@/lib/production/tick"));
  ({ runJobEvaluationTick } = await import("@/lib/match/tick"));
  ({ runResumeWriterTick } = await import("@/lib/resumeQuality/writers/tick"));
  getDb();
});

after(() => {
  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {
      // Ignore.
    }
    global.__careerOpsDb = undefined;
  }
  for (const d of [tmpDbDir, tmpDataDir]) {
    if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

/** All four tick outcomes for the current settings. Every tick is designed never to throw. */
async function tickOutcomes(): Promise<Record<string, string>> {
  const now = new Date();
  const [scan, production, evaluation, writer] = await Promise.all([
    runSchedulerTick(now),
    runProductionCycleTick(now),
    runJobEvaluationTick(now),
    runResumeWriterTick(now),
  ]);
  return {
    scan: scan.outcome,
    production: production.outcome,
    evaluation: evaluation.outcome,
    writer: writer.outcome,
  };
}

test("S27-60 an installation with no per-tick keys set reads them all as enabled (behaviour preserved)", () => {
  const settings = getAppSettings();
  assert.equal(settings.scheduler.scanEnabled, true);
  assert.equal(settings.scheduler.productionEnabled, true);
  assert.equal(settings.scheduler.evaluationEnabled, true);
  assert.equal(settings.scheduler.writerEnabled, true);
  // And the master switch is still the shipped default: nothing automates itself on first run.
  assert.equal(settings.scheduler.enabled, false);
});

test("S27-61 master off overrides every per-tick flag", async () => {
  updateAppSettings({
    scheduler: { enabled: false, scanEnabled: true, productionEnabled: true, evaluationEnabled: true, writerEnabled: true },
  });
  const outcomes = await tickOutcomes();
  for (const [name, outcome] of Object.entries(outcomes)) {
    assert.equal(outcome, "SKIPPED_DISABLED", `${name} must not run while the master switch is off`);
  }
});

test("S27-62 each flag gates only its own tick", async () => {
  const ticks = ["scan", "production", "evaluation", "writer"] as const;
  const flagFor = {
    scan: "scanEnabled",
    production: "productionEnabled",
    evaluation: "evaluationEnabled",
    writer: "writerEnabled",
  } as const;

  for (const target of ticks) {
    updateAppSettings({
      scheduler: {
        enabled: true,
        scanEnabled: true,
        productionEnabled: true,
        evaluationEnabled: true,
        writerEnabled: true,
        [flagFor[target]]: false,
      },
    });
    const outcomes = await tickOutcomes();
    assert.equal(outcomes[target], "SKIPPED_DISABLED", `${target} must be disabled by ${flagFor[target]}`);
    for (const other of ticks.filter((t) => t !== target)) {
      assert.notEqual(
        outcomes[other],
        "SKIPPED_DISABLED",
        `${other} must NOT be disabled by ${flagFor[target]} (it reported ${outcomes[other]})`
      );
    }
  }
});

test("S27-63 the writer can be held off while discovery and evaluation run — the staged-rollout case", async () => {
  updateAppSettings({
    scheduler: { enabled: true, scanEnabled: true, productionEnabled: true, evaluationEnabled: true, writerEnabled: false },
  });
  const outcomes = await tickOutcomes();
  assert.equal(outcomes.writer, "SKIPPED_DISABLED", "no Claude invocation may be reachable");
  assert.notEqual(outcomes.evaluation, "SKIPPED_DISABLED", "free local evaluation keeps running");
  assert.notEqual(outcomes.scan, "SKIPPED_DISABLED");
});

test("S27-64 per-tick flags round-trip through settings storage", () => {
  updateAppSettings({
    scheduler: { enabled: true, scanEnabled: false, productionEnabled: true, evaluationEnabled: false, writerEnabled: true },
  });
  const s = getAppSettings().scheduler;
  assert.equal(s.scanEnabled, false);
  assert.equal(s.productionEnabled, true);
  assert.equal(s.evaluationEnabled, false);
  assert.equal(s.writerEnabled, true);
});
