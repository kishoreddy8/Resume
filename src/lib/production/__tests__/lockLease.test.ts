import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same isolation convention as orchestrator.test.ts — see that file's header comment for why.
let tmpDbDir: string;
let tmpCandidatesDir: string;
let tmpGeneratedDir: string;

let getDb: typeof import("@/db").getDb;
let acquireProductionCycleLock: typeof import("../state").acquireProductionCycleLock;
let heartbeatProductionCycleLock: typeof import("../state").heartbeatProductionCycleLock;
let releaseProductionCycleLock: typeof import("../state").releaseProductionCycleLock;
let forceReleaseProductionCycleLock: typeof import("../state").forceReleaseProductionCycleLock;
let getProductionCycleLockStatus: typeof import("../state").getProductionCycleLockStatus;
let resetProductionCycleStateForTests: typeof import("../state").resetProductionCycleStateForTests;
let STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES: typeof import("../state").STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-lock-lease-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-lock-lease-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-lock-lease-generated-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {}
    global.__careerOpsDb = undefined;
  }

  ({ getDb } = await import("@/db"));
  ({
    acquireProductionCycleLock,
    heartbeatProductionCycleLock,
    releaseProductionCycleLock,
    forceReleaseProductionCycleLock,
    getProductionCycleLockStatus,
    resetProductionCycleStateForTests,
    STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES,
  } = await import("../state"));

  getDb();
});

after(() => {
  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {}
    global.__careerOpsDb = undefined;
  }
  fs.rmSync(tmpDbDir, { recursive: true, force: true });
  fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  fs.rmSync(tmpGeneratedDir, { recursive: true, force: true });
});

