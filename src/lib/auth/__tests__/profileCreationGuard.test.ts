import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { after, before, beforeEach, test } from "node:test";

/* ================================================================================================
 * ADMIN-SEC-1 — profile creation must be guarded WITHOUT breaking first-run onboarding.
 *
 * The interesting cases are the two that a naive "require the owner" guard gets wrong: a fresh
 * install has no owner to authorise against, and a PIN-less install has no way to prove ownership.
 * Both must still be able to create a profile, or the guard is secure and unusable.
 *
 * Temp database throughout; the PIN and secret values are obvious fakes.
 * ============================================================================================== */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let requireProfileCreationAuthorization: typeof import("../guard").requireProfileCreationAuthorization;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let setPin: typeof import("@/db/queries/candidatePinStore").setPin;
let getOwnerId: typeof import("@/db/queries/candidatePinStore").getOwnerId;
let signUnlockToken: typeof import("../candidatePin").signUnlockToken;
let UNLOCK_TTL_MS: typeof import("../candidatePin").UNLOCK_TTL_MS;
let getUnlockSecret: typeof import("@/db/queries/candidatePinStore").getUnlockSecret;
let UNLOCK_COOKIE: typeof import("../candidatePin").UNLOCK_COOKIE;

const FAKE_PIN = "4821";

function request(cookie?: string): NextRequest {
  const req = new NextRequest("http://localhost:3000/api/candidates", { method: "POST" });
  if (cookie) req.cookies.set(UNLOCK_COOKIE, cookie);
  return req;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-profile-guard-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  ({ requireProfileCreationAuthorization } = await import("../guard"));
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ setPin, getOwnerId, getUnlockSecret } = await import("@/db/queries/candidatePinStore"));
  ({ signUnlockToken, UNLOCK_COOKIE, UNLOCK_TTL_MS } = await import("../candidatePin"));
  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM candidate_settings").run();
  db.prepare("DELETE FROM candidates").run();
});

test("ADMINSEC-CANDIDATE-01: a fresh install with no candidates may create the first profile", () => {
  /* THE BOOTSTRAP CASE. Owner is seeded from the lowest-numbered existing candidate, so before any
   * candidate exists there is no owner — and a guard demanding one would make the product
   * permanently unusable rather than secure. */
  assert.equal(getOwnerId(), null, "precondition: no owner exists yet");
  assert.equal(requireProfileCreationAuthorization(request()), null, "first-run creation must be allowed");
});

test("ADMINSEC-CANDIDATE-01b: an install whose owner has no PIN may still create profiles", () => {
  /* A PIN-less install is unprotected by design — requireCandidateAccess says so for every other
   * route. Being stricter here would break adding a second profile for users who never opted into a
   * PIN, which is inconsistency rather than security. */
  createCandidate({ firstName: "First", lastName: "User" });
  getDb().prepare("UPDATE candidates SET is_owner = 1 WHERE id = (SELECT MIN(id) FROM candidates)").run();

  assert.notEqual(getOwnerId(), null, "precondition: an owner now exists");
  assert.equal(requireProfileCreationAuthorization(request()), null, "no PIN means no opt-in to protection");
});

test("ADMINSEC-CANDIDATE-02: once the owner has a PIN, creation requires an unlocked owner session", () => {
  const owner = createCandidate({ firstName: "Owner", lastName: "Account" });
  getDb().prepare("UPDATE candidates SET is_owner = 1 WHERE id = ?").run(owner.id);
  setPin(owner.id, FAKE_PIN);

  const denial = requireProfileCreationAuthorization(request());
  assert.ok(denial, "an unauthenticated caller must be refused once the install is protected");
  assert.equal(denial!.status, 403);
});

test("ADMINSEC-CANDIDATE-02b: an unlocked owner session is accepted", () => {
  const owner = createCandidate({ firstName: "Owner", lastName: "Account" });
  getDb().prepare("UPDATE candidates SET is_owner = 1 WHERE id = ?").run(owner.id);
  setPin(owner.id, FAKE_PIN);

  const token = signUnlockToken({ ids: [owner.id], exp: Date.now() + UNLOCK_TTL_MS }, getUnlockSecret());
  assert.equal(requireProfileCreationAuthorization(request(token)), null, "the owner may create profiles");
});

test("ADMINSEC-CANDIDATE-02c: a non-owner's unlocked session cannot create profiles", () => {
  const owner = createCandidate({ firstName: "Owner", lastName: "Account" });
  getDb().prepare("UPDATE candidates SET is_owner = 1 WHERE id = ?").run(owner.id);
  setPin(owner.id, FAKE_PIN);
  const other = createCandidate({ firstName: "Other", lastName: "Person" });

  const token = signUnlockToken({ ids: [other.id], exp: Date.now() + UNLOCK_TTL_MS }, getUnlockSecret());
  const denial = requireProfileCreationAuthorization(request(token));
  assert.ok(denial, "unlocking some other profile must not authorise profile creation");
  assert.equal(denial!.status, 403);
});

test("ADMINSEC-SECRET-01b: a refusal never echoes the token, PIN or secret", async () => {
  const owner = createCandidate({ firstName: "Owner", lastName: "Account" });
  getDb().prepare("UPDATE candidates SET is_owner = 1 WHERE id = ?").run(owner.id);
  setPin(owner.id, FAKE_PIN);

  const denial = requireProfileCreationAuthorization(request("tampered-token-value"));
  assert.ok(denial);
  const body = JSON.stringify(await denial!.json());
  assert.doesNotMatch(body, /tampered-token-value/, "the presented token must not be reflected back");
  assert.doesNotMatch(body, new RegExp(FAKE_PIN), "the PIN must never appear");
  assert.doesNotMatch(body, new RegExp(getUnlockSecret()), "the signing secret must never appear");
});
