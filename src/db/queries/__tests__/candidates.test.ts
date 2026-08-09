import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let tmpDir: string;
let createCandidate: typeof import("../candidates").createCandidate;
let getCandidate: typeof import("../candidates").getCandidate;
let listCandidates: typeof import("../candidates").listCandidates;
let archiveCandidate: typeof import("../candidates").archiveCandidate;
let requireActiveCandidate: typeof import("../candidates").requireActiveCandidate;
let getActiveCandidateId: typeof import("../candidates").getActiveCandidateId;
let setActiveCandidateId: typeof import("../candidates").setActiveCandidateId;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-candidates-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ createCandidate, getCandidate, listCandidates, archiveCandidate, requireActiveCandidate, getActiveCandidateId, setActiveCandidateId } =
    await import("../candidates"));
  const { getDb } = await import("../../index");
  getDb(); // triggers migration + Candidate #1 auto-seed
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Candidate #1 exists and is active by default", () => {
  const c = getCandidate(1);
  assert.ok(c);
  assert.equal(c!.status, "active");
});

test("createCandidate makes a new candidate with its own candidate_settings row", async () => {
  const b = createCandidate({ firstName: "Java", lastName: "Dev" });
  assert.equal(b.display_name, "Java Dev");
  assert.ok(b.id > 1, "new candidate gets a fresh id, never reusing Candidate #1's");

  const { getDb } = await import("../../index");
  const settingsRow = getDb().prepare("SELECT * FROM candidate_settings WHERE candidate_id = ?").get(b.id);
  assert.ok(settingsRow, "candidate_settings row must be created alongside the candidate");
});

test("listCandidates excludes archived by default, includes with includeArchived=true", () => {
  const c = createCandidate({ firstName: "Archived", lastName: "One" });
  archiveCandidate(c.id);

  const active = listCandidates();
  assert.ok(!active.some((x) => x.id === c.id));

  const all = listCandidates(true);
  assert.ok(all.some((x) => x.id === c.id));
});

test("requireActiveCandidate returns null for a nonexistent or archived candidate, the row for a real active one", () => {
  assert.equal(requireActiveCandidate(99999), null);
  const c = createCandidate({ firstName: "Temp", lastName: "Person" });
  assert.ok(requireActiveCandidate(c.id));
  archiveCandidate(c.id);
  assert.equal(requireActiveCandidate(c.id), null, "an archived candidate must not be usable as an active target");
});

test("active-candidate UX default: defaults to Candidate #1, settable, rejects a non-active target", () => {
  assert.equal(getActiveCandidateId(), 1);
  const b = createCandidate({ firstName: "Java", lastName: "Dev2" });
  setActiveCandidateId(b.id);
  assert.equal(getActiveCandidateId(), b.id);

  assert.throws(() => setActiveCandidateId(999999));

  // Switching back to Candidate #1 for subsequent tests' isolation.
  setActiveCandidateId(1);
});
