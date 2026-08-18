import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/**
 * Stage 25B — Blocker 2 regression tests.
 *
 * The incident being pinned: one process-lifetime better-sqlite3 handle became unusable
 * (`SqliteError: database disk image is malformed`) while the file on disk stayed provably intact,
 * and nothing ever reopened it — six hours of HTTP 500 from every API route.
 *
 * The tests below cover the whole contract the fix has to honour: normal access, a RECOVERABLE
 * connection failure, a successful reopen, a FAILED reopen (i.e. the file really is gone/damaged),
 * bounded attempts, mutation safety, and unrelated errors passing through untouched.
 */

let tmpDir: string;
let getDb: typeof import("../index").getDb;
let closeDbConnection: typeof import("../index").closeDbConnection;
let health: typeof import("../health");

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-dbhealth-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb, closeDbConnection } = await import("../index"));
  health = await import("../health");
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  health.resetDbHealth();
});

// --- normal operation ---------------------------------------------------------------------------

test("healthy database: reads work and health reports healthy", () => {
  const row = getDb().prepare("SELECT 1 AS ok").get() as { ok: number };
  assert.equal(row.ok, 1);
  assert.equal(health.getDbHealth().status, "healthy");
  assert.equal(health.probeDatabaseFile().readable, true);
});

test("deep check is never run unless explicitly requested", () => {
  assert.equal(health.getDbHealth().deepCheckRun, false);
  const result = health.checkDatabaseFile();
  assert.equal(result.ok, true, result.result);
  assert.equal(health.getDbHealth().deepCheckRun, true);
});

// --- error classification -----------------------------------------------------------------------

test("recoverable vs unrelated error classification", () => {
  const malformed = Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
  const ioerr = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
  const messageOnly = new Error("database disk image is malformed"); // no `code` populated
  assert.equal(health.isRecoverableDbError(malformed), true);
  assert.equal(health.isRecoverableDbError(ioerr), true);
  assert.equal(health.isRecoverableDbError(messageOnly), true);

  // Contention and application errors must NOT trigger a reconnect.
  assert.equal(health.isRecoverableDbError(Object.assign(new Error("busy"), { code: "SQLITE_BUSY" })), false);
  assert.equal(
    health.isRecoverableDbError(Object.assign(new Error("constraint"), { code: "SQLITE_CONSTRAINT_UNIQUE" })),
    false
  );
  assert.equal(health.isRecoverableDbError(new TypeError("undefined is not a function")), false);
});

test("an unrelated error is passed straight through and changes no state", () => {
  let closed = 0;
  const outcome = health.handleDbFailure(new TypeError("boom"), () => closed++);
  assert.equal(outcome, "unrelated");
  assert.equal(closed, 0);
  assert.equal(health.getDbHealth().status, "healthy");
});

// --- recovery: healthy file, poisoned handle ----------------------------------------------------

test("recoverable failure on a readable file reconnects and the next getDb() serves", () => {
  const before = getDb();
  let closed = 0;
  const outcome = health.handleDbFailure(
    Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }),
    () => {
      closed++;
      closeDbConnection();
    }
  );
  assert.equal(outcome, "reconnected");
  assert.equal(closed, 1);
  assert.equal(health.getDbHealth().status, "healthy");
  assert.ok(health.getDbHealth().lastRecoveredAt, "a recovery timestamp must be recorded");

  const after = getDb();
  assert.notEqual(after, before, "getDb() must hand back a NEW connection after recovery");
  assert.equal((after.prepare("SELECT 1 AS ok").get() as { ok: number }).ok, 1);
});

test("a genuinely poisoned handle is what recovery actually fixes (end to end)", () => {
  // Simulate the real incident as closely as a test can: the cached handle is closed underneath the
  // application (the OS pulled its WAL index away), so every statement it prepares throws — while
  // the file itself is untouched and perfectly readable.
  const poisoned = getDb();
  poisoned.close();
  let threw: unknown = null;
  try {
    poisoned.prepare("SELECT 1").get();
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, "the poisoned handle must actually fail");
  assert.equal(health.probeDatabaseFile().readable, true, "the FILE is still fine — this is the distinguisher");

  closeDbConnection();
  const recovered = getDb();
  assert.equal((recovered.prepare("SELECT 1 AS ok").get() as { ok: number }).ok, 1);
});

// --- recovery: the file really is unreadable ----------------------------------------------------

