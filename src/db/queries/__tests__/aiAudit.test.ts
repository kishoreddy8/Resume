import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * ai_audit_log: recording/reading the suggestion lifecycle trail, and — the load-bearing guarantee
 * — that its foreign key to ai_enrichments is NOT cascading, so an audit trail can never be silently
 * destroyed by a future deletion of the enrichment it documents. Run with: npm test
 */

let tmpDir: string;
let getDb: typeof import("../../index").getDb;
let insertAiEnrichment: typeof import("../aiEnrichments").insertAiEnrichment;
let recordAiAuditEvent: typeof import("../aiAudit").recordAiAuditEvent;
let getAuditTrail: typeof import("../aiAudit").getAuditTrail;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-ai-audit-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../index"));
  ({ insertAiEnrichment } = await import("../aiEnrichments"));
  ({ recordAiAuditEvent, getAuditTrail } = await import("../aiAudit"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BASE_KEY = {
  entityType: "job" as const,
  entityKey: "job:dedupe:audit-base",
  entityId: 1,
  task: "audit_test_task",
  taskVersion: 1,
  contentHash: "h1",
  provider: "fake",
  modelId: "fake-standard",
};

test("recordAiAuditEvent + getAuditTrail: events are appended and read back in chronological order", () => {
  const row = insertAiEnrichment({ ...BASE_KEY, outputJson: JSON.stringify({ v: 1 }) });
  recordAiAuditEvent(row.id, "generated");
  recordAiAuditEvent(row.id, "shown");
  recordAiAuditEvent(row.id, "accepted", "user confirmed the suggestion");

  const trail = getAuditTrail(row.id);
  assert.equal(trail.length, 3);
  assert.deepEqual(trail.map((e) => e.event), ["generated", "shown", "accepted"]);
  assert.equal(trail[2].note, "user confirmed the suggestion");
});

test("an unknown event value is rejected by the CHECK constraint", () => {
  const row = insertAiEnrichment({ ...BASE_KEY, entityKey: "job:dedupe:audit-2", entityId: 2, outputJson: JSON.stringify({ v: 1 }) });
  assert.throws(() => {
    getDb().prepare("INSERT INTO ai_audit_log (ai_enrichment_id, event) VALUES (?, ?)").run(row.id, "not_a_real_event");
  });
});

test("FK restrict: deleting an ai_enrichments row that has audit history fails, never cascades", () => {
  const row = insertAiEnrichment({ ...BASE_KEY, entityKey: "job:dedupe:audit-3", entityId: 3, outputJson: JSON.stringify({ v: 1 }) });
  recordAiAuditEvent(row.id, "generated");

  assert.throws(
    () => {
      getDb().prepare("DELETE FROM ai_enrichments WHERE id = ?").run(row.id);
    },
    /FOREIGN KEY constraint failed/i,
    "the DB must refuse to delete an enrichment row that audit history still references"
  );

  // Prove nothing was actually removed by the failed attempt.
  const stillThere = getDb().prepare("SELECT COUNT(*) AS n FROM ai_enrichments WHERE id = ?").get(row.id) as { n: number };
  assert.equal(stillThere.n, 1);
  const auditStillThere = getAuditTrail(row.id);
  assert.equal(auditStillThere.length, 1, "the audit trail must survive the failed delete attempt fully intact");
});

test("an ai_enrichments row with NO audit history can be deleted freely (the restriction is specifically about preserving audit history, not enrichments in general)", () => {
  const row = insertAiEnrichment({ ...BASE_KEY, entityKey: "job:dedupe:audit-4", entityId: 4, outputJson: JSON.stringify({ v: 1 }) });
  // No audit event recorded for this row.
  assert.doesNotThrow(() => {
    getDb().prepare("DELETE FROM ai_enrichments WHERE id = ?").run(row.id);
  });
});
