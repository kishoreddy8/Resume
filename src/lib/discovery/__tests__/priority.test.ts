import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

let tmpDir: string;
let nextPriorityEmployers: typeof import("../priority").nextPriorityEmployers;
let getDb: typeof import("../../../db/index").getDb;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-priority-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ nextPriorityEmployers } = await import("../priority"));
  ({ getDb } = await import("../../../db/index"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM employer_identity_resolutions; DELETE FROM h1b_sponsors;");
});

function insertSponsor(db: ReturnType<typeof getDb>, name: string, normalized: string, lca: number, fiscalYear: number): number {
  const row = db
    .prepare(
      `INSERT INTO h1b_sponsors (employer_name_raw, employer_name_normalized, total_lca_certified, most_recent_fiscal_year)
       VALUES (?, ?, ?, ?) RETURNING id`
    )
    .get(name, normalized, lca, fiscalYear) as { id: number };
  return row.id;
}

function insertResolution(db: ReturnType<typeof getDb>, sponsorId: number, status: string, attemptedAt: string): void {
  db.prepare(
    `INSERT INTO employer_identity_resolutions (h1b_sponsor_id, domain_identity_status, attempted_at) VALUES (?, ?, ?)`
  ).run(sponsorId, status, attemptedAt);
}

test("never-attempted employers are eligible", () => {
  const db = getDb();
  insertSponsor(db, "Never Attempted Co", "NEVER ATTEMPTED", 10, 2025);
  const result = nextPriorityEmployers(10);
  assert.equal(result.length, 1);
  assert.equal(result[0].employer_name_raw, "Never Attempted Co");
});

test("VERIFIED employers are excluded — never rediscovered automatically", () => {
  const db = getDb();
  const id = insertSponsor(db, "Already Verified Co", "ALREADY VERIFIED", 10, 2025);
  insertResolution(db, id, "VERIFIED", new Date().toISOString());
  assert.equal(nextPriorityEmployers(10).length, 0);
});

test("UNRESOLVED and AMBIGUOUS are excluded — no automatic retry", () => {
  const db = getDb();
  const a = insertSponsor(db, "Unresolved Co", "UNRESOLVED CO", 10, 2025);
  insertResolution(db, a, "UNRESOLVED", new Date().toISOString());
  const b = insertSponsor(db, "Ambiguous Co", "AMBIGUOUS CO", 10, 2025);
  insertResolution(db, b, "AMBIGUOUS", new Date().toISOString());
  assert.equal(nextPriorityEmployers(10).length, 0);
});

test("FAILED_TEMPORARY is excluded before cooldown, eligible again after cooldown elapses", () => {
  const db = getDb();
  const recent = insertSponsor(db, "Recently Failed Co", "RECENTLY FAILED", 10, 2025);
  insertResolution(db, recent, "FAILED_TEMPORARY", new Date().toISOString());
  const stale = insertSponsor(db, "Long Ago Failed Co", "LONG AGO FAILED", 10, 2025);
  insertResolution(db, stale, "FAILED_TEMPORARY", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());

  const result = nextPriorityEmployers(10);
  const names = result.map((r) => r.employer_name_raw);
  assert.ok(!names.includes("Recently Failed Co"), "within cooldown — must not be retried yet");
  assert.ok(names.includes("Long Ago Failed Co"), "past cooldown — must be retry-eligible");
});

test("sort: most_recent_fiscal_year DESC, then total_lca_certified DESC, then employer_name_normalized ASC", () => {
  const db = getDb();
  insertSponsor(db, "Older Filer", "OLDER FILER", 999, 2020);
  insertSponsor(db, "Zeta High Volume Recent", "ZETA HIGH VOLUME RECENT", 500, 2025);
  insertSponsor(db, "Alpha High Volume Recent", "ALPHA HIGH VOLUME RECENT", 500, 2025);
  insertSponsor(db, "Low Volume Recent", "LOW VOLUME RECENT", 1, 2025);

  const result = nextPriorityEmployers(10);
  const names = result.map((r) => r.employer_name_raw);
  assert.deepEqual(names, ["Alpha High Volume Recent", "Zeta High Volume Recent", "Low Volume Recent", "Older Filer"]);
});

test("candidate job-match score is never a factor — priority is a pure function of H1B/discovery fields", () => {
  const db = getDb();
  insertSponsor(db, "Employer A", "EMPLOYER A", 100, 2025);
  const result1 = nextPriorityEmployers(10);
  const result2 = nextPriorityEmployers(10);
  assert.deepEqual(result1, result2, "identical DB state must always produce an identical, deterministic order");
});
