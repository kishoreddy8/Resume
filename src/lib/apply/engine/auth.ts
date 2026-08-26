import type { Page } from "playwright";
import { recordEvent } from "@/db/queries/applicationRuns";
import { detectBlocking } from "../agent/detectBlocking";
import { generatePassword, type AtsAccountIdentity, type CredentialStore } from "../credentials";
import {
  authOutcomeProceeds,
  classifyAuthState,
  AUTH_OUTCOME_MESSAGE,
  type AdapterAuthConfig,
  type AuthOutcome,
  type PasswordPolicy,
} from "../auth";
import { readPageSignals } from "./pageSignals";
import { clickPossiblyOverlaid } from "./clickControl";

/**
 * PHASE 9C — the universal `ensureAuthenticated` orchestration.
 *
 * THIS IS THE ONLY PLACE A SECRET VALUE EVER REACHES A PAGE. `fillSecret` below is the sole
 * function that types a password; it is never routed through `applyPlan`, `FieldPlan`, or
 * `updateCheckpoint`, so no secret can end up in checkpoint JSON, an audit event, the answer vault,
 * or a final review. Every `recordEvent` call in this module carries only ATS/tenant/email
 * metadata or an outcome name — never the secret, never an OTP, never a cookie.
 *
 * BOUNDED, ALWAYS. A login attempt and an account-creation attempt each happen AT MOST ONCE per
 * call. There is no retry loop anywhere in this file — a failure is a reason to stop and hand the
 * browser to the user, not to try again with the same values.
 */

export interface EnsureAuthResult {
  outcome: AuthOutcome;
  detail: string;
}

function hasAny(haystack: string, needles: readonly string[] | undefined): boolean {
  if (!needles || needles.length === 0) return false;
  const lower = haystack.toLowerCase();
  return needles.some((n) => n.length > 0 && lower.includes(n.toLowerCase()));
}

/** The ONLY function that types a secret into a page. Never logged, never wrapped in a plan. */
async function fillSecret(page: Page, selector: string, value: string): Promise<void> {
  await page.fill(selector, value);
}

/**
 * PHASE 9E.2 — did the value actually STICK?
 *
 * SPA HYDRATION RACE, observed on the live Workday sign-in form. The engine reaches that form far
 * faster than a human does — the entry stage advances the moment the page changes, sometimes within
 * a few hundred milliseconds — and `fill` can set a React-controlled input's DOM value before React
 * has attached its handlers. The field then LOOKS correct while React's own state is still empty,
 * so submitting sends blank credentials and the sign-in fails silently. A manual run with a
 * multi-second pause never reproduces it, which is exactly why only the real run found it.
 *
 * The check runs IN THE BROWSER and returns only a boolean. For a secret field the value is
 * length-checked in page context and never crosses back into Node, so no password can be logged,
 * inspected, or captured by this verification.
 */
async function valueDidStick(page: Page, selector: string, expected: string | null): Promise<boolean> {
  return page
    .$eval(
      selector,
      (el, exp) => {
        const value = (el as HTMLInputElement).value ?? "";
        return exp === null ? value.length > 0 : value === exp;
      },
      expected
    )
    .catch(() => false);
}

/**
 * Fill a control and confirm it took, refilling ONCE if it did not. Bounded: never a retry loop,
 * and a value that refuses to stick twice is reported honestly rather than submitted blind.
 */
async function fillAndVerify(page: Page, selector: string, value: string, secret: boolean): Promise<boolean> {
  await fillSecret(page, selector, value);
  if (await valueDidStick(page, selector, secret ? null : value)) return true;

  await page.waitForTimeout(1200).catch(() => null);
  await fillSecret(page, selector, value);
  return valueDidStick(page, selector, secret ? null : value);
}

/** Exported for direct testing — this is a pure helper, not part of the ensureAuthenticated
 *  contract other modules call. */
