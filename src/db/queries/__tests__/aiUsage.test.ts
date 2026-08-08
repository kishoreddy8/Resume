import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/** ai_usage_log query layer: recording and aggregating. Run with: npm test */

let tmpDir: string;
let getDb: typeof import("../../index").getDb;
let recordAiUsage: typeof import("../aiUsage").recordAiUsage;
let getAiUsageSummary: typeof import("../aiUsage").getAiUsageSummary;
let toSqliteUtcTimestamp: typeof import("../aiUsage").toSqliteUtcTimestamp;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-ai-usage-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../index"));
  ({ recordAiUsage, getAiUsageSummary, toSqliteUtcTimestamp } = await import("../aiUsage"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("recordAiUsage persists every field, including null token/cost fields for a pre-call short-circuit", () => {
  recordAiUsage({
    task: "usage_test_disabled",
    provider: null,
    modelId: null,
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
    cacheHit: false,
    success: false,
    errorCategory: "disabled",
    latencyMs: null,
  });

  const row = getDb().prepare("SELECT * FROM ai_usage_log WHERE task = ?").get("usage_test_disabled") as Record<string, unknown>;
  assert.equal(row.provider, null);
  assert.equal(row.input_tokens, null);
  assert.equal(row.estimated_cost_usd, null);
  assert.equal(row.cache_hit, 0);
  assert.equal(row.success, 0);
  assert.equal(row.error_category, "disabled");
});

test("recordAiUsage persists a cache hit at exactly zero cost/tokens, not null", () => {
  recordAiUsage({
    task: "usage_test_cache_hit",
    provider: "fake",
    modelId: "fake-standard",
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    cacheHit: true,
    success: true,
    errorCategory: null,
    latencyMs: 5,
  });

  const row = getDb().prepare("SELECT * FROM ai_usage_log WHERE task = ?").get("usage_test_cache_hit") as Record<string, unknown>;
  assert.equal(row.cache_hit, 1);
  assert.equal(row.estimated_cost_usd, 0, "zero (known, real) is distinct from null (never applicable)");
  assert.equal(row.input_tokens, 0);
});

test("getAiUsageSummary sums real cost across every outcome, counts calls and failures correctly", () => {
  const task = "usage_test_summary";
  const since = toSqliteUtcTimestamp(new Date(Date.now() - 60_000));

  recordAiUsage({ task, provider: "fake", modelId: "m", inputTokens: 10, outputTokens: 10, estimatedCostUsd: 0.5, cacheHit: false, success: true, errorCategory: null, latencyMs: 100 });
  recordAiUsage({ task, provider: "fake", modelId: "m", inputTokens: 10, outputTokens: 10, estimatedCostUsd: 0.25, cacheHit: false, success: false, errorCategory: "schema_validation_failed", latencyMs: 100 });
  recordAiUsage({ task, provider: null, modelId: null, inputTokens: null, outputTokens: null, estimatedCostUsd: null, cacheHit: false, success: false, errorCategory: "budget_exceeded", latencyMs: null });

  const summary = getAiUsageSummary(since, task);
  assert.equal(summary.callCount, 3);
  assert.equal(summary.failureCount, 2);
  assert.equal(summary.totalCostUsd, 0.75, "null-cost rows must contribute 0, not error out or be skipped from callCount");
});

test("getAiUsageSummary filters by task when given one, aggregates globally when not", () => {
  const since = toSqliteUtcTimestamp(new Date(Date.now() - 60_000));
  recordAiUsage({ task: "task_alpha", provider: "fake", modelId: "m", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 1, cacheHit: false, success: true, errorCategory: null, latencyMs: 10 });
  recordAiUsage({ task: "task_beta", provider: "fake", modelId: "m", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 2, cacheHit: false, success: true, errorCategory: null, latencyMs: 10 });

  const alphaOnly = getAiUsageSummary(since, "task_alpha");
  assert.equal(alphaOnly.totalCostUsd, 1);

  const global = getAiUsageSummary(since);
  assert.ok(global.totalCostUsd >= 3, "unfiltered summary must include both tasks' cost");
});

test("getAiUsageSummary excludes rows before the given sinceIso", () => {
  const task = "usage_test_since";
  recordAiUsage({ task, provider: "fake", modelId: "m", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 9, cacheHit: false, success: true, errorCategory: null, latencyMs: 10 });

  const future = toSqliteUtcTimestamp(new Date(Date.now() + 60_000));
  const summary = getAiUsageSummary(future, task);
  assert.equal(summary.callCount, 0, "a since-timestamp in the future must exclude everything logged so far");
});
