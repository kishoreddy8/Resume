import type { BlockingCondition } from "./agent/types";

/**
 * PHASE 9C — universal ATS authentication, the parts that decide nothing about a browser.
 *
 * Same split as the multi-page engine (`engine/multiPage.ts`): every DECISION here is a pure
 * function over already-observed signals, so the never-guess rules have tests that do not depend
 * on a browser. The browser half — filling the email/password fields, clicking sign-in, saving a
 * new credential — lives in `engine/auth.ts`, and it is the ONLY place a secret value is ever
 * passed to a page.
 *
 * POLICY BOUNDARY. An adapter describes HOW its login/account UI works (selectors, markers,
 * password-policy metadata). It never decides WHETHER an account may be created, whether a
 * password is acceptable, or whether a consent checkbox is safe to check — those are universal
 * engine decisions, made the same way for every ATS.
 */

export type AuthOutcome =
  | "NO_AUTH_REQUIRED"
  | "AUTHENTICATED"
  | "ACCOUNT_CREATED"
  | "LOGIN_REQUIRED"
  | "ACCOUNT_CREATION_REQUIRED"
  | "EMAIL_VERIFICATION_REQUIRED"
  | "MFA_REQUIRED"
  | "CAPTCHA_REQUIRED"
  | "USER_ACTION_REQUIRED"
  | "AUTH_FAILED"
  | "UNSUPPORTED_AUTH_FLOW";

/** Outcomes under which the application may proceed without anything more from the user. */
const PROCEED_OUTCOMES: readonly AuthOutcome[] = ["NO_AUTH_REQUIRED", "AUTHENTICATED", "ACCOUNT_CREATED"];

export function authOutcomeProceeds(outcome: AuthOutcome): boolean {
  return PROCEED_OUTCOMES.includes(outcome);
}

/**
 * Every non-proceeding outcome maps into the EXISTING blocking vocabulary (`detectBlocking.ts`),
 * so the executor pauses the run through the one blocking→run-status table that already exists
 * (`BLOCKING_STATUS`) rather than a second one. CAPTCHA and MFA keep their own distinct waiting
 * states because the user needs to do a different thing for each; every other non-proceeding
 * outcome collapses to `account_required` (→ `ACCOUNT_REQUIRED`) — the specific reason still
 * reaches the user through `blockingReason`, a string, never a second status enum.
 */
export function authOutcomeToBlockingCondition(outcome: AuthOutcome): BlockingCondition | null {
  switch (outcome) {
    case "NO_AUTH_REQUIRED":
    case "AUTHENTICATED":
    case "ACCOUNT_CREATED":
      return null;
    case "CAPTCHA_REQUIRED":
      return "captcha";
    case "MFA_REQUIRED":
      return "mfa";
    case "EMAIL_VERIFICATION_REQUIRED":
      return "email_verification";
    case "LOGIN_REQUIRED":
    case "ACCOUNT_CREATION_REQUIRED":
    case "USER_ACTION_REQUIRED":
    case "AUTH_FAILED":
    case "UNSUPPORTED_AUTH_FLOW":
      return "account_required";
  }
}

/** Plain-language status, shown to the user. Never includes a secret value — there is nothing here
 *  to include, these are outcome labels, not data. */
export const AUTH_OUTCOME_MESSAGE: Record<AuthOutcome, string> = {
  NO_AUTH_REQUIRED: "Ready to continue application.",
  AUTHENTICATED: "Authenticated.",
  ACCOUNT_CREATED: "Account created.",
  LOGIN_REQUIRED: "Signing in…",
  ACCOUNT_CREATION_REQUIRED: "Creating ATS account…",
  EMAIL_VERIFICATION_REQUIRED: "Email verification required.",
  MFA_REQUIRED: "MFA required.",
  CAPTCHA_REQUIRED: "CAPTCHA requires your action.",
  USER_ACTION_REQUIRED: "This step needs your attention.",
  AUTH_FAILED: "Login failed.",
  UNSUPPORTED_AUTH_FLOW: "This site's sign-in isn't one Career-Ops can automate yet.",
};

// ── the adapter's own contract: describes the UI, decides nothing ────────────────────────────────

export type AdapterAuthMode =
  /** No login/account wall exists for this ATS in practice (Greenhouse, Lever). */
  | "NONE"
  /** A login wall exists, but Career-Ops may only sign an EXISTING account in — never create one. */
  | "LOGIN_ONLY"
  /** A login wall exists and this adapter has observed a safe, automatable account-creation flow. */
  | "ACCOUNT_CREATION_SUPPORTED"
  /** A login/account wall exists that is not safe to automate at all — always a human's job. */
  | "MANUAL_ONLY";

