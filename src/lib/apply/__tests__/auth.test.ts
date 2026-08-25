import test from "node:test";
import assert from "node:assert/strict";
import {
  authOutcomeProceeds,
  authOutcomeToBlockingCondition,
  classifyAuthState,
  deriveTenantKey,
  type AdapterAuthConfig,
} from "../auth";

/**
 * PHASE 9C — pure auth decisions. No browser, no Keychain: same discipline as planFields and
 * multiPage's own pure half.
 */

// ── tenant derivation ────────────────────────────────────────────────────────────────────────────

test("deriveTenantKey: the URL's own hostname, lowercased — never invented", () => {
  assert.equal(deriveTenantKey("https://JPMC.WD5.MyWorkdayJobs.com/apply/123"), "jpmc.wd5.myworkdayjobs.com");
  assert.equal(deriveTenantKey("https://acme.wd1.myworkdayjobs.com/en-US/careers"), "acme.wd1.myworkdayjobs.com");
});

test("deriveTenantKey: two different hostnames are two different tenants (the JPMC vs Acme case from the spec)", () => {
  const a = deriveTenantKey("https://jpmc.wd5.myworkdayjobs.com/apply");
  const b = deriveTenantKey("https://acme.wd1.myworkdayjobs.com/apply");
  assert.notEqual(a, b);
});

test("deriveTenantKey: an unparseable URL falls back to the trimmed, lowercased string rather than throwing", () => {
  assert.equal(deriveTenantKey("  Not-A-URL  "), "not-a-url");
});

// ── outcome plumbing ─────────────────────────────────────────────────────────────────────────────

test("authOutcomeProceeds: only the three continue-the-application outcomes proceed", () => {
  for (const o of ["NO_AUTH_REQUIRED", "AUTHENTICATED", "ACCOUNT_CREATED"] as const) {
    assert.equal(authOutcomeProceeds(o), true, o);
  }
  for (const o of [
    "LOGIN_REQUIRED",
    "ACCOUNT_CREATION_REQUIRED",
    "EMAIL_VERIFICATION_REQUIRED",
    "MFA_REQUIRED",
    "CAPTCHA_REQUIRED",
    "USER_ACTION_REQUIRED",
    "AUTH_FAILED",
    "UNSUPPORTED_AUTH_FLOW",
  ] as const) {
    assert.equal(authOutcomeProceeds(o), false, o);
  }
});

test("authOutcomeToBlockingCondition: maps into the EXISTING BlockingCondition vocabulary, never a second one", () => {
  assert.equal(authOutcomeToBlockingCondition("CAPTCHA_REQUIRED"), "captcha");
  assert.equal(authOutcomeToBlockingCondition("MFA_REQUIRED"), "mfa");
  assert.equal(authOutcomeToBlockingCondition("EMAIL_VERIFICATION_REQUIRED"), "email_verification");
  for (const o of ["LOGIN_REQUIRED", "ACCOUNT_CREATION_REQUIRED", "USER_ACTION_REQUIRED", "AUTH_FAILED", "UNSUPPORTED_AUTH_FLOW"] as const) {
    assert.equal(authOutcomeToBlockingCondition(o), "account_required", o);
  }
  for (const o of ["NO_AUTH_REQUIRED", "AUTHENTICATED", "ACCOUNT_CREATED"] as const) {
    assert.equal(authOutcomeToBlockingCondition(o), null, o);
  }
});

// ── classifyAuthState ────────────────────────────────────────────────────────────────────────────

const NO_AUTH: AdapterAuthConfig | undefined = undefined;
const LOGIN_ONLY: AdapterAuthConfig = { mode: "LOGIN_ONLY", authenticatedMarkers: ["welcome back"] };
const CREATION_SUPPORTED: AdapterAuthConfig = { mode: "ACCOUNT_CREATION_SUPPORTED", authenticatedMarkers: ["welcome back"] };
const MANUAL_ONLY: AdapterAuthConfig = { mode: "MANUAL_ONLY" };

test("AUTH-01 (pure half): an adapter with no auth config, or mode NONE, never requires auth", () => {
  assert.equal(classifyAuthState({ text: "anything at all", markers: [] }, NO_AUTH, null), "NO_AUTH_REQUIRED");
  assert.equal(classifyAuthState({ text: "sign in to continue", markers: [] }, { mode: "NONE" }, null), "NO_AUTH_REQUIRED");
});

test("a login wall with LOGIN_ONLY or ACCOUNT_CREATION_SUPPORTED classifies as LOGIN_REQUIRED", () => {
  assert.equal(classifyAuthState({ text: "please sign in", markers: [] }, LOGIN_ONLY, null), "LOGIN_REQUIRED");
  assert.equal(classifyAuthState({ text: "please sign in", markers: [] }, CREATION_SUPPORTED, null), "LOGIN_REQUIRED");
});

test("MANUAL_ONLY always stops for the user — the adapter itself says this wall is not automatable", () => {
  assert.equal(classifyAuthState({ text: "please sign in", markers: [] }, MANUAL_ONLY, null), "USER_ACTION_REQUIRED");
});

test("an authenticated marker wins outright — a session already past the wall is never re-logged-in (AUTH-09, pure half)", () => {
  assert.equal(classifyAuthState({ text: "Welcome back, Jordan", markers: [] }, LOGIN_ONLY, null), "AUTHENTICATED");
});

test("CAPTCHA/MFA/email-verification, read from the SAME generic blocking signal, outrank the adapter's own mode", () => {
  assert.equal(classifyAuthState({ text: "irrelevant", markers: [] }, LOGIN_ONLY, "captcha"), "CAPTCHA_REQUIRED");
  assert.equal(classifyAuthState({ text: "irrelevant", markers: [] }, LOGIN_ONLY, "mfa"), "MFA_REQUIRED");
  assert.equal(classifyAuthState({ text: "irrelevant", markers: [] }, LOGIN_ONLY, "email_verification"), "EMAIL_VERIFICATION_REQUIRED");
});

test("a security challenge is detected even where an authenticated marker is ALSO present — never assume past a challenge", () => {
  assert.equal(classifyAuthState({ text: "Welcome back — verify it's you", markers: [] }, LOGIN_ONLY, "mfa"), "MFA_REQUIRED");
});

// ── clampPasswordLength (engine/auth.ts) ────────────────────────────────────────────────────────

test("clampPasswordLength: default with no policy is 24, within the 20-32 band", async () => {
  const { clampPasswordLength } = await import("../engine/auth");
  assert.equal(clampPasswordLength(undefined), 24);
});

test("clampPasswordLength: an adapter-declared minLength is NEVER undercut by the default maxLength when maxLength is omitted (found during Phase 9D.1 review)", async () => {
  const { clampPasswordLength } = await import("../engine/auth");
  assert.equal(clampPasswordLength({ minLength: 40 }), 40, "a 40-char minimum must produce at least 40 characters, not be capped to the default 32");
});

test("clampPasswordLength: an explicit maxLength below the default is respected", async () => {
  const { clampPasswordLength } = await import("../engine/auth");
  assert.equal(clampPasswordLength({ maxLength: 15 }), 15);
});

test("clampPasswordLength: a contradictory policy (minLength > maxLength) resolves toward the safer, longer value", async () => {
  const { clampPasswordLength } = await import("../engine/auth");
  assert.equal(clampPasswordLength({ minLength: 40, maxLength: 20 }), 40);
});
