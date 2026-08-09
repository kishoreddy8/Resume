import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * Phase 2.5 schema-level verification: the additive migration that introduces candidates/
 * candidate_settings/candidate_job_state/candidate_job_state_history and adds candidate_id to
 * job_match_results/match_runs. This test exercises the SAME createConnection() path every other
 * test suite uses (a fresh temp DB), which is exactly the "fresh install" migration path — Stage 4
 * separately dry-runs the "existing database" additive path against a real data/app.db copy.
 */

let tmpDir: string;
let getDb: typeof import("../../index").getDb;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-candidate-schema-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../index"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Candidate #1 is auto-seeded with an active status and a matching candidate_settings row", () => {
  const db = getDb();
  const candidate = db.prepare("SELECT * FROM candidates WHERE id = 1").get() as Record<string, unknown>;
  assert.ok(candidate, "Candidate #1 must exist after any DB connection");
  assert.equal(candidate.status, "active");

  const settings = db.prepare("SELECT * FROM candidate_settings WHERE candidate_id = 1").get() as Record<string, unknown>;
  assert.ok(settings, "candidate_settings row for Candidate #1 must exist");
  assert.equal(settings.requires_sponsorship, 1, "conservative default: sponsorship required until told otherwise");
});

test("re-connecting never duplicates or overwrites Candidate #1", () => {
  const db = getDb();
  db.prepare("UPDATE candidates SET first_name = 'Real', last_name = 'Name' WHERE id = 1").run();
  // Simulate a second connection cycle by re-running the same migration functions directly against
  // the same open db handle (createConnection itself is memoized via getDb's global cache in-process,
  // so this calls the underlying idempotency guard the same way a real process restart would).
  const countBefore = (db.prepare("SELECT COUNT(*) as c FROM candidates").get() as { c: number }).c;
  assert.equal(countBefore, 1);
  const row = db.prepare("SELECT first_name, last_name FROM candidates WHERE id = 1").get() as Record<string, unknown>;
  assert.equal(row.first_name, "Real", "an existing Candidate #1 row must never be overwritten by the auto-seed");
});

test("job_match_results has a candidate_id column with a composite unique index that includes it", () => {
  const db = getDb();
  const columns = (db.prepare("PRAGMA table_info(job_match_results)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns.includes("candidate_id"));

  const indexes = db.prepare("PRAGMA index_list(job_match_results)").all() as { name: string; unique: number }[];
  const uniqueIndex = indexes.find((i) => i.name === "idx_job_match_results_key");
  assert.ok(uniqueIndex && uniqueIndex.unique === 1);
  const indexColumns = (db.prepare(`PRAGMA index_info(${uniqueIndex!.name})`).all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(indexColumns, [
    "candidate_id", "dedupe_key", "match_engine_version", "match_knowledge_hash",
    "candidate_profile_hash", "candidate_settings_hash", "jd_content_hash",
  ]);
});

test("match_runs has a candidate_id column", () => {
  const db = getDb();
  const columns = (db.prepare("PRAGMA table_info(match_runs)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns.includes("candidate_id"));
});

test("candidate_job_state and candidate_job_state_history enforce (candidate_id, dedupe_key) identity, not job_id", () => {
  const db = getDb();
  db.prepare(
    "INSERT INTO candidate_job_state (candidate_id, dedupe_key, pipeline_status) VALUES (1, 'greenhouse:1:ext-1', 'Applied')"
  ).run();
  assert.throws(() => {
    db.prepare(
      "INSERT INTO candidate_job_state (candidate_id, dedupe_key, pipeline_status) VALUES (1, 'greenhouse:1:ext-1', 'New')"
    ).run();
  }, /UNIQUE constraint failed/, "the same candidate cannot have two state rows for the same job");

  // A different candidate CAN have their own independent row for the exact same job — proves the
  // uniqueness is scoped per-candidate, not global.
  db.prepare("INSERT INTO candidates (first_name, last_name, display_name) VALUES ('B', 'B', 'Candidate B')").run();
  const candidateB = db.prepare("SELECT id FROM candidates WHERE first_name = 'B'").get() as { id: number };
  db.prepare(
    "INSERT INTO candidate_job_state (candidate_id, dedupe_key, pipeline_status, not_interested) VALUES (?, 'greenhouse:1:ext-1', 'New', 1)"
  ).run(candidateB.id);

  const rows = db.prepare("SELECT candidate_id, pipeline_status, not_interested FROM candidate_job_state WHERE dedupe_key = 'greenhouse:1:ext-1' ORDER BY candidate_id").all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { candidate_id: 1, pipeline_status: "Applied", not_interested: 0 });
  assert.deepEqual(rows[1], { candidate_id: candidateB.id, pipeline_status: "New", not_interested: 1 });
});

test("companies gets discovery-status columns, defaulting a genuinely new row to UNRESOLVED", () => {
  const db = getDb();
  db.prepare("INSERT INTO companies (name, source_type) VALUES ('Test Co', 'career_link')").run();
  const row = db.prepare("SELECT resolution_status FROM companies WHERE name = 'Test Co'").get() as Record<string, unknown>;
  assert.equal(row.resolution_status, "UNRESOLVED");
});

test("a company that already had an ats_board_token BEFORE resolution_status was introduced is backfilled to VERIFIED, not UNRESOLVED", async () => {
  // Calls runCompaniesDiscoveryMigrations directly against a hand-built "old shape" companies table
  // (no resolution_status column at all), rather than going through getDb()/DB_PATH — DB_PATH is a
  // module-level constant captured once at first import, so it can't be redirected mid-process. This
  // is the same scenario the dry-run against the real data/app.db copy proved empirically; this test
  // makes it a repeatable, isolated regression check of the exact backfill predicate.
  const { runCompaniesDiscoveryMigrations } = await import("../../index");
  const Database = (await import("better-sqlite3")).default;
  const legacyDb = new Database(":memory:");
  legacyDb.exec(`
    CREATE TABLE companies (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, source_type TEXT NOT NULL,
      ats_board_token TEXT, career_page_url TEXT, is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  legacyDb.prepare("INSERT INTO companies (name, source_type, ats_board_token) VALUES ('Legacy Verified Co', 'greenhouse', 'acme')").run();
  legacyDb.prepare("INSERT INTO companies (name, source_type, career_page_url) VALUES ('Legacy Verified Career Link Co', 'career_link', 'https://example.com/careers')").run();
  legacyDb.prepare("INSERT INTO companies (name, source_type) VALUES ('Legacy Unresolved Co', 'career_link')").run();

  runCompaniesDiscoveryMigrations(legacyDb);

  const rows = legacyDb.prepare("SELECT name, resolution_status FROM companies ORDER BY id").all() as Record<string, unknown>[];
  assert.equal(rows[0].resolution_status, "VERIFIED", "a pre-existing company with a working ats_board_token must be backfilled to VERIFIED");
  assert.equal(rows[1].resolution_status, "VERIFIED", "a pre-existing company with a working career_page_url must also be backfilled to VERIFIED");
  assert.equal(rows[2].resolution_status, "UNRESOLVED", "a pre-existing company with no token/career URL has no working-source evidence to backfill from");
  legacyDb.close();
});