test("when a fresh connection cannot read the file either, recovery reports failure and does not hide it", async () => {
  const missingPath = path.join(tmpDir, "definitely-absent.db");
  const original = process.env.CAREER_OPS_DB_PATH;
  process.env.CAREER_OPS_DB_PATH = missingPath;
  try {
    const probe = health.probeDatabaseFile();
    assert.equal(probe.readable, false, "a missing file must not probe as readable");

    let closed = 0;
    const outcome = health.handleDbFailure(
      Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }),
      () => closed++
    );
    assert.equal(outcome, "database-unreadable");
    assert.equal(closed, 0, "a damaged file must NOT have its connection swapped underneath callers");
    assert.equal(health.getDbHealth().status, "failed", "genuine damage must surface as failed, never as healthy");
  } finally {
    process.env.CAREER_OPS_DB_PATH = original;
  }
});

// --- bounded attempts ---------------------------------------------------------------------------

test("recovery attempts are bounded and never loop forever", () => {
  const err = Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
  const outcomes: string[] = [];
  for (let i = 0; i < health.MAX_RECOVERY_ATTEMPTS + 3; i++) {
    outcomes.push(health.handleDbFailure(err, () => closeDbConnection()));
  }
  const reconnects = outcomes.filter((o) => o === "reconnected").length;
  const exhausted = outcomes.filter((o) => o === "attempts-exhausted").length;
  assert.equal(reconnects, health.MAX_RECOVERY_ATTEMPTS, "at most MAX_RECOVERY_ATTEMPTS reopens per window");
  assert.ok(exhausted >= 1, "further failures must be refused, not retried");
  assert.equal(health.getDbHealth().status, "failed");
});

test("the bounded window reopens for recovery once it elapses", () => {
  const err = Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
  const t0 = Date.now();
  for (let i = 0; i < health.MAX_RECOVERY_ATTEMPTS + 1; i++) health.handleDbFailure(err, () => closeDbConnection(), t0);
  assert.equal(health.getDbHealth().status, "failed");

  const later = t0 + health.RECOVERY_WINDOW_MS + 1;
  const outcome = health.handleDbFailure(err, () => closeDbConnection(), later);
  assert.equal(outcome, "reconnected", "a new window must allow recovery again");
});

// --- mutation safety ----------------------------------------------------------------------------

test("withDbRecovery retries READ-ONLY work once, and never retries a mutation", () => {
  const err = Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });

  let readAttempts = 0;
  const value = health.withDbRecovery(
    () => {
      readAttempts++;
      if (readAttempts === 1) throw err;
      return "second-attempt";
    },
    () => closeDbConnection(),
    { readOnly: true, label: "test-read" }
  );
  assert.equal(value, "second-attempt");
  assert.equal(readAttempts, 2, "a read-only operation is retried exactly once");

  health.resetDbHealth();
  let writeAttempts = 0;
  assert.throws(
    () =>
      health.withDbRecovery(
        () => {
          writeAttempts++;
          throw err;
        },
        () => closeDbConnection(),
        { label: "test-write" }
      ),
    /malformed/
  );
  assert.equal(writeAttempts, 1, "a mutation must NEVER be replayed after a connection failure");
  assert.equal(health.getDbHealth().status, "healthy", "but the connection is still reset for the next caller");
});

test("withDbRecovery leaves unrelated errors completely alone", () => {
  let attempts = 0;
  assert.throws(
    () =>
      health.withDbRecovery(
        () => {
          attempts++;
          throw new TypeError("application bug");
        },
        () => closeDbConnection(),
        { readOnly: true }
      ),
    /application bug/
  );
  assert.equal(attempts, 1, "an application error must not be retried");
});

// --- transactions / scheduler safety --------------------------------------------------------------

test("a reconnect does not leave a transaction open or corrupt subsequent writes", () => {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS stage25b_probe (id INTEGER PRIMARY KEY, v TEXT)");
  db.prepare("INSERT INTO stage25b_probe (v) VALUES (?)").run("before");

  health.handleDbFailure(
    Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }),
    () => closeDbConnection()
  );

  const fresh = getDb();
  assert.equal(fresh.inTransaction, false, "a fresh connection must not believe it is mid-transaction");
  fresh.prepare("INSERT INTO stage25b_probe (v) VALUES (?)").run("after");
  const rows = fresh.prepare("SELECT v FROM stage25b_probe ORDER BY id").all() as { v: string }[];
  assert.deepEqual(rows.map((r) => r.v), ["before", "after"], "committed data survives a reconnect");
});