export function clampPasswordLength(policy: PasswordPolicy | undefined): number {
  const DEFAULT_LENGTH = 24;
  const explicitMin = policy?.minLength;
  const explicitMax = policy?.maxLength;
  const min = explicitMin ?? 20;
  // An EXPLICIT minLength may push the effective max upward — a policy naming minLength: 40 with
  // no maxLength must never silently generate a password below 40 just because the default max
  // (32) is smaller. But an explicit maxLength given ALONE (no minLength stated) is respected
  // exactly as its own constraint, even below the generic 20-character floor.
  const max = explicitMin !== undefined ? Math.max(explicitMin, explicitMax ?? 32) : explicitMax ?? 32;
  return Math.min(Math.max(DEFAULT_LENGTH, min), max);
}

/**
 * Consent checkboxes on the current page. ANY required checkbox not on the adapter's own
 * verified-safe allowlist blocks account creation — an unclassified required consent is exactly
 * the case Career-Ops never guesses at (Phase 9C §25). No named function bindings inside the
 * evaluate callback (see fieldDiscovery/executor precedent — the bundler's helper does not exist
 * in the browser context).
 */
async function findUnclassifiedRequiredConsent(page: Page, safeSelectors: readonly string[]): Promise<boolean> {
  const checkboxes = await page
    .$$eval("input[type=checkbox]", (els) =>
      els.map((el) => ({
        id: (el as HTMLInputElement).id || null,
        required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
      }))
    )
    .catch(() => [] as { id: string | null; required: boolean }[]);
  return checkboxes.some((cb) => {
    if (!cb.required) return false;
    const selector = cb.id ? `#${cb.id}` : null;
    return !selector || !safeSelectors.includes(selector);
  });
}

/**
 * PHASE 9E.2 — wait for the auth attempt to actually RESOLVE, rather than for a fixed interval.
 *
 * A fixed 600ms settle was enough for the local mock fixtures and far too short for a real one: on
 * the live Workday tenant the authenticated shell takes several seconds to render, so a correct
 * sign-in was read as "unconfirmed" and the run stopped at ACCOUNT_REQUIRED with a valid
 * credential. Polling for the FIRST piece of real evidence — success marker, blocking condition, or
 * an explicit invalid-credential message — resolves instantly against a fast page and still gives a
 * slow SPA time to answer. Bounded, so an unresponsive page can never hang the run.
 */
async function settleAfterAuthAttempt(
  page: Page,
  config: AdapterAuthConfig,
  timeoutMs = 20_000
): Promise<{ text: string; markers: string[]; url: string }> {
  const deadline = Date.now() + timeoutMs;
  let latest = await readPageSignals(page);
  for (;;) {
    if (
      hasAny(latest.text, config.authenticatedMarkers) ||
      hasAny(latest.text, config.invalidCredentialMarkers) ||
      detectBlocking(latest) !== null
    ) {
      return latest;
    }
    if (Date.now() >= deadline) return latest;
    await page.waitForTimeout(400).catch(() => null);
    latest = await readPageSignals(page);
  }
}

