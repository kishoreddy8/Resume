import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { planBackupRetention } from "../migrate";

/**
 * Stage 29 — backup retention must bound disk growth WITHOUT ever being able to leave the machine
 * without a recovery point, and without silently mass-deleting history the moment the policy tightens.
 *
 * Temp directories only; the real data/backups is never read or written by these tests.
 */

/** Builds N complete snapshot sets (db + wal + shm) of a given size, oldest first. */
function seedSets(dir: string, count: number, bytesPerDb: number): string[] {
  const stamps: string[] = [];
  for (let i = 0; i < count; i++) {
    const ts = `2026-08-${String(i + 1).padStart(2, "0")}T00-00-00-000Z`;
    stamps.push(ts);
    fs.writeFileSync(path.join(dir, `app.db.pre-migration-${ts}.bak`), Buffer.alloc(bytesPerDb));
    fs.writeFileSync(path.join(dir, `app.db-wal.pre-migration-${ts}.bak`), Buffer.alloc(16));
    fs.writeFileSync(path.join(dir, `app.db-shm.pre-migration-${ts}.bak`), Buffer.alloc(16));
  }
  return stamps;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s29-backups-"));
}

test("S29-40 a routine prune trims to the retention count and keeps the newest", () => {
  const dir = tmpDir();
  try {
    const stamps = seedSets(dir, 5, 1024);
    const plan = planBackupRetention(dir);
    assert.equal(plan.completeSets.length, 5);
    assert.equal(plan.bulkPruneWithheld, false, "removing one set is routine");
    assert.equal(plan.toDelete.length, 1, "5 sets against a 4-set policy prunes exactly one");
    assert.equal(plan.toDelete[0], stamps[0], "the OLDEST set is the one removed");
    assert.ok(plan.toKeep.includes(stamps[4]), "the newest set must always be kept");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S29-41 a large backlog is NOT mass-deleted without an explicit opt-in", () => {
  const dir = tmpDir();
  try {
    seedSets(dir, 20, 1024);
    const plan = planBackupRetention(dir);
    assert.equal(plan.toDelete.length, 16, "the policy identifies the backlog");
    assert.equal(plan.bulkPruneWithheld, true, "but it must not be executed silently");
    assert.match(plan.reason, /CAREER_OPS_ALLOW_BULK_BACKUP_PRUNE/, "the reason must name the opt-in");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S29-42 the opt-in releases the backlog, still keeping the newest sets", () => {
  const dir = tmpDir();
  const prev = process.env.CAREER_OPS_ALLOW_BULK_BACKUP_PRUNE;
  process.env.CAREER_OPS_ALLOW_BULK_BACKUP_PRUNE = "true";
  try {
    const stamps = seedSets(dir, 20, 1024);
    const plan = planBackupRetention(dir);
    assert.equal(plan.bulkPruneWithheld, false);
    assert.equal(plan.toKeep.length, 4);
    assert.ok(plan.toKeep.includes(stamps[19]), "the newest set is always kept");
    assert.ok(!plan.toDelete.includes(stamps[19]));
    assert.ok(plan.bytesRecoverable > 0, "the plan reports what would be freed");
  } finally {
    if (prev === undefined) delete process.env.CAREER_OPS_ALLOW_BULK_BACKUP_PRUNE;
    else process.env.CAREER_OPS_ALLOW_BULK_BACKUP_PRUNE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S29-43 retention never drops below two complete sets, however large they are", () => {
  const dir = tmpDir();
  try {
    // Each "set" is enormous — the size cap alone would keep zero or one.
    seedSets(dir, 3, 20 * 1024 * 1024);
    const plan = planBackupRetention(dir);
    assert.ok(plan.toKeep.length >= 2, `must retain at least two recovery points, kept ${plan.toKeep.length}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S29-44 a single set is never pruned — the last recovery point is untouchable", () => {
  const dir = tmpDir();
  try {
    seedSets(dir, 1, 1024);
    const plan = planBackupRetention(dir);
    assert.deepEqual(plan.toDelete, []);
    assert.equal(plan.toKeep.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S29-45 an orphan WAL/SHM companion is not counted as a recovery point", () => {
  const dir = tmpDir();
  try {
    seedSets(dir, 2, 1024);
    // A sidecar whose database snapshot does not exist.
    fs.writeFileSync(path.join(dir, "app.db-wal.pre-migration-2026-09-09T00-00-00-000Z.bak"), Buffer.alloc(16));
    const plan = planBackupRetention(dir);
    assert.equal(plan.completeSets.length, 2, "an orphan sidecar is not a complete set");
    assert.ok(!plan.completeSets.includes("2026-09-09T00-00-00-000Z"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S29-46 a missing backups directory is handled without throwing", () => {
  const plan = planBackupRetention(path.join(os.tmpdir(), "career-ops-s29-does-not-exist"));
  assert.deepEqual(plan.toDelete, []);
  assert.equal(plan.completeSets.length, 0);
});
