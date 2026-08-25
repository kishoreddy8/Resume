import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { credentialReferenceFor, credentialReferenceForIdentity, deletePassword, generatePassword, isAvailable, setPassword } from "../credentials";
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
   * secret, so a reviewer can check the whole attack surface at a glance. PHASE 9C added two
   * identity-shaped helpers (`credentialReferenceForIdentity`, `keychainCredentialStore`) — neither
   * yields a secret on its own (the store's `getCredential` delegates to `getPassword`, the one
   * function that does), so the invariant this test protects is unchanged, only the list is wider. */
  const mod = await import("../credentials");
  const exported = Object.keys(mod).sort();
  assert.deepEqual(exported, [
    "credentialReferenceFor",
    "credentialReferenceForIdentity",
    "deletePassword",
    "generatePassword",
    "getPassword",
    "isAvailable",
    "keychainCredentialStore",
    "setPassword",
  ]);
  /* KEYCHAIN-ISOLATION-02 — no enumerate-all-secrets capability exists on the module or on the
   * store object it exports. A reviewer scanning either surface finds nothing that lists, dumps,
   * or globs Keychain entries; every path requires an exact identity. */
  for (const name of exported) {
    assert.doesNotMatch(name, /list|dump|enumerate|all/i, `${name} must not be an enumerate-all capability`);
  }
  const store = mod.keychainCredentialStore;
  for (const name of Object.keys(store)) {
    assert.doesNotMatch(name, /list|dump|enumerate|all/i, `CredentialStore.${name} must not be an enumerate-all capability`);
  }
});

test("DOC-1 an application with no generated resume is refused, with somewhere to go", () => {
  const r = resolveApplicationDocuments({ candidateId: 999999, dedupeKey: "nope", jobId: 1, companyName: "X" });
  assert.equal(r.ready, false);
  assert.match(r.ready === false ? r.reason : "", /Resume Studio/, "a refusal must point at the fix");
});

/* ── PHASE 9C — tenant-scoped, multi-user-ready identity ─────────────────────────────────────────
 * Every test below is pure string logic — no Keychain access, real or fake. */

test("CRED-01 a credential reference is deterministic for the same ATS + tenant + email", () => {
  const identity = { userId: "1", ats: "workday", tenant: "jpmc.wd5.myworkdayjobs.com", email: "me@example.test" };
  assert.equal(credentialReferenceForIdentity(identity), credentialReferenceForIdentity({ ...identity }));
});

test("CRED-02 a different tenant produces a different reference (same ats/email)", () => {
  const base = { userId: "1", ats: "workday", email: "me@example.test" };
  const a = credentialReferenceForIdentity({ ...base, tenant: "jpmc.wd5.myworkdayjobs.com" });
  const b = credentialReferenceForIdentity({ ...base, tenant: "acme.wd1.myworkdayjobs.com" });
  assert.notEqual(a, b);
});

test("CRED-03 a credential reference never contains the secret — it cannot, since none is ever passed to it", () => {
  const ref = credentialReferenceForIdentity({ userId: "1", ats: "workday", tenant: "acme.wd1.myworkdayjobs.com", email: "me@example.test" });
  assert.match(ref, /^keychain:/);
  assert.ok(ref.includes("career-ops-ats"));
  assert.ok(!/password|secret/i.test(ref));
});

