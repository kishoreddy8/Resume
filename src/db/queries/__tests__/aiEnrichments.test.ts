import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * ai_enrichments query layer: immutability, race-safe insert-or-return-existing, the
 * supersede-is-metadata-only guarantee, and — the identity-safety fix — that entity_key (a stable
 * identity snapshot copied from Phase 1's own authoritative identity), not entity_id (a reusable
 * numeric row id), is what lookup/uniqueness actually uses. Run with: npm test
 */

let tmpDir: string;
let getDb: typeof import("../../index").getDb;
let getAiEnrichment: typeof import("../aiEnrichments").getAiEnrichment;
let insertAiEnrichment: typeof import("../aiEnrichments").insertAiEnrichment;
let markSuperseded: typeof import("../aiEnrichments").markSuperseded;
let listAiEnrichmentsForEntity: typeof import("../aiEnrichments").listAiEnrichmentsForEntity;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-ai-enrichments-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../index"));
  ({ getAiEnrichment, insertAiEnrichment, markSuperseded, listAiEnrichmentsForEntity } = await import("../aiEnrichments"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BASE_KEY = {
  entityType: "job" as const,
  entityKey: "job:dedupe:base",
  entityId: 1,
  task: "test_task",
  taskVersion: 1,
  contentHash: "hash-1",
  provider: "fake",
  modelId: "fake-standard",
};

test("insertAiEnrichment writes a new row when the exact key doesn't exist yet", () => {
  const row = insertAiEnrichment({ ...BASE_KEY, outputJson: JSON.stringify({ v: 1 }) });
  assert.ok(row.id > 0);
  assert.equal(row.status, "active");
  assert.equal(row.output_json, JSON.stringify({ v: 1 }));
  assert.equal(row.entity_key, BASE_KEY.entityKey);
  assert.equal(row.entity_id, BASE_KEY.entityId);

  const fetched = getAiEnrichment(BASE_KEY);
  assert.equal(fetched?.id, row.id);
});

test("immutable: a second insert for the exact same key returns the original row, never overwrites it", () => {
  const key = { ...BASE_KEY, entityKey: "job:dedupe:2", entityId: 2 };
  const first = insertAiEnrichment({ ...key, outputJson: JSON.stringify({ v: "first" }) });
  const second = insertAiEnrichment({ ...key, outputJson: JSON.stringify({ v: "second, should be discarded" }) });

  assert.equal(second.id, first.id);
  assert.equal(second.output_json, JSON.stringify({ v: "first" }), "the first write must win permanently");

  const count = getDb().prepare("SELECT COUNT(*) AS n FROM ai_enrichments WHERE entity_key = ?").get(key.entityKey) as { n: number };
  assert.equal(count.n, 1, "no duplicate row for the same key");
});

test("a different content_hash, task_version, provider, model_id, OR entity_key each independently produces a new row", () => {
  const key = { ...BASE_KEY, entityKey: "job:dedupe:3", entityId: 3 };
  const original = insertAiEnrichment({ ...key, outputJson: JSON.stringify({ v: "original" }) });

  const byHash = insertAiEnrichment({ ...key, contentHash: "hash-2", outputJson: JSON.stringify({ v: "hash" }) });
  const byVersion = insertAiEnrichment({ ...key, taskVersion: 2, outputJson: JSON.stringify({ v: "version" }) });
  const byProvider = insertAiEnrichment({ ...key, provider: "other", outputJson: JSON.stringify({ v: "provider" }) });
  const byModel = insertAiEnrichment({ ...key, modelId: "fake-lightweight", outputJson: JSON.stringify({ v: "model" }) });
  const byEntityKey = insertAiEnrichment({ ...key, entityKey: "job:dedupe:3-alternate", outputJson: JSON.stringify({ v: "entity_key" }) });

  const ids = new Set([original.id, byHash.id, byVersion.id, byProvider.id, byModel.id, byEntityKey.id]);
  assert.equal(ids.size, 6, "each key axis, including entity_key, must independently produce a distinct row");
});

test("identity safety: entity_id is NOT part of the lookup/uniqueness key — same entity_id, different entity_key, never collide", () => {
  const sharedEntityId = 4242; // simulates a numeric row id reused after the original entity was deleted

  const oldEntity = insertAiEnrichment({
    ...BASE_KEY,
    entityKey: "job:dedupe:old-job",
    entityId: sharedEntityId,
    contentHash: "shared-content-hash",
    outputJson: JSON.stringify({ v: "old job's result" }),
  });
  const newEntity = insertAiEnrichment({
    ...BASE_KEY,
    entityKey: "job:dedupe:new-job",
    entityId: sharedEntityId, // same numeric id, genuinely different entity
    contentHash: "shared-content-hash", // even identical content must not matter — different entity_key alone must produce a new row
    outputJson: JSON.stringify({ v: "new job's result" }),
  });

  assert.notEqual(oldEntity.id, newEntity.id, "different entity_key must always produce different rows, regardless of a shared entity_id");
  assert.equal(getAiEnrichment({ ...BASE_KEY, entityKey: "job:dedupe:old-job", contentHash: "shared-content-hash" })!.output_json, JSON.stringify({ v: "old job's result" }));
  assert.equal(getAiEnrichment({ ...BASE_KEY, entityKey: "job:dedupe:new-job", contentHash: "shared-content-hash" })!.output_json, JSON.stringify({ v: "new job's result" }));

  // A lookup keyed only by (implicitly) the old entity_key must never surface the new entity's row,
  // and listAiEnrichmentsForEntity (also entity_key-keyed) must keep each entity's history separate.
  const oldHistory = listAiEnrichmentsForEntity("job", "job:dedupe:old-job");
  const newHistory = listAiEnrichmentsForEntity("job", "job:dedupe:new-job");
  assert.equal(oldHistory.length, 1);
  assert.equal(newHistory.length, 1);
  assert.equal(oldHistory[0].id, oldEntity.id);
  assert.equal(newHistory[0].id, newEntity.id);
});

test("race safety: a row inserted between the pre-check and the write is returned, not duplicated or overwritten", () => {
  const key = { ...BASE_KEY, entityKey: "job:dedupe:race", entityId: 5, contentHash: "race-hash" };

  // Simulate a concurrent writer winning the race: insert directly via raw SQL, bypassing
  // insertAiEnrichment's own pre-check, so insertAiEnrichment's own INSERT below is guaranteed to
  // collide with the unique index rather than simply miss it.
  getDb()
    .prepare(
      `INSERT INTO ai_enrichments
        (entity_type, entity_key, entity_id, task, task_version, content_hash, provider, model_id, output_json)
       VALUES (@entityType, @entityKey, @entityId, @task, @taskVersion, @contentHash, @provider, @modelId, @outputJson)`
    )
    .run({ ...key, outputJson: JSON.stringify({ winner: "concurrent-writer" }) });

  const result = insertAiEnrichment({ ...key, outputJson: JSON.stringify({ winner: "this-call-should-lose" }) });

  assert.equal(result.output_json, JSON.stringify({ winner: "concurrent-writer" }), "the pre-existing row must win the race");

  const count = getDb().prepare("SELECT COUNT(*) AS n FROM ai_enrichments WHERE entity_key = ?").get(key.entityKey) as { n: number };
  assert.equal(count.n, 1, "the race must never produce a duplicate row");
});

test("markSuperseded only changes status/updated_at on other rows, never content, and never the excluded row", () => {
  const entityKey = "job:dedupe:6";
  const first = insertAiEnrichment({ ...BASE_KEY, entityKey, entityId: 6, contentHash: "h1", outputJson: JSON.stringify({ v: 1 }) });
  const second = insertAiEnrichment({ ...BASE_KEY, entityKey, entityId: 6, contentHash: "h2", outputJson: JSON.stringify({ v: 2 }) });
  void first;

  markSuperseded(BASE_KEY.entityType, entityKey, BASE_KEY.task, second.id);

  const firstAfter = getAiEnrichment({ ...BASE_KEY, entityKey, contentHash: "h1" })!;
  const secondAfter = getAiEnrichment({ ...BASE_KEY, entityKey, contentHash: "h2" })!;

  assert.equal(firstAfter.status, "superseded");
  assert.equal(firstAfter.output_json, JSON.stringify({ v: 1 }), "supersede must never touch output_json");
  assert.equal(secondAfter.status, "active", "the excluded (newest) row must remain active");
  assert.equal(secondAfter.output_json, JSON.stringify({ v: 2 }));
});