describe("Stage 23: Production lease + heartbeat lock safety", () => {
  beforeEach(() => {
    resetProductionCycleStateForTests();
  });

  const T0 = new Date("2026-01-01T00:00:00.000Z");
  const minutesAfterT0 = (m: number) => new Date(T0.getTime() + m * 60_000);

  it("1. Normal acquisition succeeds when the lock is free", () => {
    const res = acquireProductionCycleLock(T0);
    assert.equal(res.acquired, true);
    assert.ok(res.ownerId);

    const status = getProductionCycleLockStatus(T0);
    assert.equal(status.held, true);
    assert.equal(status.ownerId, res.ownerId);
    assert.equal(status.trueAcquiredAt, T0.toISOString());
  });

  it("2. Concurrent acquisition is rejected while the first owner's lease is fresh", () => {
    const a = acquireProductionCycleLock(T0);
    assert.equal(a.acquired, true);

    const b = acquireProductionCycleLock(minutesAfterT0(1));
    assert.equal(b.acquired, false);
    assert.equal(b.heldSince, T0.toISOString());
  });

  it("3. Normal release frees the lock for the true owner", () => {
    const a = acquireProductionCycleLock(T0);
    releaseProductionCycleLock(a.ownerId!);

    const status = getProductionCycleLockStatus(minutesAfterT0(1));
    assert.equal(status.held, false);
    assert.equal(status.ownerId, null);
  });

  it("4. Release after a thrown exception still frees the owner's own lock (try/finally pattern)", () => {
    const a = acquireProductionCycleLock(T0);
    let releasedInFinally = false;
    try {
      try {
        throw new Error("simulated mid-cycle failure");
      } finally {
        releaseProductionCycleLock(a.ownerId!);
        releasedInFinally = true;
      }
    } catch {
      // expected — rethrown after the finally releases the lock, matching runProductionCycle's own shape.
    }
    assert.equal(releasedInFinally, true);
    assert.equal(getProductionCycleLockStatus(minutesAfterT0(1)).held, false);
  });

  it("5. A genuinely abandoned lock (never heartbeated) becomes stale and recoverable after the timeout", () => {
    const a = acquireProductionCycleLock(T0);
    assert.ok(a.acquired);

    const justBeforeStale = minutesAfterT0(STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES - 0.5);
    assert.equal(getProductionCycleLockStatus(justBeforeStale).held, true, "must still be held just before the threshold");

    const justAfterStale = minutesAfterT0(STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES + 0.5);
    const status = getProductionCycleLockStatus(justAfterStale);
    assert.equal(status.stale, true);
    assert.equal(status.held, false);

    const b = acquireProductionCycleLock(justAfterStale);
    assert.equal(b.acquired, true);
    assert.notEqual(b.ownerId, a.ownerId);
  });

  it("6. Ownership protection: a different owner's release is a no-op — the true owner remains locked", () => {
    const a = acquireProductionCycleLock(T0);
    releaseProductionCycleLock("some-other-owner-id-that-never-acquired");

    const status = getProductionCycleLockStatus(minutesAfterT0(1));
    assert.equal(status.held, true);
    assert.equal(status.ownerId, a.ownerId);
  });

  it("7. Heartbeat extends the lease's alive-timestamp for the true owner", () => {
    const a = acquireProductionCycleLock(T0);
    const heartbeatAt = minutesAfterT0(2);
    const ok = heartbeatProductionCycleLock(a.ownerId!, heartbeatAt);
    assert.equal(ok, true);

    const status = getProductionCycleLockStatus(heartbeatAt);
    assert.equal(status.acquiredAt, heartbeatAt.toISOString());
    assert.equal(status.trueAcquiredAt, T0.toISOString(), "true acquisition time must never move on heartbeat");
  });

  it("8. THE STAGE 22 FIX: a healthy cycle heartbeating past the old flat 180-minute mark cannot have its lock stolen", () => {
    const a = acquireProductionCycleLock(T0);
    assert.ok(a.acquired);

    // Heartbeat right at the OLD flat timeout (180 minutes) — this is exactly the point at which
    // the pre-Stage-23 acquired-at-only design would have let a second cycle steal the lock, even
    // though this cycle (per Stage 22's real observation of a ~3h41m unbounded ATS scan) is still
    // legitimately alive and running.
    const heartbeatAt180 = minutesAfterT0(180);
    assert.equal(heartbeatProductionCycleLock(a.ownerId!, heartbeatAt180), true);

    // A competing acquire attempt shortly after that heartbeat — well within the NEW heartbeat-based
    // stale window — must be rejected. Under the old design (staleness measured from raw
    // acquired_at, 180 minutes ago), this exact attempt would have SUCCEEDED and stolen the lock.
    const competingAttempt = new Date(heartbeatAt180.getTime() + (STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES - 1) * 60_000);
    const b = acquireProductionCycleLock(competingAttempt);
    assert.equal(b.acquired, false, "a heartbeating cycle must never lose its lease merely for running past the old flat timeout");

    const status = getProductionCycleLockStatus(competingAttempt);
    assert.equal(status.held, true);
    assert.equal(status.ownerId, a.ownerId);
  });

  it("9. Heartbeat stops -> lease eventually expires -> a new acquire succeeds safely", () => {
    const a = acquireProductionCycleLock(T0);
    const lastHeartbeat = minutesAfterT0(180);
    assert.equal(heartbeatProductionCycleLock(a.ownerId!, lastHeartbeat), true);

    // No further heartbeats after this point (simulating a crash) — once past the stale window
    // measured from the LAST heartbeat, the lease must become recoverable.
    const afterLeaseExpiry = new Date(lastHeartbeat.getTime() + (STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES + 1) * 60_000);
    assert.equal(getProductionCycleLockStatus(afterLeaseExpiry).stale, true);

    const b = acquireProductionCycleLock(afterLeaseExpiry);
    assert.equal(b.acquired, true);
    assert.notEqual(b.ownerId, a.ownerId);
  });

  it("10. A stolen lease's old owner cannot corrupt the new owner via heartbeat or release", () => {
    const a = acquireProductionCycleLock(T0);
    const afterStale = minutesAfterT0(STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES + 1);
    const b = acquireProductionCycleLock(afterStale);
    assert.ok(b.acquired);
    assert.notEqual(a.ownerId, b.ownerId);

    // A's heartbeat must fail (it no longer owns the lease) and must not touch B's lease.
    const aHeartbeatOk = heartbeatProductionCycleLock(a.ownerId!, minutesAfterT0(STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES + 2));
    assert.equal(aHeartbeatOk, false);

    const statusAfterAHeartbeat = getProductionCycleLockStatus(afterStale);
    assert.equal(statusAfterAHeartbeat.ownerId, b.ownerId);

    // A's release must also be a no-op against B's active lease.
    releaseProductionCycleLock(a.ownerId!);
    const statusAfterARelease = getProductionCycleLockStatus(afterStale);
    assert.equal(statusAfterARelease.held, true);
    assert.equal(statusAfterARelease.ownerId, b.ownerId);
  });

  it("11. forceReleaseProductionCycleLock unconditionally frees the lock regardless of owner (operator recovery path)", () => {
    acquireProductionCycleLock(T0);
    forceReleaseProductionCycleLock();
    const status = getProductionCycleLockStatus(minutesAfterT0(1));
    assert.equal(status.held, false);
    assert.equal(status.ownerId, null);
  });
});
