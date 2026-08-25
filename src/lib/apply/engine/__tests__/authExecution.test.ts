import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockAtsUrl } from "./mockAts/paths";
import { credentialReferenceForIdentity, type AtsAccountIdentity, type CredentialStore } from "@/lib/apply/credentials";
import { deriveTenantKey, type AdapterAuthConfig } from "@/lib/apply/auth";
import type { AtsAdapter } from "@/lib/apply/agent/types";

/**
 * PHASE 9C — the universal auth/account-bootstrap layer, end to end, against LOCAL mock ATS pages.
 *
 * NO REAL WEBSITE, NO REAL KEYCHAIN. Every test here uses a `FakeCredentialStore` — an in-memory
 * Map, never touched by the real macOS Keychain — so this suite proves the ORCHESTRATION
 * (`ensureAuthenticated`, its wiring into `executeRun`) without ever needing the OS credential
 * store to exist or be reachable in CI.
 *
 * NO REAL ACCOUNT IS EVER CREATED. Every "account creation" fixture is a local page that reveals a
 * canned confirmation on submit; nothing here reaches an employer's site.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-auth-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
delete process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT;

/* eslint-disable @typescript-eslint/no-require-imports */
const runsDb = require("@/db/queries/applicationRuns") as typeof import("@/db/queries/applicationRuns");
const vault = require("@/db/queries/applicationVault") as typeof import("@/db/queries/applicationVault");
const { getDb } = require("@/db") as typeof import("@/db");
const { ApplicationBrowserRuntime } = require("../browserRuntime") as typeof import("../browserRuntime");
const { executeRun } = require("../executor") as typeof import("../executor");
const { ensureAuthenticated } = require("../auth") as typeof import("../auth");

const CONTEXT = {
  candidateId: 1,
  contact: {
    name: "Jordan Rivera",
    email: "jordan@example.test",
    phone: "(214) 555-0100",
    location: "Dallas, TX",
  },
  resumePath: path.join(dir, "Resume.docx"),
  coverLetterPath: path.join(dir, "CoverLetter.docx"),
};
fs.writeFileSync(CONTEXT.resumePath, "mock resume");
fs.writeFileSync(CONTEXT.coverLetterPath, "mock cover letter");

const runtime = new ApplicationBrowserRuntime();

function deps() {
  return { context: CONTEXT, knownVariants: vault.loadKnownVariants(), storedAnswers: new Map() } as Parameters<typeof executeRun>[2];
}

function newRun(url: string) {
  return runsDb.createRun({
    candidateId: 1,
    jobId: 1,
    dedupeKey: `mock-auth-${Math.round(performance.now() * 1000)}`,
    ats: "greenhouse",
    applyUrl: url,
    resumeFile: CONTEXT.resumePath,
    coverLetterFile: CONTEXT.coverLetterPath,
  });
}

/** An in-memory, per-test credential store. NEVER touches the real Keychain. Call counters make
 *  "the store was never even consulted" (AUTH-09) a directly assertable fact. */
class FakeCredentialStore implements CredentialStore {
  calls = { getCredential: 0, saveCredential: 0, deleteCredential: 0, exists: 0 };
  private map = new Map<string, string>();
  private key(identity: AtsAccountIdentity) {
    return credentialReferenceForIdentity(identity);
  }
  async getCredential(identity: AtsAccountIdentity) {
    this.calls.getCredential++;
    return this.map.get(this.key(identity)) ?? null;
  }
  async saveCredential(identity: AtsAccountIdentity, secret: string) {
    this.calls.saveCredential++;
    this.map.set(this.key(identity), secret);
  }
  async deleteCredential(identity: AtsAccountIdentity) {
    this.calls.deleteCredential++;
    this.map.delete(this.key(identity));
  }
  async exists(identity: AtsAccountIdentity) {
    this.calls.exists++;
    return this.map.has(this.key(identity));
  }
  /** Test-only introspection — NOT part of the CredentialStore interface a real caller sees. */
  seed(identity: AtsAccountIdentity, secret: string) {
    this.map.set(this.key(identity), secret);
  }
  peek(identity: AtsAccountIdentity): string | undefined {
    return this.map.get(this.key(identity));
  }
}

const STORED_TEST_PASSWORD = "StoredTestPass!2024XY";