async function attemptLogin(
  page: Page,
  identity: AtsAccountIdentity,
  config: AdapterAuthConfig,
  store: CredentialStore,
  runId: number
): Promise<EnsureAuthResult> {
  const secret = await store.getCredential(identity);
  if (!secret) {
    return { outcome: "ACCOUNT_CREATION_REQUIRED", detail: "No credential is available to sign in with." };
  }
  if (!config.emailSelector || !config.passwordSelector || !config.signInSelector) {
    return { outcome: "UNSUPPORTED_AUTH_FLOW", detail: "This adapter's login selectors are incomplete." };
  }

  recordEvent(runId, "login_started", `${identity.ats}:${identity.tenant}:${identity.email}`);
  const emailStuck = await fillAndVerify(page, config.emailSelector, identity.email, false);
  const secretStuck = await fillAndVerify(page, config.passwordSelector, secret, true);
  if (!emailStuck || !secretStuck) {
    /* Reported as its own outcome rather than submitted anyway: clicking sign-in with a field that
     * did not take would spend the one permitted attempt against blank credentials, and would look
     * indistinguishable from a wrong password. */
    recordEvent(runId, "login_field_not_accepted", emailStuck ? "password field" : "email field");
    return {
      outcome: "AUTH_FAILED",
      detail: "The sign-in form did not accept the credentials being entered; stopped without attempting a blind sign-in.",
    };
  }
  /* Overlay-aware: Workday covers its auth buttons with a click_filter div that intercepts pointer
   * events, so a plain click never lands. A no-op on every ATS without overlays. */
  await clickPossiblyOverlaid(page, config.signInSelector);

  const after = await settleAfterAuthAttempt(page, config);
  const blocking = detectBlocking(after);
  if (blocking === "captcha") {
    recordEvent(runId, "captcha_required", null);
    return { outcome: "CAPTCHA_REQUIRED", detail: AUTH_OUTCOME_MESSAGE.CAPTCHA_REQUIRED };
  }
  if (blocking === "mfa") {
    recordEvent(runId, "mfa_required", null);
    return { outcome: "MFA_REQUIRED", detail: AUTH_OUTCOME_MESSAGE.MFA_REQUIRED };
  }
  if (blocking === "email_verification") {
    recordEvent(runId, "email_verification_required", null);
    return { outcome: "EMAIL_VERIFICATION_REQUIRED", detail: AUTH_OUTCOME_MESSAGE.EMAIL_VERIFICATION_REQUIRED };
  }
  if (hasAny(after.text, config.authenticatedMarkers)) {
    recordEvent(runId, "login_succeeded", `${identity.ats}:${identity.tenant}`);
    return { outcome: "AUTHENTICATED", detail: AUTH_OUTCOME_MESSAGE.AUTHENTICATED };
  }

  /* Bounded: exactly one attempt. Never retried with the same, or a re-derived, credential.
   *
   * The recorded detail includes a short, NON-SECRET excerpt of what the page actually said. A bare
   * "unconfirmed" is undiagnosable — it cannot distinguish a wrong password from a marker that
   * simply never matched. The excerpt is page-visible text only: the password was typed into a
   * password input, is never rendered back, and no credential, cookie or token can appear here. */
  const excerpt = after.text.replace(/\s+/g, " ").trim().slice(0, 200);
  recordEvent(
    runId,
    "login_failed",
    hasAny(after.text, config.invalidCredentialMarkers) ? `invalid_credentials | ${excerpt}` : `unconfirmed | ${excerpt}`
  );
  return {
    outcome: "AUTH_FAILED",
    detail: "Sign-in was attempted once and could not be confirmed; stopped rather than retrying.",
  };
}

async function attemptAccountCreation(
  page: Page,
  identity: AtsAccountIdentity,
  config: AdapterAuthConfig,
  store: CredentialStore,
  runId: number
): Promise<EnsureAuthResult> {
  if (!identity.email) {
    return { outcome: "ACCOUNT_CREATION_REQUIRED", detail: "No candidate application email is available; account creation is blocked." };
  }
  if (!config.emailSelector || !config.passwordSelector || !config.createAccountSelector) {
    return { outcome: "UNSUPPORTED_AUTH_FLOW", detail: "This adapter's account-creation selectors are incomplete." };
  }
  if (await findUnclassifiedRequiredConsent(page, config.safeRequiredConsentSelectors ?? [])) {
    return {
      outcome: "USER_ACTION_REQUIRED",
      detail: "This account-creation page has a required consent control Career-Ops has not verified as safe.",
    };
  }

  recordEvent(runId, "account_creation_started", `${identity.ats}:${identity.tenant}:${identity.email}`);
  const password = generatePassword(clampPasswordLength(config.passwordPolicy));
  await fillSecret(page, config.emailSelector, identity.email);
  await fillSecret(page, config.passwordSelector, password);
  if (config.confirmPasswordSelector) await fillSecret(page, config.confirmPasswordSelector, password);
  for (const selector of config.safeRequiredConsentSelectors ?? []) {
    await page.check(selector).catch(() => null);
  }
  await clickPossiblyOverlaid(page, config.createAccountSelector);

  const after = await settleAfterAuthAttempt(page, config);
  const blocking = detectBlocking(after);
  if (blocking === "captcha") {
    recordEvent(runId, "captcha_required", null);
    return { outcome: "CAPTCHA_REQUIRED", detail: AUTH_OUTCOME_MESSAGE.CAPTCHA_REQUIRED };
  }
  if (blocking === "mfa") {
    recordEvent(runId, "mfa_required", null);
    return { outcome: "MFA_REQUIRED", detail: AUTH_OUTCOME_MESSAGE.MFA_REQUIRED };
  }
  if (blocking === "email_verification") {
    recordEvent(runId, "email_verification_required", null);
    return { outcome: "EMAIL_VERIFICATION_REQUIRED", detail: AUTH_OUTCOME_MESSAGE.EMAIL_VERIFICATION_REQUIRED };
  }
  if (hasAny(after.text, config.authenticatedMarkers)) {
    /* The secret is saved ONLY once the page itself confirms the account exists and is signed in —
     * never speculatively, never before this evidence. */
    await store.saveCredential(identity, password);
    recordEvent(runId, "account_created", `${identity.ats}:${identity.tenant}:${identity.email}`);
    return { outcome: "ACCOUNT_CREATED", detail: AUTH_OUTCOME_MESSAGE.ACCOUNT_CREATED };
  }

  /* Bounded: exactly one attempt. Nothing is saved — an unconfirmed creation is not a credential. */
  return {
    outcome: "AUTH_FAILED",
    detail: "Account creation was attempted once and could not be confirmed; stopped rather than retrying.",
  };
}

