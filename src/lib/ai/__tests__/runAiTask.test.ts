import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { z } from "zod";
import type { NormalizedJob } from "../../../types";
import type { AiTaskDefinition } from "../types";
import { FakeProvider } from "./testHelpers";

/**
 * runAiTask end-to-end: every non-throwing failure mode, the success path, cache hit/miss, the
 * malformed-output repair loop, usage/audit logging for each outcome, the load-bearing test that
 * Phase 1's deterministic job data is byte-identical before and after every AI failure mode, and —
 * the identity-safety fix — that AI history stays correctly associated with the STABLE entity
 * (entity.key, i.e. the job's dedupe_key) even after the underlying job row is deleted and a later,
 * completely unrelated job happens to reuse the same numeric row id. Run with: npm test
 */

let tmpDir: string;
let getDb: typeof import("../../../db/index").getDb;
let createCompany: typeof import("../../../db/queries/companies").createCompany;
let upsertJob: typeof import("../../../db/queries/jobs").upsertJob;
let getJob: typeof import("../../../db/queries/jobs").getJob;
let listJobs: typeof import("../../../db/queries/jobs").listJobs;
let dedupeKeyForAts: typeof import("../../../lib/dedupe").dedupeKeyForAts;
let getAiEnrichment: typeof import("../../../db/queries/aiEnrichments").getAiEnrichment;
let getAiEnrichmentById: typeof import("../../../db/queries/aiEnrichments").getAiEnrichmentById;
let listAiEnrichmentsForEntity: typeof import("../../../db/queries/aiEnrichments").listAiEnrichmentsForEntity;
let getAiUsageSummary: typeof import("../../../db/queries/aiUsage").getAiUsageSummary;
let toSqliteUtcTimestamp: typeof import("../../../db/queries/aiUsage").toSqliteUtcTimestamp;
let registerProvider: typeof import("../provider").registerProvider;
let clearProviders: typeof import("../provider").clearProviders;
let registerTask: typeof import("../tasks/registry").registerTask;
let clearTasksForTests: typeof import("../tasks/registry").clearTasksForTests;
let runAiTask: typeof import("../runAiTask").runAiTask;
let resetSessionCallCountForTests: typeof import("../budget").resetSessionCallCountForTests;
let recordAiUsageDirect: typeof import("../../../db/queries/aiUsage").recordAiUsage;
let BUDGET_LIMITS: typeof import("../budget").BUDGET_LIMITS;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-run-ai-task-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ getDb } = await import("../../../db/index"));
  ({ createCompany } = await import("../../../db/queries/companies"));
  ({ upsertJob, getJob, listJobs } = await import("../../../db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("../../../lib/dedupe"));
  ({ getAiEnrichment, getAiEnrichmentById, listAiEnrichmentsForEntity } = await import("../../../db/queries/aiEnrichments"));
  ({ recordAiUsage: recordAiUsageDirect, getAiUsageSummary, toSqliteUtcTimestamp } = await import("../../../db/queries/aiUsage"));
  ({ registerProvider, clearProviders } = await import("../provider"));
  ({ registerTask, clearTasksForTests } = await import("../tasks/registry"));
  ({ runAiTask } = await import("../runAiTask"));
  ({ resetSessionCallCountForTests, BUDGET_LIMITS } = await import("../budget"));

  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface FakeTaskInput {
  title: string;
  descriptionText: string;
}
interface FakeTaskOutput {
  summary: string;
}

const fakeTask: AiTaskDefinition<FakeTaskInput, FakeTaskOutput> = {
  id: "fake_task",
  version: 1,
  entityType: "job",
  modelTier: "lightweight",
  outputSchema: z.object({ summary: z.string() }).strict(),
  toProviderInput: (input) => ({ title: input.title, descriptionText: input.descriptionText }),
  buildPrompt: (providerInput) => `Summarize: ${providerInput.title}`,
  toCacheKeyInput: (input) => ({ title: input.title, descriptionText: input.descriptionText }),
  deriveConfidence: () => 0.9,
};

beforeEach(() => {
  clearProviders();
  clearTasksForTests();
  resetSessionCallCountForTests();
  delete process.env.CAREER_OPS_AI_ENABLED;
  delete process.env.CAREER_OPS_AI_PROVIDER;
  registerTask(fakeTask);
});

let companyCounter = 0;
function makeCompany() {
  companyCounter++;
  return createCompany({ name: `AI Test Co ${companyCounter}`, source_type: "greenhouse", ats_board_token: `ai-token-${companyCounter}` });
}
function makeNormalizedJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    externalId: "ext-ai-1",
    title: "AI Test Role",
    location: null,
    department: null,
    url: "https://example.com/ai-job",
    descriptionHtml: null,
    descriptionText: "We need a great engineer.",
    employmentType: null,
    workplaceType: null,
    salaryText: null,
    postedAt: null,
    raw: null,
    ...overrides,
  };
}
let reqCounter = 0;
function seedRealJob() {
  reqCounter++;
  const company = makeCompany();
  const dedupeKey = dedupeKeyForAts("greenhouse", company.id, `req-ai-${reqCounter}`);
  upsertJob({
    companyId: company.id,
    sourceType: "greenhouse",
    dedupeKey,
    job: makeNormalizedJob(),
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  const jobId = listJobs({ companyId: company.id }).find((j) => j.dedupe_key === dedupeKey)!.id;
  return { jobId, dedupeKey, snapshot: getJob(jobId)! };
}

// --- Unknown task id ---------------------------------------------------------------------------

test("an unknown task id throws immediately — a programming error, not a normal 'unavailable' outcome", async () => {
  await assert.rejects(() => runAiTask("no_such_task", { type: "job", id: 1, key: "job:dedupe:1" }, {}), /Unknown AI task id/);
});

// --- AI disabled / missing credentials ----------------------------------------------------------

test("AI disabled: no CAREER_OPS_AI_ENABLED set -> unavailable/disabled, no provider ever touched", async () => {
  const result = await runAiTask<FakeTaskOutput>("fake_task", { type: "job", id: 1, key: "job:dedupe:1" }, { title: "x", descriptionText: "y" });
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.equal(result.reason, "disabled");

  const usage = getAiUsageSummary(toSqliteUtcTimestamp(new Date(Date.now() - 60_000)), "fake_task");
  assert.ok(usage.callCount >= 1, "a usage-log row must still be written for a pre-call short-circuit");
});

test("missing credentials: enabled but no provider selected -> unavailable/missing_credentials", async () => {
  process.env.CAREER_OPS_AI_ENABLED = "true";
  const result = await runAiTask<FakeTaskOutput>("fake_task", { type: "job", id: 1, key: "job:dedupe:1" }, { title: "x", descriptionText: "y" });
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.equal(result.reason, "missing_credentials");
});

test("missing credentials: describeModel returning null for this tier -> unavailable/missing_credentials, provider.generate never called", async () => {
  const provider = new FakeProvider({ name: "no-tier", steps: [{ raw: { summary: "s" } }], modelByTier: { lightweight: null } });
  registerProvider(provider);
  process.env.CAREER_OPS_AI_ENABLED = "true";
  process.env.CAREER_OPS_AI_PROVIDER = "no-tier";

  const result = await runAiTask<FakeTaskOutput>("fake_task", { type: "job", id: 1, key: "job:dedupe:1" }, { title: "x", descriptionText: "y" });
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.equal(result.reason, "missing_credentials");
  assert.equal(provider.callCount, 0, "generate() must never be reached when describeModel resolves to null");
});

// --- Success + cache -----------------------------------------------------------------------------

test("provider success: returns validated output with confidence, persists an enrichment, records a 'generated' audit event", async () => {
  const provider = new FakeProvider({
    name: "success-fake",
    steps: [{ raw: { summary: "great role" }, usage: { inputTokens: 20, outputTokens: 10 } }],
  });
  registerProvider(provider);
  process.env.CAREER_OPS_AI_ENABLED = "true";
  process.env.CAREER_OPS_AI_PROVIDER = "success-fake";

  const result = await runAiTask<FakeTaskOutput>(
    "fake_task",
    { type: "job", id: 101, key: "job:dedupe:101" },
    { title: "Engineer", descriptionText: "desc" }
  );
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.data.summary, "great role");
  assert.equal(result.cached, false);
  assert.equal(result.confidence?.band, "high");
  assert.ok(Math.abs((result.confidence?.value ?? 0) - 0.9) < 1e-9);

  const stored = getAiEnrichment({
    entityType: "job",
    entityKey: "job:dedupe:101",
    task: "fake_task",
    taskVersion: 1,
    contentHash: (
      await import("../contentHash")
    ).hashCacheKeyInput({ title: "Engineer", descriptionText: "desc" }),
    provider: "success-fake",
    modelId: provider.describeModel("lightweight")!.modelId,
  });
  assert.ok(stored, "a successful call must persist an ai_enrichments row");
  assert.equal(stored!.output_json, JSON.stringify({ summary: "great role" }));
  assert.equal(stored!.entity_id, 101, "entity_id is stored as convenience metadata");
  assert.equal(stored!.entity_key, "job:dedupe:101", "entity_key is the row's real identity");
  assert.equal(result.enrichmentId, stored!.id, "the returned enrichmentId must match the exact row that was persisted");
});

test("cache hit: an identical second call never reaches the provider again", async () => {
  const provider = new FakeProvider({ name: "cache-fake", steps: [{ raw: { summary: "cached" } }] });
  registerProvider(provider);
  process.env.CAREER_OPS_AI_ENABLED = "true";
  process.env.CAREER_OPS_AI_PROVIDER = "cache-fake";

  const entity = { type: "job" as const, id: 102, key: "job:dedupe:102" };
  const input = { title: "Engineer", descriptionText: "desc" };

  const first = await runAiTask<FakeTaskOutput>("fake_task", entity, input);
  assert.equal(first.status, "ok");
  assert.equal(provider.callCount, 1);

  const second = await runAiTask<FakeTaskOutput>("fake_task", entity, input);
  assert.equal(second.status, "ok");
  if (second.status === "ok" && first.status === "ok") {
    assert.equal(second.cached, true);
    assert.equal(second.data.summary, "cached");
    assert.equal(second.enrichmentId, first.enrichmentId, "a cache hit must return the SAME enrichmentId as the original generation, never a new one");
  }
  assert.equal(provider.callCount, 1, "a cache hit must never call the provider again");
});

// --- Malformed output / repair --------------------------------------------------------------------

test("malformed output once, valid on the repair retry: succeeds using the repaired response", async () => {
  const provider = new FakeProvider({
    name: "repair-fake",
    steps: [
      { raw: { wrong_shape: true }, usage: { inputTokens: 10, outputTokens: 5 } },
      { raw: { summary: "repaired" }, usage: { inputTokens: 15, outputTokens: 8 } },
    ],
  });
  registerProvider(provider);
  process.env.CAREER_OPS_AI_ENABLED = "true";
  process.env.CAREER_OPS_AI_PROVIDER = "repair-fake";

  const result = await runAiTask<FakeTaskOutput>(
    "fake_task",
    { type: "job", id: 103, key: "job:dedupe:103" },
    { title: "x", descriptionText: "y" }
  );
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.equal(result.data.summary, "repaired");
  assert.equal(provider.callCount, 2, "must call exactly twice: the original attempt, then one repair attempt");
});

test("repeated malformed output: fails closed after the repair retry, nothing persisted, real cost still logged", async () => {
  const provider = new FakeProvider({
    name: "always-malformed-fake",
    steps: [{ raw: { wrong_shape: true }, usage: { inputTokens: 10, outputTokens: 5 } }],
  });
  registerProvider(provider);
  process.env.CAREER_OPS_AI_ENABLED = "true";
  process.env.CAREER_OPS_AI_PROVIDER = "always-malformed-fake";

  const entity = { type: "job" as const, id: 104, key: "job:dedupe:104" };
  const input = { title: "x", descriptionText: "y" };
  const result = await runAiTask<FakeTaskOutput>("fake_task", entity, input);

  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.equal(result.reason, "invalid_response");
  assert.equal(provider.callCount, 2, "exactly one repair attempt, never more");

  const { hashCacheKeyInput } = await import("../contentHash");
  const stored = getAiEnrichment({
    entityType: "job",
    entityKey: "job:dedupe:104",
    task: "fake_task",
    taskVersion: 1,
    contentHash: hashCacheKeyInput(input),
    provider: "always-malformed-fake",
    modelId: provider.describeModel("lightweight")!.modelId,
  });
  assert.equal(stored, undefined, "a permanently malformed response must never be persisted");

  const row = getDb()
    .prepare("SELECT * FROM ai_usage_log WHERE task = 'fake_task' AND provider = 'always-malformed-fake' ORDER BY id DESC LIMIT 1")
    .get() as Record<string, unknown>;
  assert.equal(row.success, 0);
  assert.equal(row.error_category, "schema_validation_failed");
  assert.equal(row.input_tokens, 20, "real combined tokens from both attempts must be logged, not null");
  assert.equal(row.output_tokens, 10);
  assert.ok((row.estimated_cost_usd as number) > 0, "a schema failure still consumed real tokens and must log a real, non-zero cost");
});

// --- Provider/transient failure --------------------------------------------------------------------

test("provider failure after retry exhaustion: unavailable/provider_error, null cost logged (no response was ever usable)", async () => {
  const provider = new FakeProvider({ name: "flaky-fake", steps: [{ error: "provider_5xx" }] });
  registerProvider(provider);
  process.env.CAREER_OPS_AI_ENABLED = "true";
  process.env.CAREER_OPS_AI_PROVIDER = "flaky-fake";

  const result = await runAiTask<FakeTaskOutput>(
    "fake_task",
    { type: "job", id: 105, key: "job:dedupe:105" },
    { title: "x", descriptionText: "y" }
  );
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.equal(result.reason, "provider_error");

  const row = getDb()
    .prepare("SELECT * FROM ai_usage_log WHERE task = 'fake_task' AND provider = 'flaky-fake' ORDER BY id DESC LIMIT 1")
    .get() as Record<string, unknown>;
  assert.equal(row.success, 0);
  assert.equal(row.error_category, "provider_5xx");
  assert.equal(row.input_tokens, null, "no response was ever received — tokens/cost must be null, not zero");
  assert.equal(row.estimated_cost_usd, null);
});

// --- Budget exceeded -----------------------------------------------------------------------------

test("budget exceeded: unavailable/budget_exceeded, provider never called", async () => {
  const provider = new FakeProvider({ name: "budget-fake", steps: [{ raw: { summary: "should not be called" } }] });
  registerProvider(provider);
  process.env.CAREER_OPS_AI_ENABLED = "true";
  process.env.CAREER_OPS_AI_PROVIDER = "budget-fake";

  // Exhaust the session call-count cap directly, the simplest deterministic way to force a block.
  for (let i = 0; i < BUDGET_LIMITS.perSessionCalls; i++) {
    recordAiUsageDirect({
      task: "unrelated",
      provider: "x",
      modelId: "y",
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: 0,
      cacheHit: false,
      success: true,
      errorCategory: null,
      latencyMs: 1,
    });
  }
  const { recordSessionCall } = await import("../budget");
  for (let i = 0; i < BUDGET_LIMITS.perSessionCalls; i++) recordSessionCall();

  const result = await runAiTask<FakeTaskOutput>(
    "fake_task",
    { type: "job", id: 106, key: "job:dedupe:106" },
    { title: "x", descriptionText: "y" }
  );
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.equal(result.reason, "budget_exceeded");
  assert.equal(provider.callCount, 0, "the provider must never be called once budget is exhausted");

  resetSessionCallCountForTests();
});

// --- The load-bearing guarantee: deterministic Career-Ops data is unaffected by every AI outcome ---

test("deterministic job data is byte-identical before and after every AI failure mode", async () => {
  const { jobId, dedupeKey, snapshot } = seedRealJob();
  const entity = { type: "job" as const, id: jobId, key: dedupeKey };

  async function assertJobUnchanged(label: string) {
    const after = getJob(jobId)!;
    assert.deepEqual(after, snapshot, `job row must be unchanged after: ${label}`);
  }

  // 1. disabled
  await runAiTask("fake_task", entity, { title: "x", descriptionText: "y" });
  await assertJobUnchanged("AI disabled");

  // 2. missing credentials
  process.env.CAREER_OPS_AI_ENABLED = "true";
  await runAiTask("fake_task", entity, { title: "x", descriptionText: "y" });
  await assertJobUnchanged("missing credentials");

  // 3. provider transient failure, retries exhausted
  const flaky = new FakeProvider({ name: "det-flaky", steps: [{ error: "network" }] });
  registerProvider(flaky);
  process.env.CAREER_OPS_AI_PROVIDER = "det-flaky";
  await runAiTask("fake_task", entity, { title: "x", descriptionText: "y2" });
  await assertJobUnchanged("provider failure after retry exhaustion");

  // 4. repeated malformed output
  const malformed = new FakeProvider({ name: "det-malformed", steps: [{ raw: { nope: true } }] });
  registerProvider(malformed);
  process.env.CAREER_OPS_AI_PROVIDER = "det-malformed";
  await runAiTask("fake_task", entity, { title: "x", descriptionText: "y3" });
  await assertJobUnchanged("repeated malformed output");

  // 5. a successful AI call itself must ALSO never touch the deterministic job row — AI output is
  // additive, stored only in ai_enrichments, never written back onto `jobs`.
  const success = new FakeProvider({ name: "det-success", steps: [{ raw: { summary: "fine" } }] });
  registerProvider(success);
  process.env.CAREER_OPS_AI_PROVIDER = "det-success";
  const okResult = await runAiTask("fake_task", entity, { title: "x", descriptionText: "y4" });
  assert.equal(okResult.status, "ok");
  await assertJobUnchanged("a successful AI call");

  delete process.env.CAREER_OPS_AI_ENABLED;
  delete process.env.CAREER_OPS_AI_PROVIDER;
});

// --- Identity safety: entity_key survives job deletion + numeric id reuse ------------------------

test("identity safety: AI history stays associated with the original job even after it's deleted and a new, unrelated job reuses its numeric id", async () => {
  const provider = new FakeProvider({
    name: "identity-fake",
    steps: [
      { raw: { summary: "belongs to the ORIGINAL job" } },
      { raw: { summary: "belongs to the NEW, unrelated job" } },
    ],
  });
  registerProvider(provider);
  process.env.CAREER_OPS_AI_ENABLED = "true";
  process.env.CAREER_OPS_AI_PROVIDER = "identity-fake";

  // Step 1: job AI result created for a real, seeded job.
  const original = seedRealJob();
  const originalEntity = { type: "job" as const, id: original.jobId, key: original.dedupeKey };
  const originalInput = { title: "Original Role", descriptionText: "original description" };

  const firstResult = await runAiTask<FakeTaskOutput>("fake_task", originalEntity, originalInput);
  assert.equal(firstResult.status, "ok");
  if (firstResult.status === "ok") assert.equal(firstResult.data.summary, "belongs to the ORIGINAL job");

  // Step 2: the underlying job is deleted (mirrors markNotInterested / the age-based sweep — a
  // direct row delete either way; jobs.id has no ON DELETE CASCADE relationship to ai_enrichments,
  // by design, so the AI history is expected to survive this untouched).
  getDb().prepare("DELETE FROM jobs WHERE id = ?").run(original.jobId);
  assert.equal(getJob(original.jobId), undefined, "test precondition: the original job row must actually be gone");

  // Step 3: a genuinely different, unrelated job is created and — simulating SQLite's real rowid
  // reuse behavior deterministically rather than relying on incidental engine internals — is forced
  // to land on the EXACT SAME numeric id the deleted job used to have.
  const replacement = seedRealJob();
  assert.notEqual(replacement.dedupeKey, original.dedupeKey, "test precondition: the new job must be a genuinely different requisition");
  getDb().prepare("UPDATE jobs SET id = ? WHERE id = ?").run(original.jobId, replacement.jobId);
  const reusedId = original.jobId; // now the new, unrelated job's actual row id
  const newJobRow = getJob(reusedId)!;
  assert.equal(newJobRow.dedupe_key, replacement.dedupeKey, "the row at the reused id must be the NEW job, identified by its own dedupe_key");

  const newEntity = { type: "job" as const, id: reusedId, key: replacement.dedupeKey };
  const newInput = { title: "New Role", descriptionText: "new description" };

  // Step 4 (the actual safety property): a cache lookup for the new entity, at the SAME numeric id
  // the old entity used to occupy, must NOT return the old entity's cached result — even if, as
  // here, the two jobs' AI inputs happen to differ (proving it's a genuine cache MISS driven by
  // entity_key, not merely a content-hash difference that would have missed regardless).
  const secondResult = await runAiTask<FakeTaskOutput>("fake_task", newEntity, newInput);
  assert.equal(secondResult.status, "ok");
  if (secondResult.status === "ok") {
    assert.equal(secondResult.cached, false, "the new entity must never get a cache hit off the old entity's row");
    assert.equal(secondResult.data.summary, "belongs to the NEW, unrelated job");
  }
  assert.equal(provider.callCount, 2, "the provider must genuinely have been called again for the new entity, not served from cache");

  // Step 5: the ORIGINAL entity's history remains fully intact and reachable by its own stable key,
  // completely unaffected by the job row's deletion or the numeric id being reused.
  const originalHistory = listAiEnrichmentsForEntity("job", original.dedupeKey);
  assert.equal(originalHistory.length, 1);
  assert.equal(originalHistory[0].output_json, JSON.stringify({ summary: "belongs to the ORIGINAL job" }));
  assert.equal(originalHistory[0].entity_id, original.jobId, "entity_id is preserved as a historical breadcrumb even though the row it once pointed to no longer holds this entity");

  // And the new entity's own history is separate and correct.
  const newHistory = listAiEnrichmentsForEntity("job", replacement.dedupeKey);
  assert.equal(newHistory.length, 1);
  assert.equal(newHistory[0].output_json, JSON.stringify({ summary: "belongs to the NEW, unrelated job" }));

  delete process.env.CAREER_OPS_AI_ENABLED;
  delete process.env.CAREER_OPS_AI_PROVIDER;
});

// --- enrichmentId correlation survives everything that could otherwise make "latest for this
// entity" ambiguous: a JD change, a different provider, and a later enrichment being generated ----

test("enrichmentId correctly distinguishes two generations for the SAME entity across a content change and a provider change, even after a third is generated", async () => {
  const entity = { type: "job" as const, id: 200, key: "job:dedupe:200" };

  const providerA = new FakeProvider({ name: "provider-a", steps: [{ raw: { summary: "generation A" } }] });
  registerProvider(providerA);
  process.env.CAREER_OPS_AI_ENABLED = "true";
  process.env.CAREER_OPS_AI_PROVIDER = "provider-a";
  const genA = await runAiTask<FakeTaskOutput>("fake_task", entity, { title: "x", descriptionText: "version 1" });
  assert.equal(genA.status, "ok");

  // A different provider (simulating a later config change) generates a second result for the
  // SAME entity, with different content — a genuinely distinct row.
  const providerB = new FakeProvider({ name: "provider-b", steps: [{ raw: { summary: "generation B" } }] });
  registerProvider(providerB);
  process.env.CAREER_OPS_AI_PROVIDER = "provider-b";
  const genB = await runAiTask<FakeTaskOutput>("fake_task", entity, { title: "x", descriptionText: "version 2 - JD changed" });
  assert.equal(genB.status, "ok");

  // A third generation happens later still.
  const providerC = new FakeProvider({ name: "provider-c", steps: [{ raw: { summary: "generation C" } }] });
  registerProvider(providerC);
  process.env.CAREER_OPS_AI_PROVIDER = "provider-c";
  const genC = await runAiTask<FakeTaskOutput>("fake_task", entity, { title: "x", descriptionText: "version 3 - JD changed again" });
  assert.equal(genC.status, "ok");

  if (genA.status !== "ok" || genB.status !== "ok" || genC.status !== "ok") return;

  // All three enrichmentIds are distinct.
  const ids = new Set([genA.enrichmentId, genB.enrichmentId, genC.enrichmentId]);
  assert.equal(ids.size, 3, "three genuinely different generations must produce three distinct enrichmentIds");

  // An "accept" action captured against genA's id (the exact result a hypothetical user saw at that
  // moment) must be resolvable back to exactly generation A's content — never "latest for this
  // entity" (which would now be generation C).
  const rowA = getAiEnrichmentById(genA.enrichmentId);
  assert.equal(JSON.parse(rowA!.output_json).summary, "generation A");
  const rowLatest = getAiEnrichmentById(genC.enrichmentId);
  assert.equal(JSON.parse(rowLatest!.output_json).summary, "generation C");
  assert.notEqual(genA.enrichmentId, genC.enrichmentId, "acting on genA's captured id must never accidentally resolve to the latest generation");

  delete process.env.CAREER_OPS_AI_ENABLED;
  delete process.env.CAREER_OPS_AI_PROVIDER;
});