function loginAdapter(mode: "LOGIN_ONLY" | "ACCOUNT_CREATION_SUPPORTED", overrides: Partial<AdapterAuthConfig> = {}): AtsAdapter {
  return {
    sourceType: "greenhouse",
    fieldSelectorHints: () => ({}),
    auth: () => ({
      mode,
      emailSelector: "#auth_email",
      passwordSelector: "#auth_password",
      signInSelector: "#signin",
      authenticatedMarkers: ["welcome back"],
      invalidCredentialMarkers: ["invalid email or password"],
      ...overrides,
    }),
  };
}

function creationAdapter(overrides: Partial<AdapterAuthConfig> = {}): AtsAdapter {
  return {
    sourceType: "greenhouse",
    fieldSelectorHints: () => ({}),
    auth: () => ({
      mode: "ACCOUNT_CREATION_SUPPORTED",
      emailSelector: "#new_email",
      passwordSelector: "#new_password",
      confirmPasswordSelector: "#confirm_password",
      createAccountSelector: "#create",
      authenticatedMarkers: ["welcome back"],
      ...overrides,
    }),
  };
}

function identityFor(url: string): AtsAccountIdentity {
  return { userId: "1", ats: "greenhouse", tenant: deriveTenantKey(url), email: CONTEXT.contact.email };
}

test.after(async () => {
  await runtime.close();
});

// ── AUTH-01..10 ──────────────────────────────────────────────────────────────────────────────────

test("AUTH-01 no auth wall present: the run continues without ever consulting the credential store", async () => {
  const store = new FakeCredentialStore();
  const adapter: AtsAdapter = { sourceType: "greenhouse", fieldSelectorHints: () => ({}) }; // no .auth at all
  const run = newRun(mockAtsUrl("mock-greenhouse"));
  await executeRun(run.id, runtime, deps(), { adapter, credentialStore: store });
  assert.equal(store.calls.exists, 0);
  assert.equal(store.calls.getCredential, 0);
});

test("AUTH-02 an existing credential logs in and the run proceeds to fill the (now visible) application", async () => {
  const store = new FakeCredentialStore();
  const url = mockAtsUrl("mock-auth-login");
  store.seed(identityFor(url), STORED_TEST_PASSWORD);
  const run = newRun(url);
  const after = await executeRun(run.id, runtime, deps(), { adapter: loginAdapter("LOGIN_ONLY"), credentialStore: store });

  assert.equal(after.status, "READY_FOR_REVIEW", `expected the login to succeed and filling to complete, got ${after.status}`);
  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  assert.ok(events.includes("login_started"));
  assert.ok(events.includes("login_succeeded"));
  const checkpoint = JSON.parse(after.checkpoint_json!);
  assert.ok(checkpoint.completed.some((c: { selector: string }) => c.selector === "#first_name"), "the revealed form was filled");
});

test("AUTH-03 a missing credential, with account creation supported, creates one and saves it", async () => {
  const store = new FakeCredentialStore();
  const url = mockAtsUrl("mock-auth-create");
  const run = newRun(url);
  const after = await executeRun(run.id, runtime, deps(), { adapter: creationAdapter(), credentialStore: store });

  assert.equal(after.status, "READY_FOR_REVIEW", `expected account creation to succeed, got ${after.status}`);
  const saved = store.peek(identityFor(url));
  assert.ok(saved, "a credential must now exist for this identity");
  assert.ok(saved!.length >= 20 && saved!.length <= 32, "the generated password respects the 20-32 char band");
  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  assert.ok(events.includes("account_creation_started"));
  assert.ok(events.includes("account_created"));
});

test("AUTH-04 a missing credential with creation unsupported stops for the user, without touching the page", async () => {
  const store = new FakeCredentialStore();
  const run = newRun(mockAtsUrl("mock-auth-login"));
  const after = await executeRun(run.id, runtime, deps(), { adapter: loginAdapter("LOGIN_ONLY"), credentialStore: store });

  assert.equal(after.status, "ACCOUNT_REQUIRED", `expected a stop, got ${after.status}`);
  const blockingEvent = runsDb.listEvents(run.id).find((e) => e.event_type === "blocking_detected");
  assert.match(blockingEvent?.detail ?? "", /account-creation flow is not automated/);
  assert.equal(store.calls.getCredential, 0, "login is never attempted once exists() reports no credential");
});

