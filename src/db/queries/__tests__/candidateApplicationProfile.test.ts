import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * PHASE 9D — the smallest safe employment/education storage. Additive-migration, candidate-scoped,
 * and (this is the point) empty-by-default: nothing here ever populates a row on its own.
 */

let tmpDir: string;
let listEmployment: typeof import("../candidateApplicationProfile").listEmployment;
let listEducation: typeof import("../candidateApplicationProfile").listEducation;
let addEmployment: typeof import("../candidateApplicationProfile").addEmployment;
let addEducation: typeof import("../candidateApplicationProfile").addEducation;
let deleteEmployment: typeof import("../candidateApplicationProfile").deleteEmployment;
let createCandidate: typeof import("../candidates").createCandidate;
let candidateB: number;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-candidate-app-profile-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ listEmployment, listEducation, addEmployment, addEducation, deleteEmployment } = await import("../candidateApplicationProfile"));
  ({ createCandidate } = await import("../candidates"));
  const { getDb } = await import("../../index");
  getDb();
  candidateB = createCandidate({ firstName: "Other", lastName: "Candidate" }).id;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("PROFILE-DB-01: a fresh candidate has no employment or education rows — nothing is ever back-filled", () => {
  assert.deepEqual(listEmployment(1), []);
  assert.deepEqual(listEducation(1), []);
});

test("PROFILE-DB-02: an explicitly added employment record round-trips exactly what was given, nothing invented", () => {
  const rec = addEmployment({ candidateId: 1, employer: "Acme Corp", title: "Senior Engineer", startDate: "2021-03", endDate: null });
  assert.equal(rec.employer, "Acme Corp");
  assert.equal(rec.endDate, null, "a current role's end date is null, never guessed");
  const [fetched] = listEmployment(1);
  assert.deepEqual(fetched, rec);
});

test("PROFILE-DB-03: education never carries a graduation date field at all — it cannot be invented if it doesn't exist", () => {
  const rec = addEducation({ candidateId: 1, institution: "State University", level: "B.S.", field: "Computer Science" });
  assert.ok(!("graduationDate" in rec));
  const [fetched] = listEducation(1);
  assert.equal(fetched.institution, "State University");
});

test("MULTIUSER-DB-01: candidate B's employment is never visible under candidate A's id, and vice versa", () => {
  addEmployment({ candidateId: candidateB, employer: "Other Co", title: "Analyst" });
  const forA = listEmployment(1).map((e) => e.employer);
  const forB = listEmployment(candidateB).map((e) => e.employer);
  assert.ok(!forA.includes("Other Co"), "candidate A must never see candidate B's employer");
  assert.ok(forB.includes("Other Co"));
  assert.ok(!forB.includes("Acme Corp"), "candidate B must never see candidate A's employer");
});

test("PROFILE-DB-04: deleting requires BOTH the id and the owning candidateId to match — cross-candidate delete is a no-op", () => {
  const rec = addEmployment({ candidateId: candidateB, employer: "Delete-Me Inc", title: "Contractor" });
  deleteEmployment(1, rec.id); // wrong candidateId — must not delete candidate B's row
  assert.ok(listEmployment(candidateB).some((e) => e.id === rec.id), "the row must survive a delete attempt scoped to the wrong candidate");
  deleteEmployment(candidateB, rec.id);
  assert.ok(!listEmployment(candidateB).some((e) => e.id === rec.id));
});
