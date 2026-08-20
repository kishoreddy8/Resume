import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runCandidateContactMigrations } from "../index";

/**
 * The additive contact migration, tested against the case that actually matters: a database that
 * already exists and predates the column.
 *
 * A fresh database proves nothing here — it would get the column from the table definition either
 * way. The real question is whether an installation carrying months of data picks it up on the
 * next connection, because a running server holds its connection open and will not see a new
 * migration until it restarts. Getting that wrong means every contact write fails with a 500 the
 * moment the code ships, which is exactly what happened during first-run testing.
 */

function legacyDb(): { db: Database.Database; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-mig-"));
  const db = new Database(path.join(dir, "app.db"));
  // The shape as it stood before GitHub existed.
  db.exec(`
    CREATE TABLE candidate_settings (
      candidate_id INTEGER PRIMARY KEY,
      contact_email TEXT,
      contact_phone TEXT,
      contact_location TEXT,
      contact_linkedin TEXT,
      updated_at TEXT
    );
  `);
  db.prepare(
    "INSERT INTO candidate_settings (candidate_id, contact_email, contact_linkedin) VALUES (?, ?, ?)"
  ).run(7, "existing@example.test", "linkedin.com/in/existing");
  return { db, dir };
}

const columns = (db: Database.Database) =>
  (db.prepare("PRAGMA table_info(candidate_settings)").all() as { name: string }[]).map((c) => c.name);

test("MIG-1 contact_github is added to a database that predates it", () => {
  const { db } = legacyDb();
  assert.equal(columns(db).includes("contact_github"), false, "precondition: the column is absent");

  runCandidateContactMigrations(db);

  assert.equal(columns(db).includes("contact_github"), true, "the column must be added on connection");
});

test("MIG-2 existing contact rows survive the migration untouched", () => {
  const { db } = legacyDb();
  runCandidateContactMigrations(db);
  const row = db.prepare("SELECT * FROM candidate_settings WHERE candidate_id = 7").get() as Record<string, unknown>;
  assert.equal(row.contact_email, "existing@example.test");
  assert.equal(row.contact_linkedin, "linkedin.com/in/existing");
  assert.equal(row.contact_github, null, "a column added with no default reads as not-configured");
});

test("MIG-3 running it twice is safe", () => {
  const { db } = legacyDb();
  runCandidateContactMigrations(db);
  assert.doesNotThrow(() => runCandidateContactMigrations(db), "every connection runs this");
  assert.equal(columns(db).filter((c) => c === "contact_github").length, 1);
});

test("MIG-4 a write including github succeeds after migrating", () => {
  const { db } = legacyDb();
  runCandidateContactMigrations(db);
  assert.doesNotThrow(() =>
    db
      .prepare("UPDATE candidate_settings SET contact_github = ? WHERE candidate_id = ?")
      .run("github.com/proof", 7)
  );
  const row = db.prepare("SELECT contact_github FROM candidate_settings WHERE candidate_id = 7").get() as {
    contact_github: string;
  };
  assert.equal(row.contact_github, "github.com/proof");
});