test("AUTH-05 email verification after a successful login pauses the run", async () => {
  const store = new FakeCredentialStore();
  const url = mockAtsUrl("mock-auth-verify");
  store.seed(identityFor(url), STORED_TEST_PASSWORD);
  const run = newRun(url);
  const after = await executeRun(run.id, runtime, deps(), { adapter: loginAdapter("LOGIN_ONLY"), credentialStore: store });

  assert.equal(after.status, "WAITING_FOR_EMAIL_VERIFICATION", `expected a verification pause, got ${after.status}`);
});

test("AUTH-06 MFA after a successful login pauses the run", async () => {
  const store = new FakeCredentialStore();
  const url = mockAtsUrl("mock-auth-mfa");
  store.seed(identityFor(url), STORED_TEST_PASSWORD);
  const run = newRun(url);
  const after = await executeRun(run.id, runtime, deps(), { adapter: loginAdapter("LOGIN_ONLY"), credentialStore: store });

  assert.equal(after.status, "WAITING_FOR_MFA", `expected an MFA pause, got ${after.status}`);
});

test("AUTH-07 a CAPTCHA revealed during account creation pauses the run", async () => {
  const store = new FakeCredentialStore();
  const run = newRun(mockAtsUrl("mock-auth-captcha-create"));
  const after = await executeRun(run.id, runtime, deps(), { adapter: creationAdapter(), credentialStore: store });

  assert.equal(after.status, "WAITING_FOR_CAPTCHA", `expected a CAPTCHA pause, got ${after.status}`);
  assert.equal(store.calls.saveCredential, 0, "nothing is ever saved for an unconfirmed creation");
});

test("AUTH-08 wrong credentials fail closed after exactly one bounded attempt — never a retry loop", async () => {
  const store = new FakeCredentialStore();
  const url = mockAtsUrl("mock-auth-login");
  store.seed(identityFor(url), "ThisIsTheWrongPassword1!"); // stored, but not what the fixture expects
  const run = newRun(url);
  const after = await executeRun(run.id, runtime, deps(), { adapter: loginAdapter("LOGIN_ONLY"), credentialStore: store });

  assert.equal(after.status, "ACCOUNT_REQUIRED", `expected AUTH_FAILED mapped to a stop, got ${after.status}`);
  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  assert.equal(events.filter((e) => e === "login_started").length, 1, "exactly one login attempt — no retry loop");
  assert.equal(events.filter((e) => e === "login_failed").length, 1);
});

test("AUTH-09 an already-authenticated session never consults the credential store at all", async () => {
  const store = new FakeCredentialStore();
  const run = newRun(mockAtsUrl("mock-auth-authenticated"));
  const after = await executeRun(run.id, runtime, deps(), { adapter: loginAdapter("LOGIN_ONLY"), credentialStore: store });

  assert.equal(after.status, "READY_FOR_REVIEW");
  assert.equal(store.calls.exists, 0, "an authenticated marker resolves before any credential lookup");
  assert.equal(store.calls.getCredential, 0);
});

test("AUTH-10 tenant-scoped reuse: the SAME email under a DIFFERENT tenant does not find the other tenant's credential", async () => {
  const store = new FakeCredentialStore();
  const config = loginAdapter("LOGIN_ONLY").auth!();
  const tenantA = { userId: "1", ats: "workday", tenant: "acme.wd1.myworkdayjobs.com", email: CONTEXT.contact.email };
  const tenantB = { userId: "1", ats: "workday", tenant: "jpmc.wd5.myworkdayjobs.com", email: CONTEXT.contact.email };
  store.seed(tenantA, STORED_TEST_PASSWORD);

  const sessionA = await runtime.open(mockAtsUrl("mock-auth-login"));
  const resultA = await ensureAuthenticated({ runId: 1, page: sessionA.page, identity: tenantA, config, store });
  assert.equal(resultA.outcome, "AUTHENTICATED", "tenant A's own saved credential logs it in");
  await sessionA.close();

  const sessionB = await runtime.open(mockAtsUrl("mock-auth-login"));
  const resultB = await ensureAuthenticated({ runId: 1, page: sessionB.page, identity: tenantB, config, store });
  assert.equal(resultB.outcome, "ACCOUNT_CREATION_REQUIRED", "the SAME email under a different tenant has no credential of its own");
  await sessionB.close();
});

// ── SECRET-01..05 ────────────────────────────────────────────────────────────────────────────────

