import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { restoreProfile, snapshotProfile } from "../rollback";

function tmpProfile(contents?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-rollback-"));
  const p = path.join(dir, "candidate-profile.json");
  if (contents !== undefined) fs.writeFileSync(p, contents);
  return p;
}

const GOOD = JSON.stringify({ schemaVersion: 1, skills: [{ rawSkillName: "Spark" }] });
const REJECTED = JSON.stringify({ garbage: true });

test("RB-1 a rejected build restores the previous profile byte for byte", () => {
  const p = tmpProfile(GOOD);
  const previous = snapshotProfile(p);

  // The CLI overwrites the file directly — this is the real sequence, not a simulation of it.
  fs.writeFileSync(p, REJECTED);
  restoreProfile(p, previous);

  assert.equal(fs.readFileSync(p, "utf8"), GOOD, "the previously valid profile must survive untouched");
});

test("RB-2 with no previous profile, a rejected build leaves NO profile behind", () => {
  const p = tmpProfile();
  const previous = snapshotProfile(p);
  assert.equal(previous, null);

  fs.writeFileSync(p, REJECTED);
  restoreProfile(p, previous);

  assert.equal(
    fs.existsSync(p),
    false,
    "leaving a rejected profile in place would hand the matching engine data that failed validation"
  );
});

test("RB-3 restoring is idempotent — a repeated restore cannot corrupt the result", () => {
  const p = tmpProfile(GOOD);
  const previous = snapshotProfile(p);
  fs.writeFileSync(p, REJECTED);
  restoreProfile(p, previous);
  restoreProfile(p, previous);
  assert.equal(fs.readFileSync(p, "utf8"), GOOD);
});

test("RB-4 the snapshot is a copy, not a live view of the file", () => {
  const p = tmpProfile(GOOD);
  const previous = snapshotProfile(p);
  fs.writeFileSync(p, REJECTED);
  assert.equal(previous?.toString(), GOOD, "a snapshot taken before the write must not reflect the write");
});

test("RB-5 a profile containing non-ASCII evidence round-trips exactly", () => {
  // Employer and certification names carry accents and symbols; a lossy restore would corrupt them.
  const unicode = JSON.stringify({ schemaVersion: 1, experience: [{ employer: "Sociéte Générale — ÜÑ" }] });
  const p = tmpProfile(unicode);
  const previous = snapshotProfile(p);
  fs.writeFileSync(p, REJECTED);
  restoreProfile(p, previous);
  assert.equal(fs.readFileSync(p, "utf8"), unicode);
});
