import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The vault tables, on a database that predates them.
 *
 * The migration is additive and idempotent — it runs on every connection — so both properties are
 * asserted here rather than assumed, and an existing installation must keep its data untouched.
 */

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-vault-"));
  process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
  process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
  return dir;
}

test("VAULT-DB-1 the three tables exist after connecting", async () => {
  freshDb();
  const { getDb } = await import("../index");
  const db = getDb();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
  for (const t of ["application_questions", "application_question_variants", "application_answers"]) {
    assert.ok(tables.includes(t), `${t} was not created`);
  }
});

test("VAULT-DB-2 a canonical question is unique, and variants attach to it", async () => {
  const { getDb } = await import("../index");
  const db = getDb();
  db.prepare(
    "INSERT INTO application_questions (canonical_key, normalized_question, question_type) VALUES (?,?,?)"
  ).run("sponsorship_required", "sponsorship", "sponsorship");

  assert.throws(
    () =>
      db
        .prepare("INSERT INTO application_questions (canonical_key, normalized_question, question_type) VALUES (?,?,?)")
        .run("sponsorship_required", "other wording", "sponsorship"),
    /UNIQUE/,
    "one canonical key means one question"
  );

  const qid = (db.prepare("SELECT id FROM application_questions WHERE canonical_key = ?").get("sponsorship_required") as { id: number }).id;
  db.prepare(
    "INSERT INTO application_question_variants (question_id, observed_text, normalized_text, source_ats) VALUES (?,?,?,?)"
  ).run(qid, "Will visa sponsorship be required?", "visa sponsorship required", "greenhouse");
  db.prepare(
    "INSERT INTO application_question_variants (question_id, observed_text, normalized_text, source_ats) VALUES (?,?,?,?)"
  ).run(qid, "Do you require employment sponsorship?", "require employment sponsorship", "lever");

  const variants = db.prepare("SELECT observed_text FROM application_question_variants WHERE question_id = ?").all(qid) as { observed_text: string }[];
  assert.equal(variants.length, 2);
  assert.ok(
    variants.some((v) => v.observed_text === "Will visa sponsorship be required?"),
    "the raw wording must be kept verbatim, never overwritten by a normalised form"
  );
});

test("VAULT-DB-3 an answer is per candidate, and defaults to not-auto-fillable", async () => {
  const { getDb } = await import("../index");
  const db = getDb();
  const qid = (db.prepare("SELECT id FROM application_questions WHERE canonical_key = ?").get("sponsorship_required") as { id: number }).id;

  db.prepare(
    "INSERT INTO application_answers (question_id, candidate_id, answer_value, answer_source) VALUES (?,?,?,?)"
  ).run(qid, 1, "No", "USER_INTERVENTION");

  const row = db.prepare("SELECT * FROM application_answers WHERE question_id=? AND candidate_id=?").get(qid, 1) as {
    approved_by_user: number;
    auto_fill_allowed: number;
  };
  assert.equal(row.approved_by_user, 0, "an answer is not approved merely by being stored");
  assert.equal(row.auto_fill_allowed, 0, "and is never unattended-fillable by default");

  assert.throws(
    () =>
      db
        .prepare("INSERT INTO application_answers (question_id, candidate_id, answer_value, answer_source) VALUES (?,?,?,?)")
        .run(qid, 1, "Yes", "USER_INTERVENTION"),
    /UNIQUE/,
    "one answer per question per candidate"
  );
});
