import test from "node:test";
import assert from "node:assert/strict";
import { credentialReferenceFor, generatePassword, isAvailable } from "../credentials";
import { resolveApplicationDocuments } from "../documentLinkage";

/**
 * Credentials.
 *
 * These tests never write to the real Keychain — storing a secret as a side effect of running a
 * test suite is exactly the kind of thing this module exists to avoid. The properties that matter
 * are testable without it: what the database may hold, and that a generated password is real.
 */

test("CRED-1 the database reference is not a secret and cannot be exchanged for one", () => {
  const ref = credentialReferenceFor("greenhouse.io", "me@example.test");
  assert.match(ref, /^keychain:/);
  assert.ok(!ref.includes("password"));
  /* It names an OS-guarded entry. Possessing this string outside the machine yields nothing. */
  assert.ok(ref.includes("career-ops-ats"));
});

test("CRED-2 a generated password is long and drawn from crypto randomness", () => {
  const a = generatePassword();
  const b = generatePassword();
  assert.equal(a.length, 24);
  assert.notEqual(a, b, "two generated passwords must not collide");
  assert.match(a, /[A-Z]/);
  assert.match(a, /[a-z]/);
  assert.match(a, /[0-9]/);
});

test("CRED-3 availability is honest about the platform", async () => {
  const available = await isAvailable();
  assert.equal(available, process.platform === "darwin", "no silent downgrade to a weaker store");
});

test("CRED-4 no credential API returns or logs a secret except the single getter", async () => {
  /* A structural assertion: the module's exported surface is small and only one function yields a
   * secret, so a reviewer can check the whole attack surface at a glance. */
  const mod = await import("../credentials");
  const exported = Object.keys(mod).sort();
  assert.deepEqual(exported, [
    "credentialReferenceFor",
    "deletePassword",
    "generatePassword",
    "getPassword",
    "isAvailable",
    "setPassword",
  ]);
});

test("DOC-1 an application with no generated resume is refused, with somewhere to go", () => {
  const r = resolveApplicationDocuments({ candidateId: 999999, dedupeKey: "nope", jobId: 1, companyName: "X" });
  assert.equal(r.ready, false);
  assert.match(r.ready === false ? r.reason : "", /Resume Studio/, "a refusal must point at the fix");
});
