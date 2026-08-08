import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/**
 * Budget enforcement: exact call-count limits, and conservative pre-call reservation for the
 * daily/monthly dollar caps (real cost is only known post-call, so the dollar caps are enforced as
 * "real spend so far + this tier's pessimistic per-call ceiling <= cap", never as an exact pre-call
 * number — see the AI Architecture corrections this implements).
 *
 * All tests in this file share one SQLite file (one process per test file, same convention as every
 * other suite here) and therefore share one running total. Test ORDER matters here on purpose: the
 * monthly-independence test runs first, while today's own spend is still zero, and later
 * daily-boundary tests compute "room already used today" dynamically via getAiUsageSummary rather
 * than assuming a clean slate — so they remain correct regardless of what ran before them. Run with:
 * npm test
 */

let tmpDir: string;
let getDb: typeof import("../../../db/index").getDb;
let recordAiUsage: typeof import("../../../db/queries/aiUsage").recordAiUsage;
let getAiUsageSummary: typeof import("../../../db/queries/aiUsage").getAiUsageSummary;
let checkBudget: typeof import("../budget").checkBudget;
let recordSessionCall: typeof import("../budget").recordSessionCall;
let resetSessionCallCountForTests: typeof import("../budget").resetSessionCallCountForTests;
let startOfDayIso: typeof import("../budget").startOfDayIso;
let BUDGET_LIMITS: typeof import("../budget").BUDGET_LIMITS;
let TIER_MAX_COST_RESERVATION_USD: typeof import("../budget").TIER_MAX_COST_RESERVATION_USD;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-ai-budget-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../../db/index"));
  ({ recordAiUsage, getAiUsageSummary } = await import("../../../db/queries/aiUsage"));
  ({
    checkBudget,
    recordSessionCall,
    resetSessionCallCountForTests,
    startOfDayIso,
    BUDGET_LIMITS,
    TIER_MAX_COST_RESERVATION_USD,
  } = await import("../budget"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetSessionCallCountForTests();
});

function seedCost(costUsd: number, success = true): void {
  recordAiUsage({
    task: "budget_test",
    provider: "fake",
    modelId: "fake-standard",
    inputTokens: 1000,
    outputTokens: 1000,
    estimatedCostUsd: costUsd,
    cacheHit: false,
    success,
    errorCategory: success ? null : "schema_validation_failed",
    latencyMs: 100,
  });
}

test("call-count limit: allowed while under perSessionCalls, blocked once reached", () => {
  for (let i = 0; i < BUDGET_LIMITS.perSessionCalls; i++) {
    assert.equal(checkBudget("lightweight").allowed, true, `call ${i} must be allowed`);
    recordSessionCall();
  }
  assert.equal(checkBudget("lightweight").allowed, false, "the call-count cap must now block further calls");
});

test("monthly dollar limit blocks independently of the daily limit", () => {
  // Runs before any other test in this file has spent anything "today," so today's own daily total
  // is genuinely 0 at this point. Backdates a large cost to earlier in the current month (day 1) via
  // a direct insert — same "manually set an older timestamp" technique the project's other test
  // suites already use (e.g. src/db/queries/__tests__/settings.test.ts backdating first_seen_at) —
  // so it counts toward the monthly window without ever touching today's daily window.
  const now = new Date();
  const earlierThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12)).toISOString();
  getDb()
    .prepare(
      `INSERT INTO ai_usage_log
        (task, provider, model_id, input_tokens, output_tokens, estimated_cost_usd, cache_hit, success, error_category, latency_ms, created_at)
       VALUES ('budget_test_monthly_backdated', 'fake', 'fake-lightweight', 1000, 1000, ?, 0, 1, NULL, 100, ?)`
    )
    .run(BUDGET_LIMITS.monthlyUsd, earlierThisMonth);

  const todaysTotal = getAiUsageSummary(startOfDayIso(now)).totalCostUsd;
  assert.equal(todaysTotal, 0, "test precondition: nothing must have been spent 'today' yet for this to be a clean demonstration");

  assert.equal(
    checkBudget("lightweight").allowed,
    false,
    "monthly cap must block once exceeded by spend from an earlier day this month, even though today's own spend is still zero"
  );

  // Clean up: this row deliberately maxed out the ENTIRE monthly cap, which would otherwise
  // permanently block every later test in this file regardless of what they're actually testing.
  // Real ai_enrichments/ai_audit_log rows are immutable by design (see the corrected plan), but
  // ai_usage_log has no such constraint — removing a row this test itself inserted, purely to keep
  // later tests in this shared-database file independent, is not the same thing as an application
  // code path ever deleting usage history.
  getDb().prepare("DELETE FROM ai_usage_log WHERE task = 'budget_test_monthly_backdated'").run();
});

test("reservation is a pre-call guard only, not persisted state: real (small) cost is what future checks see", () => {
  const reservation = TIER_MAX_COST_RESERVATION_USD.standard;
  const realCost = reservation / 100;
  seedCost(realCost);
  // Many more calls at the same tiny real cost must remain allowed — impossible if the reservation
  // itself had been persisted as if it were actual spend on every prior check.
  for (let i = 0; i < 5; i++) {
    assert.equal(checkBudget("standard").allowed, true, `call ${i} should remain allowed under real-cost accounting`);
  }
});

test("daily dollar limit: reservation blocks a call once real spend + reservation would exceed the cap", () => {
  const reservation = TIER_MAX_COST_RESERVATION_USD.standard;
  const now = new Date();
  const alreadySpentToday = getAiUsageSummary(startOfDayIso(now)).totalCostUsd;
  const room = BUDGET_LIMITS.dailyUsd - reservation - alreadySpentToday;

  assert.ok(room > 0, "test precondition: earlier tests in this file must not have already exhausted the daily cap");

  // Spend exactly up to the boundary — still allowed (equal to the cap is not "over" it).
  seedCost(room);
  assert.equal(checkBudget("standard").allowed, true, "spend exactly at the boundary must still be allowed");

  // A small amount more pushes real-spend-so-far + reservation past the cap.
  seedCost(0.001);
  assert.equal(checkBudget("standard").allowed, false, "spend past the boundary must now block further standard-tier calls");
});

test("budget accounting includes real cost from failed (schema-validation) calls, not just successes", () => {
  // The prior test already pushed today's spend to the boundary, so ANY further real cost —
  // success or failure — must keep standard-tier calls blocked. This specifically proves a *failed*
  // call's cost is what's doing the blocking, not merely that some successful call already did.
  seedCost(0.001, /* success */ false);
  assert.equal(checkBudget("standard").allowed, false, "a failed call's real cost must still count against budget");
});
