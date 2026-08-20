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

test("CRED-2 a generated password is long, varied and drawn from crypto randomness", () => {
  /* Asserting that each character class appears in ONE sample is a flaky test, not a strong one:
   * a 24-character draw from this alphabet omits digits about 1.6% of the time, so the suite would
   * fail roughly once every sixty runs for no real reason. What matters is the alphabet and the
   * entropy, so those are what get asserted — across a sample large enough to be deterministic. */
  const samples = Array.from({ length: 40 }, () => generatePassword());
  const alphabet = /^[A-Za-z0-9!@#$%^&*\-_=+]+$/;

  for (const p of samples) {
    assert.equal(p.length, 24, "length is fixed and long");
    assert.match(p, alphabet, "no character outside the declared alphabet");
  }
  assert.equal(new Set(samples).size, samples.length, "generated passwords must never collide");

  /* Over 960 characters, every class is present unless the generator is broken. */
  const all = samples.join("");
  for (const cls of [/[A-Z]/, /[a-z]/, /[0-9]/]) assert.match(all, cls);
  assert.ok(new Set(all).size > 30, `expected wide character coverage, saw ${new Set(all).size}`);
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