/**
 * The single entry point every ATS adapter shares. Adapters describe their UI through
 * `AdapterAuthConfig`; this function is the only place that decides what to DO with that
 * description — an adapter cannot express "just create an account" as policy, only as UI facts.
 */
export async function ensureAuthenticated(input: {
  runId: number;
  page: Page;
  identity: AtsAccountIdentity;
  config: AdapterAuthConfig | null | undefined;
  store: CredentialStore;
}): Promise<EnsureAuthResult> {
  const { runId, page, identity, config, store } = input;

  const signals = await readPageSignals(page);
  const genericBlocking = detectBlocking(signals);
  const outcome = classifyAuthState(signals, config, genericBlocking);

  if (authOutcomeProceeds(outcome)) {
    if (outcome === "AUTHENTICATED") recordEvent(runId, "auth_resumed", `${identity.ats}:${identity.tenant}`);
    return { outcome, detail: AUTH_OUTCOME_MESSAGE[outcome] };
  }
  if (outcome === "CAPTCHA_REQUIRED") {
    recordEvent(runId, "captcha_required", null);
    return { outcome, detail: AUTH_OUTCOME_MESSAGE[outcome] };
  }
  if (outcome === "MFA_REQUIRED") {
    recordEvent(runId, "mfa_required", null);
    return { outcome, detail: AUTH_OUTCOME_MESSAGE[outcome] };
  }
  if (outcome === "EMAIL_VERIFICATION_REQUIRED") {
    recordEvent(runId, "email_verification_required", null);
    return { outcome, detail: AUTH_OUTCOME_MESSAGE[outcome] };
  }
  if (outcome === "USER_ACTION_REQUIRED") {
    /* config.mode === "MANUAL_ONLY" — the adapter itself says this wall is not automatable. */
    return { outcome, detail: AUTH_OUTCOME_MESSAGE[outcome] };
  }

  /* outcome === "LOGIN_REQUIRED": mode is LOGIN_ONLY or ACCOUNT_CREATION_SUPPORTED. */
  recordEvent(runId, "auth_required", `${identity.ats}:${identity.tenant}`);
  const hasCredential = await store.exists(identity);
  recordEvent(runId, hasCredential ? "credential_found" : "credential_missing", `${identity.ats}:${identity.tenant}`);

  if (hasCredential) {
    return attemptLogin(page, identity, config!, store, runId);
  }
  if (config!.mode !== "ACCOUNT_CREATION_SUPPORTED") {
    return {
      outcome: "ACCOUNT_CREATION_REQUIRED",
      detail: "No saved credential exists and this ATS's account-creation flow is not automated.",
    };
  }
  return attemptAccountCreation(page, identity, config!, store, runId);
}
