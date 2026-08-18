import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { validateCandidateContact } from "../candidateContact";

/**
 * Stage 26B — real candidate contact details.
 *
 * Uses an isolated temp DB and temp candidate/generated roots; production data/app.db is never
 * opened. No Claude/AI, no network.
 *
 * The defect: CareerOps stored no contact details anywhere, so the only values that ever reached a
 * rendered document were the fabricated "candidate@example.com" / "555-0100" from the pre-Stage-26
 * placeholder seed. Once that fabrication was correctly removed, the real writer emitted empty
 * contact fields, tools/tailoring-engine/generate.ts rejected the content with "resume.email is
 * required", and the orchestrator swallowed the error — so no DOCX existed and Phase 9A publication
 * became impossible for every workflow.
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;
let tmpGeneratedDir: string;

let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let getCandidateContact: typeof import("@/db/queries/candidateSettings").getCandidateContact;
let updateCandidateContact: typeof import("@/db/queries/candidateSettings").updateCandidateContact;
let getMatchAffectingSettings: typeof import("@/db/queries/candidateSettings").getMatchAffectingSettings;
let getRankingPreferences: typeof import("@/db/queries/candidateSettings").getRankingPreferences;
let updateCandidateSettings: typeof import("@/db/queries/candidateSettings").updateCandidateSettings;
let computeCandidateSettingsHash: typeof import("@/lib/match/candidateSettingsHash").computeCandidateSettingsHash;
let resolveCandidateContact: typeof import("../candidateContact").resolveCandidateContact;

let aliceId: number;
let bobId: number;

const REAL = { email: "sai.reddy@gmail.com", phone: "(214) 987-6543", location: "Dallas, TX", linkedin: "linkedin.com/in/saikishore" };

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s26b-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s26b-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s26b-gen-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;
  process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI = "1";

  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {
      // Ignore.
    }
    global.__careerOpsDb = undefined;
  }

  const { getDb } = await import("@/db/index");
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({
    getCandidateContact,
    updateCandidateContact,
    getMatchAffectingSettings,
    getRankingPreferences,
    updateCandidateSettings,
  } = await import("@/db/queries/candidateSettings"));
  ({ computeCandidateSettingsHash } = await import("@/lib/match/candidateSettingsHash"));
  ({ resolveCandidateContact } = await import("../candidateContact"));
  getDb();

  aliceId = createCandidate({ firstName: "Alice", lastName: "Smith" }).id;
  bobId = createCandidate({ firstName: "Bob", lastName: "Jones" }).id;
});

after(() => {
  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {
      // Ignore.
    }
    global.__careerOpsDb = undefined;
  }
  for (const d of [tmpDbDir, tmpCandidatesDir, tmpGeneratedDir]) {
    if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

/** A complete, real contact record with the given fields overridden — the nulls are only there to
 *  satisfy the CandidateContact shape for fields REAL does not define. */
const contact = (o: Partial<typeof REAL> = {}) => ({ ...REAL, ...o });

// -------------------------------------------------------------------------------------------------

test("S26B-20 a fully-specified real contact validates and is returned verbatim", () => {
  const v = validateCandidateContact({ name: "Sai Kishore Reddy", contact: contact() });
  assert.equal(v.isComplete, true, JSON.stringify(v.problems));
  assert.deepEqual(v.contact, { name: "Sai Kishore Reddy", ...REAL });
});

test("S26B-21 the exact placeholder values the old seed injected are rejected", () => {
  const email = validateCandidateContact({ name: "X", contact: contact({ email: "candidate@example.com" }) });
  assert.equal(email.isComplete, false);
  assert.ok(email.problems.some((p) => p.field === "email" && /placeholder|example/i.test(p.message)));

  const phone = validateCandidateContact({ name: "X", contact: contact({ phone: "555-0100" }) });
  assert.equal(phone.isComplete, false);
  assert.ok(phone.problems.some((p) => p.field === "phone"));
});

test("S26B-22 other placeholder shapes are rejected too, and real values are not", () => {
  for (const bad of ["a@example.org", "user@test.com", "candidate@realdomain.com", "youremail@gmail.com"]) {
    assert.equal(validateCandidateContact({ name: "X", contact: contact({ email: bad }) }).isComplete, false, `${bad} must be rejected`);
  }
  for (const bad of ["555-0142", "0000000000", "1111111111"]) {
    assert.equal(validateCandidateContact({ name: "X", contact: contact({ phone: bad }) }).isComplete, false, `${bad} must be rejected`);
  }
  for (const good of ["sai.reddy@gmail.com", "s.reddy@some-company.co.uk", "first.last@outlook.com"]) {
    assert.equal(validateCandidateContact({ name: "X", contact: contact({ email: good }) }).isComplete, true, `${good} must be accepted`);
  }
  for (const good of ["(214) 987-6543", "+1 469 555 8899", "9725551234"]) {
    const v = validateCandidateContact({ name: "X", contact: contact({ phone: good }) });
    assert.equal(v.isComplete, true, `${good} must be accepted: ${JSON.stringify(v.problems)}`);
  }
});

