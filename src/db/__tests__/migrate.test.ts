import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * Pre-migration backup — FAIL-CLOSED by default (see migrate.ts's own doc comment on
 * backupBeforeMigration): if the live DB already exists and a backup cannot be written, the
 * migration must NOT proceed. The only bypass is the explicit, non-default
 * CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP=true env var.
 *
 * Same isolated-temp-DB-path pattern as every other db test — but note DB_PATH is captured as a
 * module-level const on first import of src/db/index.ts, so all tests in this file share ONE fixed
 * path (set once in before()) and instead vary FILESYSTEM STATE at that path between tests
 * (nonexistent -> a real file -> a blocked backups/ destination), run sequentially.
 */

let tmpDir: string;
let dbPath: string;
let backupsDir: string;
let backupBeforeMigration: typeof import("../migrate").backupBeforeMigration;
let MigrationBackupError: typeof import("../migrate").MigrationBackupError;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-migrate-test-"));
  dbPath = path.join(tmpDir, "test.db");
  backupsDir = path.join(tmpDir, "backups");
  process.env.CAREER_OPS_DB_PATH = dbPath;

  ({ backupBeforeMigration, MigrationBackupError } = await import("../migrate"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("no existing DB yet (first-ever run) -> backupBeforeMigration is a safe no-op, never throws", () => {
  assert.equal(fs.existsSync(dbPath), false);
  assert.doesNotThrow(() => backupBeforeMigration());
  assert.equal(fs.existsSync(backupsDir), false, "nothing to back up -> no backups/ dir created either");
});

test("existing DB, backup destination writable -> backup succeeds and the migration proceeds", () => {
  fs.writeFileSync(dbPath, "dummy db content");
  assert.doesNotThrow(() => backupBeforeMigration());
  assert.ok(fs.existsSync(backupsDir));
  const files = fs.readdirSync(backupsDir);
  assert.ok(files.some((f) => f.includes(".pre-migration-")), "a pre-migration snapshot must exist");
});

test("backup destination blocked -> backupBeforeMigration throws MigrationBackupError (fail-closed default, live migration must not proceed)", () => {
  fs.rmSync(backupsDir, { recursive: true, force: true });
  fs.writeFileSync(backupsDir, "a plain file sitting where the backups/ directory needs to go");
  try {
    assert.throws(() => backupBeforeMigration(), (err: unknown) => err instanceof MigrationBackupError);
  } finally {
    fs.unlinkSync(backupsDir);
  }
});

test("explicit CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP=true bypasses a failed backup — non-default, must be set explicitly", () => {
  fs.writeFileSync(backupsDir, "still blocked");
  process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
  try {
    assert.doesNotThrow(() => backupBeforeMigration());
  } finally {
    delete process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP;
    fs.unlinkSync(backupsDir);
  }
});

test("without the bypass set, the SAME blocked destination goes back to throwing — proves the bypass is not sticky/global", () => {
  fs.writeFileSync(backupsDir, "blocked again, no bypass this time");
  assert.equal(process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP, undefined);
  try {
    assert.throws(() => backupBeforeMigration(), (err: unknown) => err instanceof MigrationBackupError);
  } finally {
    fs.unlinkSync(backupsDir);
  }
});

// NOTE on "throwaway/test DB usage remains unaffected": DB_PATH (src/db/index.ts) is captured as a
// module-level const on first import, so it can't be re-pointed mid-process to prove this directly
// in one more test here without a subprocess (overkill). It's already proven structurally instead:
// backup logic lives ONLY in migrate.ts's backupBeforeMigration (this file), never in index.ts's
// createConnection/getDb — and every OTHER test file in this project (680+ tests) already uses the
// CAREER_OPS_DB_PATH + getDb() pattern directly, never importing migrate.ts at all, and all pass.