export interface PasswordPolicy {
  minLength?: number;
  maxLength?: number;
}

export interface AdapterAuthConfig {
  mode: AdapterAuthMode;
  emailSelector?: string;
  passwordSelector?: string;
  confirmPasswordSelector?: string;
  signInSelector?: string;
  createAccountSelector?: string;
  /** Lowercased page-text/marker fragments proving the session is authenticated. Checked BEFORE
   *  any credential lookup — an already-authenticated session never touches the credential store. */
  authenticatedMarkers?: string[];
  /** Lowercased fragments proving a login attempt failed (wrong password) specifically, as
   *  distinct from a generic account_required page. Absent means this ATS has no observed wording
   *  for it yet — a failed attempt without this still ends in AUTH_FAILED via the bounded-attempt
   *  rule, just without the more specific text match. */
  invalidCredentialMarkers?: string[];
  passwordPolicy?: PasswordPolicy;
  /**
   * Consent checkboxes this adapter has ITSELF verified, from an observed real form, to be pure,
   * unbundled legal acknowledgements — never a marketing/newsletter opt-in riding along. The engine
   * checks ONLY selectors named here; every other checkbox on an account-creation page is left
   * untouched and, if required, stops the flow (see `auth.ts`'s consent gate). Absent means no
   * consent checkbox on this adapter's form has been classified as safe, which is the honest
   * default for every adapter written before its real form has been observed.
   */
  safeRequiredConsentSelectors?: string[];
}

// ── pure classification ───────────────────────────────────────────────────────────────────────────

export interface AuthPageSignals {
  text: string;
  markers: string[];
}

function hasAny(haystack: string, needles: readonly string[]): boolean {
  if (needles.length === 0) return false;
  const lower = haystack.toLowerCase();
  return needles.some((n) => n.length > 0 && lower.includes(n.toLowerCase()));
}

/**
 * The tenant half of account identity, derived from the application URL's own hostname — never
 * invented, never asked of an adapter. "jpmc.wd5.myworkdayjobs.com" and
 * "acme.wd1.myworkdayjobs.com" are different tenants because they are different hostnames; the
 * SAME hostname is always the same tenant, which is exactly the reuse rule Phase 9C's tenant
 * scoping needs.
 */
export function deriveTenantKey(applyUrl: string): string {
  try {
    return new URL(applyUrl).hostname.toLowerCase();
  } catch {
    return applyUrl.trim().toLowerCase();
  }
}

/**
 * What the current page tells us about auth state, BEFORE any credential is looked up or any field
 * is touched. Order matters and is deliberate:
 *
 *   1. CAPTCHA/MFA/email-verification are read from the SAME generic blocking signals the rest of
 *      the engine already uses (never a second detector), and are checked FIRST — a security
 *      challenge can appear ALONGSIDE an authenticated-looking page (a step-up MFA prompt on an
 *      otherwise "Welcome back" screen), and assuming past a challenge because of nearby friendly
 *      text is exactly the mistake this ordering prevents.
 *   2. Only once no challenge is present does an authenticated marker win outright — a session
 *      already past the wall, with nothing currently demanding the user's attention, is never
 *      re-logged-in.
 *   3. Otherwise, whether a login wall is even present at all is the adapter's own call — an
 *      adapter declaring `mode: "NONE"` (or omitting auth entirely) never reaches LOGIN_REQUIRED
 *      for a page that merely LOOKS like it might ask for one.
 */
export function classifyAuthState(
  signals: AuthPageSignals,
  config: AdapterAuthConfig | null | undefined,
  blockingFromGenericDetector: BlockingCondition | null
): AuthOutcome {
  if (blockingFromGenericDetector === "captcha") return "CAPTCHA_REQUIRED";
  if (blockingFromGenericDetector === "mfa") return "MFA_REQUIRED";
  if (blockingFromGenericDetector === "email_verification") return "EMAIL_VERIFICATION_REQUIRED";

  if (config?.authenticatedMarkers && hasAny(signals.text, config.authenticatedMarkers)) {
    return "AUTHENTICATED";
  }

  if (!config || config.mode === "NONE") return "NO_AUTH_REQUIRED";
  if (config.mode === "MANUAL_ONLY") return "USER_ACTION_REQUIRED";
  return "LOGIN_REQUIRED";
}
