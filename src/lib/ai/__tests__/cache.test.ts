import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * AI cache lookup/write semantics: exact-key hits, content-hash invalidation, task-version
 * invalidation, write-once immutability, and — the identity-safety fix — that entity_key (a stable
 * identity snapshot), not entity_id (a reusable numeric row id), is what lookup/uniqueness actually
 * uses. Runs against a real (temp, isolated) SQLite file via CAREER_OPS_DB_PATH, same pattern as
 * src/db/queries/__tests__/settings.test.ts. Run with: npm test
 */

let tmpDir: string;
let lookupCache: typeof import("../cache").lookupCache;
let writeCache: typeof import("../cache").writeCache;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-ai-cache-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  const { getDb } = await import("../../../db/index");
  ({ lookupCache, writeCache } = await import("../cache"));
  getDb(); // ensure schema has run
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BASE_PARAMS = {
  entityType: "job" as const,
  entityKey: "job:dedupe:base",
  entityId: 1,
  task: "test_task",
  taskVersion: 1,
  provider: "fake",
  modelId: "fake-lightweight",
};

test("cache miss on first lookup, then a hit after writing", () => {
  const { contentHash, hit: miss } = lookupCache({ ...BASE_PARAMS, cacheKeyInput: { title: "Engineer" } });
  assert.equal(miss, undefined);

  const written = writeCache({ ...BASE_PARAMS, contentHash, outputJson: JSON.stringify({ summary: "a role" }) });

  const { hit } = lookupCache({ ...BASE_PARAMS, cacheKeyInput: { title: "Engineer" } });
  assert.ok(hit);
  assert.equal(hit!.id, written.id);
  assert.equal(hit!.output_json, JSON.stringify({ summary: "a role" }));
});

test("content-hash invalidation: a changed cache-key input misses even for the same entity/task/version", () => {
  const entityKey = "job:dedupe:2";
  const first = lookupCache({ ...BASE_PARAMS, entityKey, cacheKeyInput: { title: "Engineer" } });
  writeCache({ ...BASE_PARAMS, entityKey, contentHash: first.contentHash, outputJson: JSON.stringify({ v: 1 }) });

  const { hit } = lookupCache({ ...BASE_PARAMS, entityKey, cacheKeyInput: { title: "Senior Engineer" } });
  assert.equal(hit, undefined, "different content must not resolve to the old cached row");
});

test("task-version invalidation: bumping task_version misses even with identical content", () => {
  const entityKey = "job:dedupe:3";
  const first = lookupCache({ ...BASE_PARAMS, entityKey, cacheKeyInput: { title: "Engineer" } });
  writeCache({ ...BASE_PARAMS, entityKey, contentHash: first.contentHash, outputJson: JSON.stringify({ v: 1 }) });

  const { hit } = lookupCache({ ...BASE_PARAMS, entityKey, taskVersion: 2, cacheKeyInput: { title: "Engineer" } });
  assert.equal(hit, undefined, "a bumped task_version must not reuse the prior version's cached row");
});

test("an unrelated task's cache is unaffected by another task's version bump", () => {
  const entityKey = "job:dedupe:4";
  const keyInput = { title: "Engineer" };
  const forTaskA = lookupCache({ ...BASE_PARAMS, entityKey, task: "task_a", cacheKeyInput: keyInput });
  writeCache({ ...BASE_PARAMS, entityKey, task: "task_a", contentHash: forTaskA.contentHash, outputJson: JSON.stringify({ v: 1 }) });

  const forTaskB = lookupCache({ ...BASE_PARAMS, entityKey, task: "task_b", taskVersion: 2, cacheKeyInput: keyInput });
  writeCache({ ...BASE_PARAMS, entityKey, task: "task_b", taskVersion: 2, contentHash: forTaskB.contentHash, outputJson: JSON.stringify({ v: 1 }) });

  const { hit: taskAStillCached } = lookupCache({ ...BASE_PARAMS, entityKey, task: "task_a", cacheKeyInput: keyInput });
  assert.ok(taskAStillCached, "task_a's cache entry must survive task_b's independent version");
});

test("immutable: writing to an existing exact key never changes the stored output", () => {
  const entityKey = "job:dedupe:5";
  const { contentHash } = lookupCache({ ...BASE_PARAMS, entityKey, cacheKeyInput: { title: "Engineer" } });
  const original = writeCache({ ...BASE_PARAMS, entityKey, contentHash, outputJson: JSON.stringify({ v: "original" }) });

  const second = writeCache({ ...BASE_PARAMS, entityKey, contentHash, outputJson: JSON.stringify({ v: "attempted overwrite" }) });

  assert.equal(second.id, original.id, "same key must resolve to the same row, not a new one");
  assert.equal(second.output_json, JSON.stringify({ v: "original" }), "the original content must never be overwritten");
});

test("supersede bookkeeping only touches status/updated_at on prior rows, never their content", () => {
  const entityKey = "job:dedupe:6";
  const keyInput1 = { title: "Engineer v1" };
  const first = lookupCache({ ...BASE_PARAMS, entityKey, cacheKeyInput: keyInput1 });
  const firstRow = writeCache({ ...BASE_PARAMS, entityKey, contentHash: first.contentHash, outputJson: JSON.stringify({ v: 1 }) });
  assert.equal(firstRow.status, "active");

  const keyInput2 = { title: "Engineer v2" };
  const second = lookupCache({ ...BASE_PARAMS, entityKey, cacheKeyInput: keyInput2 });
  writeCache({ ...BASE_PARAMS, entityKey, contentHash: second.contentHash, outputJson: JSON.stringify({ v: 2 }) });

  const { hit: firstAfterSupersede } = lookupCache({ ...BASE_PARAMS, entityKey, cacheKeyInput: keyInput1 });
  assert.ok(firstAfterSupersede, "an exact-key lookup for the old row must still find it (status never gates lookup)");
  assert.equal(firstAfterSupersede!.status, "superseded");
  assert.equal(firstAfterSupersede!.output_json, JSON.stringify({ v: 1 }), "supersede must never touch the row's own content");
});

// --- Identity safety: entity_key, not entity_id, is what lookup actually uses -------------------

test("identity safety: two different entity_key values sharing the SAME entity_id never collide", () => {
  const sharedEntityId = 999; // simulates a numeric row id reused after the original was deleted
  const keyInput = { title: "Engineer" };

  const forOldEntity = lookupCache({ ...BASE_PARAMS, entityKey: "job:dedupe:old-deleted-job", cacheKeyInput: keyInput });
  writeCache({
    ...BASE_PARAMS,
    entityKey: "job:dedupe:old-deleted-job",
    entityId: sharedEntityId,
    contentHash: forOldEntity.contentHash,
    outputJson: JSON.stringify({ v: "belongs to the OLD, now-deleted job" }),
  });

  // A brand-new, unrelated job that happens to have been assigned the SAME numeric id.
  const { hit: newEntityLookup } = lookupCache({ ...BASE_PARAMS, entityKey: "job:dedupe:new-unrelated-job", cacheKeyInput: keyInput });
  assert.equal(newEntityLookup, undefined, "a new entity must never see the old entity's cached result merely because it reused the same numeric id");

  // The old entity's history must remain fully intact and reachable by its own key.
  const { hit: oldEntityStillThere } = lookupCache({ ...BASE_PARAMS, entityKey: "job:dedupe:old-deleted-job", cacheKeyInput: keyInput });
  assert.ok(oldEntityStillThere);
  assert.equal(oldEntityStillThere!.output_json, JSON.stringify({ v: "belongs to the OLD, now-deleted job" }));
});