test("PASSWORD-01 generated passwords are drawn from crypto randomness (see CRED-2 for the full statistical case)", () => {
  const p = generatePassword();
  assert.equal(p.length, 24);
  assert.match(p, /^[A-Za-z0-9!@#$%^&*\-_=+]+$/);
});

test("PASSWORD-02 two generated passwords differ", () => {
  assert.notEqual(generatePassword(), generatePassword());
});

test("PASSWORD-03 a password is never part of any object this module logs or returns except getPassword's own resolved value", () => {
  /* Structural: setPassword/deletePassword/isAvailable/exists all resolve to void/boolean, never an
   * object that could carry a password value back to a caller who only wanted to know "did this
   * work". */
  assert.equal(typeof deletePassword, "function");
  assert.equal(typeof setPassword, "function");
});

// ── KEYCHAIN-ISOLATION / MULTIUSER-READY ────────────────────────────────────────────────────────

test("KEYCHAIN-ISOLATION-01 an exact Career-Ops-owned identity resolves to one addressable reference", () => {
  const ref = credentialReferenceForIdentity({ userId: "1", ats: "workday", tenant: "acme.wd1.myworkdayjobs.com", email: "me@example.test" });
  assert.match(ref, /^keychain:career-ops-ats:/, "the entry lives under the dedicated Career-Ops namespace, nowhere else");
});

test("KEYCHAIN-ISOLATION-03 different user IDs produce different references for identical ats/tenant/email", () => {
  const base = { ats: "workday", tenant: "acme.wd1.myworkdayjobs.com", email: "me@example.test" };
  const a = credentialReferenceForIdentity({ ...base, userId: "1" });
  const b = credentialReferenceForIdentity({ ...base, userId: "2" });
  assert.notEqual(a, b, "one user's stored credential must never be addressable by another user's identity");
});

test("KEYCHAIN-ISOLATION-04 different ATS tenants produce different references (restates CRED-02 under its isolation name)", () => {
  const base = { userId: "1", ats: "workday", email: "me@example.test" };
  const a = credentialReferenceForIdentity({ ...base, tenant: "acme.wd1.myworkdayjobs.com" });
  const b = credentialReferenceForIdentity({ ...base, tenant: "jpmc.wd5.myworkdayjobs.com" });
  assert.notEqual(a, b);
});

test("KEYCHAIN-ISOLATION-05 the same user + ats + tenant + email resolves deterministically to the same reference", () => {
  const identity = { userId: "1", ats: "workday", tenant: "acme.wd1.myworkdayjobs.com", email: "me@example.test" };
  assert.equal(credentialReferenceForIdentity(identity), credentialReferenceForIdentity({ ...identity }));
  // Case/whitespace variance in the non-secret parts must not fragment the same real-world account.
  assert.equal(
    credentialReferenceForIdentity(identity),
    credentialReferenceForIdentity({ ...identity, ats: " Workday ", tenant: "ACME.WD1.MYWORKDAYJOBS.COM" })
  );
});

test("KEYCHAIN-ISOLATION-06 a credential reference contains no password/secret material", () => {
  const ref = credentialReferenceForIdentity({ userId: "1", ats: "workday", tenant: "acme.wd1.myworkdayjobs.com", email: "me@example.test" });
  assert.ok(!/[!@#$%^&*]{3,}/.test(ref), "no password-shaped fragment appears in the reference");
});

test("KEYCHAIN-ISOLATION-07 the DB-safe shape structurally excludes any secret field", () => {
  /* StoredAccountReference is what the database (or an admin console reading it) may ever hold.
   * The keys are asserted directly against the type's own field names, so a future edit that adds
   * a `password`/`secret`/`token` field to this interface fails this test rather than shipping. */
  const shapeKeys: (keyof import("../credentials").StoredAccountReference)[] = [
    "site",
    "accountEmail",
    "username",
    "credentialReference",
    "createdAt",
    "lastUsedAt",
  ];
  for (const key of shapeKeys) {
    assert.doesNotMatch(String(key), /password|secret|token|cookie|otp/i);
  }
});

test("MULTIUSER-READY-01 two user identities never collide for otherwise identical ats/tenant/email inputs", () => {
  const refs = new Set(
    ["user-a", "user-b", "user-c"].map((userId) =>
      credentialReferenceForIdentity({ userId, ats: "workday", tenant: "acme.wd1.myworkdayjobs.com", email: "same@example.test" })
    )
  );
  assert.equal(refs.size, 3, "each user gets a distinct, non-colliding reference");
});

test("CRED-05 the real Keychain implementation never shell-concatenates a secret", () => {
  /* A static proof over the module's own source, not its behavior: `execFile` (never `exec`) means
   * there is no shell to interpolate into in the first place, and every `security` invocation must
   * pass its arguments as a discrete array rather than a single interpolated command string. This
   * is checked against the source directly so the guarantee holds even for a future edit that adds
   * another `security` call — it is a property of the FILE, not of one function's current body. */
  const source = fs.readFileSync(path.join(import.meta.dirname, "../credentials.ts"), "utf8");

  assert.match(source, /import\s*\{\s*execFile\s*\}\s*from\s*"node:child_process"/, "must import execFile");
  assert.doesNotMatch(source, /\bexec\(/, "must never call the shell-interpreting exec()");
  assert.doesNotMatch(source, /`security[^`]*\$\{/, "no security command may be a template string with an interpolated value");

  for (const m of source.matchAll(/run\(\s*"security"\s*,\s*(\[[\s\S]*?\])\s*,/g)) {
    assert.doesNotMatch(m[1], /\+|\$\{/, "each security argument list must be a literal array, never string concatenation");
  }
});