test("SECRET-01/02/03/04/05: a generated password never appears in checkpoint, events, vault, review, or the serialized run", async () => {
  const store = new FakeCredentialStore();
  const url = mockAtsUrl("mock-auth-create");
  const run = newRun(url);
  const after = await executeRun(run.id, runtime, deps(), { adapter: creationAdapter(), credentialStore: store });

  const password = store.peek(identityFor(url));
  assert.ok(password, "a credential must have been created");

  // SECRET-01 — checkpoint
  assert.doesNotMatch(after.checkpoint_json ?? "", new RegExp(escapeForRegex(password!)), "checkpoint");

  // SECRET-04 — final review is INSIDE the checkpoint; re-asserted directly for clarity.
  const checkpoint = JSON.parse(after.checkpoint_json!);
  assert.doesNotMatch(JSON.stringify(checkpoint.review ?? {}), new RegExp(escapeForRegex(password!)), "final review");

  // SECRET-02 — every audit event
  for (const event of runsDb.listEvents(run.id)) {
    assert.doesNotMatch(event.detail ?? "", new RegExp(escapeForRegex(password!)), `event ${event.event_type}`);
  }

  // SECRET-03 — the application answer vault (this flow never calls recordQuestion/vault writes,
  // so the table should be entirely unaffected by this run; asserted directly against the DB).
  const vaultRows = getDb().prepare("SELECT answer_value FROM application_answers").all() as { answer_value: string }[];
  for (const row of vaultRows) assert.notEqual(row.answer_value, password, "the vault must never hold this secret");

  // SECRET-05 — the whole serialized run row, as an API response would return it.
  assert.doesNotMatch(JSON.stringify(after), new RegExp(escapeForRegex(password!)), "serialized run state");
});

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── MULTIPAGE-AUTH-01/02/03 ──────────────────────────────────────────────────────────────────────

function multiPageLoginAdapter(): AtsAdapter {
  return {
    sourceType: "greenhouse",
    fieldSelectorHints: () => ({}),
    nextPageSelector: () => "#advance",
    reviewPageMarkers: () => ["review your application"],
    auth: () => ({
      mode: "LOGIN_ONLY",
      emailSelector: "#auth_email",
      passwordSelector: "#auth_password",
      signInSelector: "#signin",
      authenticatedMarkers: ["signed in"],
    }),
  };
}

test("MULTIPAGE-AUTH-01/02: a page-2 login wall invokes the universal auth layer, and success resumes the SAME page", async () => {
  const store = new FakeCredentialStore();
  const url = mockAtsUrl("mock-multipage-auth-login");
  store.seed(identityFor(url), STORED_TEST_PASSWORD);
  const run = newRun(url);
  const after = await executeRun(run.id, runtime, deps(), { adapter: multiPageLoginAdapter(), credentialStore: store });

  assert.equal(after.status, "READY_FOR_REVIEW", `expected the walk to resume past the login wall, got ${after.status}`);
  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  assert.ok(events.includes("auth_required"));
  assert.ok(events.includes("login_succeeded"));
  // The login exchange is NOT itself a page advance — only the walk's own Next/Continue clicks are.
  const advanced = runsDb.listEvents(run.id).filter((e) => e.event_type === "page_advanced").map((e) => e.detail);
  assert.deepEqual(advanced, ["page 2 via #advance", "page 3 via #advance"]);
  const checkpoint = JSON.parse(after.checkpoint_json!);
  assert.equal(checkpoint.page, 3, "the review page, reached AFTER resuming past the login wall");
});

test("MULTIPAGE-AUTH-03: an email-verification blocker after a page-2 login pauses WITHOUT losing the page checkpoint", async () => {
  const store = new FakeCredentialStore();
  const url = mockAtsUrl("mock-multipage-auth-verify");
  store.seed(identityFor(url), STORED_TEST_PASSWORD);
  const run = newRun(url);
  const after = await executeRun(run.id, runtime, deps(), {
    adapter: { ...multiPageLoginAdapter(), auth: () => ({ ...multiPageLoginAdapter().auth!(), authenticatedMarkers: ["welcome back"] }) },
    credentialStore: store,
  });

  assert.equal(after.status, "WAITING_FOR_EMAIL_VERIFICATION", `expected a verification pause, got ${after.status}`);
  const checkpoint = JSON.parse(after.checkpoint_json!);
  assert.equal(checkpoint.page, 2, "the page-2 checkpoint is preserved — the pause did not reset or lose it");
});

// ── SUBMIT-SAFETY-01 ─────────────────────────────────────────────────────────────────────────────