test("S26B-23 malformed and missing values are reported per field, never defaulted", () => {
  const empty = validateCandidateContact({ name: "X", contact: { email: null, phone: null, location: null, linkedin: null } });
  assert.equal(empty.isComplete, false);
  assert.equal(empty.contact, undefined, "an incomplete contact must never yield usable values");
  for (const field of ["email", "phone", "location"]) {
    assert.ok(empty.problems.some((p) => p.field === field), `${field} must be reported as missing`);
  }
  assert.equal(validateCandidateContact({ name: "X", contact: contact({ email: "not-an-email" }) }).isComplete, false);
  assert.equal(validateCandidateContact({ name: "X", contact: contact({ phone: "12" }) }).isComplete, false);
});

test("S26B-24 LinkedIn is optional and never blocks", () => {
  const v = validateCandidateContact({ name: "X", contact: { ...contact(), linkedin: null } });
  assert.equal(v.isComplete, true);
  assert.equal(v.contact?.linkedin, undefined, "an absent optional field must be absent, not empty-string");
});

test("S26B-25 contact persists per candidate and survives a reload", () => {
  updateCandidateContact(aliceId, REAL);
  assert.deepEqual(getCandidateContact(aliceId), REAL);
  const resolved = resolveCandidateContact(aliceId);
  assert.equal(resolved.isComplete, true, JSON.stringify(resolved.problems));
  assert.equal(resolved.contact?.email, REAL.email);
  assert.equal(resolved.contact?.name, "Alice Smith", "the name comes from the candidate record, not the contact form");
});

test("S26B-26 candidate isolation: one candidate's contact never leaks into another's", () => {
  assert.deepEqual(getCandidateContact(bobId), { email: null, phone: null, location: null, linkedin: null });
  assert.equal(resolveCandidateContact(bobId).isComplete, false, "an unconfigured candidate must not inherit anyone else's details");

  updateCandidateContact(bobId, { email: "bob@bobmail.com", phone: "469-987-1234", location: "Austin, TX" });
  assert.equal(getCandidateContact(bobId).email, "bob@bobmail.com");
  assert.equal(getCandidateContact(aliceId).email, REAL.email, "Alice's contact must be untouched by Bob's write");
});

test("S26B-27 saving contact does not affect matching or ranking inputs", () => {
  const matchBefore = JSON.stringify(getMatchAffectingSettings(aliceId));
  const prefsBefore = JSON.stringify(getRankingPreferences(aliceId));
  const hashBefore = computeCandidateSettingsHash(getMatchAffectingSettings(aliceId));

  updateCandidateContact(aliceId, { email: "changed@gmail.com", phone: "214-333-4444", location: "Plano, TX" });

  assert.equal(JSON.stringify(getMatchAffectingSettings(aliceId)), matchBefore, "match-affecting settings must be untouched");
  assert.equal(JSON.stringify(getRankingPreferences(aliceId)), prefsBefore, "ranking preferences must be untouched");
  assert.equal(computeCandidateSettingsHash(getMatchAffectingSettings(aliceId)), hashBefore, "the match cache identity must not move");
  updateCandidateContact(aliceId, REAL);
});

test("S26B-28 updating other settings does not clear contact, and vice versa", () => {
  updateCandidateSettings(aliceId, { preferences: { primaryTargetRole: "Data Engineer" } });
  assert.deepEqual(getCandidateContact(aliceId), REAL, "a preferences write must preserve contact details");

  updateCandidateContact(aliceId, { location: "Frisco, TX" });
  assert.equal(getRankingPreferences(aliceId).primaryTargetRole, "Data Engineer", "a contact write must preserve preferences");
  updateCandidateContact(aliceId, REAL);
});

test("S26B-29 a cleared field reads as not-configured rather than empty-string", () => {
  updateCandidateContact(aliceId, { linkedin: "   " });
  assert.equal(getCandidateContact(aliceId).linkedin, null);
  updateCandidateContact(aliceId, REAL);
});