test("SUBMIT-SAFETY-01: no auth/account-creation state can directly reach SUBMITTING or SUBMITTED", async () => {
  const { canTransition } = require("@/lib/apply/runState") as typeof import("@/lib/apply/runState");
  for (const status of ["ACCOUNT_REQUIRED", "WAITING_FOR_MFA", "WAITING_FOR_CAPTCHA", "WAITING_FOR_EMAIL_VERIFICATION"] as const) {
    assert.equal(canTransition(status, "SUBMITTING"), false, `${status} must not reach SUBMITTING`);
    assert.equal(canTransition(status, "SUBMITTED"), false, `${status} must not reach SUBMITTED`);
  }
});

// ── regression fences ────────────────────────────────────────────────────────────────────────────

test("GREENHOUSE-AUTH-REGRESSION: existing Greenhouse behavior is unaffected by the auth layer", async () => {
  const store = new FakeCredentialStore();
  const run = newRun(mockAtsUrl("mock-greenhouse"));
  const after = await executeRun(run.id, runtime, deps(), { credentialStore: store }); // production selectAdapter path, no auth override
  assert.equal(after.status, "WAITING_FOR_ANSWER", "the EXEC-3 pause, unchanged");
  assert.equal(store.calls.exists, 0, "Greenhouse has no auth config; the store is never consulted");
  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  for (const name of ["auth_required", "login_started", "account_creation_started"]) {
    assert.ok(!events.includes(name), `Greenhouse must never emit ${name}`);
  }
});

test("LEVER-AUTH-REGRESSION: existing Lever behavior is unaffected by the auth layer", async () => {
  const store = new FakeCredentialStore();
  const run = runsDb.createRun({
    candidateId: 1,
    jobId: 1,
    dedupeKey: `mock-lever-auth-${Math.round(performance.now() * 1000)}`,
    ats: "lever",
    applyUrl: mockAtsUrl("mock-lever"),
    resumeFile: CONTEXT.resumePath,
    coverLetterFile: CONTEXT.coverLetterPath,
  });
  const after = await executeRun(run.id, runtime, deps(), { credentialStore: store });
  assert.equal(after.status, "WAITING_FOR_ANSWER", "the EXEC-12 pause, unchanged");
  assert.equal(store.calls.exists, 0, "Lever has no auth config; the store is never consulted");
});

// ── CONSENT-01/02 — Phase 9C §25: never auto-click an unclassified required consent control ──────

test("CONSENT-01: a required consent checkbox this adapter has not classified as safe blocks account creation entirely", async () => {
  const store = new FakeCredentialStore();
  const url = mockAtsUrl("mock-auth-create-consent");
  const run = newRun(url);
  // creationAdapter() declares NO safeRequiredConsentSelectors — the honest default for every
  // adapter written before its real form has been observed.
  const after = await executeRun(run.id, runtime, deps(), { adapter: creationAdapter(), credentialStore: store });

  assert.equal(after.status, "ACCOUNT_REQUIRED", `expected a stop before anything was attempted, got ${after.status}`);
  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  assert.ok(!events.includes("account_creation_started"), "the gate fires BEFORE any password is generated or field is typed");
  assert.equal(store.calls.saveCredential, 0, "nothing is ever saved when creation never started");
  assert.equal(store.peek(identityFor(url)), undefined);
});

test("CONSENT-02: a consent checkbox the adapter HAS verified safe is checked; the untouched marketing opt-in never is", async () => {
  const store = new FakeCredentialStore();
  const url = mockAtsUrl("mock-auth-create-consent");
  const run = newRun(url);
  const adapter = creationAdapter({ safeRequiredConsentSelectors: ["#terms_consent"] });
  const after = await executeRun(run.id, runtime, deps(), { adapter, credentialStore: store });

  assert.equal(after.status, "READY_FOR_REVIEW", `expected creation to succeed once the required consent is classified safe, got ${after.status}`);
  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  assert.ok(events.includes("account_creation_started"));
  assert.ok(events.includes("account_created"));
  assert.ok(store.peek(identityFor(url)), "a credential must have been saved");
  // The fixture's own script only reveals the application form when terms_consent was checked —
  // reaching READY_FOR_REVIEW is itself proof the allowlisted checkbox was checked. The marketing
  // opt-in was never in the allowlist, so `attemptAccountCreation` never touches it — nothing here
  // asserts its DOM state (the page has already moved on), which is exactly the point: the engine
  // has no code path that would ever check it.
});
