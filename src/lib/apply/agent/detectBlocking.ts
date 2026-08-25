import type { BlockingCondition } from "./types";

/**
 * Recognising when a page needs a human.
 *
 * CAREER-OPS NEVER SOLVES ANY OF THESE. Detection exists so the run can STOP and hand the browser
 * back to the user — there is no CAPTCHA service, no anti-bot evasion, no reading of one-time codes
 * from anywhere. A CAPTCHA is a site saying it wants a person, and the correct response is to fetch
 * one.
 *
 * Detection is on visible markers, and a false positive is cheap: the run pauses, the user looks,
 * and resumes. A false negative is expensive, so the checks are deliberately generous.
 */

export interface PageSignals {
  url: string;
  /** Visible text, lowercased by the caller or not — matching is case-insensitive. */
  text: string;
  /** Selectors/iframe hosts present on the page. */
  markers: string[];
}

const CAPTCHA_MARKERS = ["recaptcha", "hcaptcha", "cf-turnstile", "captcha", "arkoselabs", "funcaptcha"];
const MFA_TEXT = [
  "two-factor", "two factor", "2fa", "authentication code", "verification code",
  "one-time code", "one time passcode", "authenticator app", "security code",
];
const EMAIL_VERIFY_TEXT = ["verify your email", "confirm your email", "verification email", "check your inbox"];
const ACCOUNT_TEXT = ["create an account", "sign in to apply", "log in to apply", "create account to continue", "register to apply"];

function hasAny(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

export function detectBlocking(signals: PageSignals): BlockingCondition | null {
  const markers = signals.markers.join(" ").toLowerCase();

  /* CAPTCHA first: it gates everything behind it, and mistaking it for a login loop would send the
   * user to do the wrong thing. */
  if (hasAny(markers, CAPTCHA_MARKERS) || hasAny(signals.text, ["i'm not a robot", "i am not a robot"])) {
    return "captcha";
  }
  if (hasAny(signals.text, MFA_TEXT)) return "mfa";
  if (hasAny(signals.text, EMAIL_VERIFY_TEXT)) return "email_verification";
  if (hasAny(signals.text, ACCOUNT_TEXT)) return "account_required";
  return null;
}

/**
 * PHASE 9D — the ATS itself reporting the application already exists. A DELIBERATELY SEPARATE
 * check, not a `BlockingCondition` member: every existing condition above means "a human needs to
 * do something and the run may then continue" — this one means the opposite, there is nothing left
 * to do, ever, for this run. The caller maps a true result straight to the existing terminal
 * `FAILED` status (matching how "no application URL" already fails a run before it starts) rather
 * than a new waiting state the user would be asked to act on.
 */
const ALREADY_APPLIED_TEXT = [
  "you have already applied",
  "you have already submitted an application",
  "an application already exists for this job",
  "you've already applied",
];

export function detectAlreadyApplied(signals: PageSignals): boolean {
  return hasAny(signals.text, ALREADY_APPLIED_TEXT);
}

/** The run status each condition maps to. Kept beside the detector so the two cannot drift. */
export const BLOCKING_STATUS = {
  captcha: "WAITING_FOR_CAPTCHA",
  mfa: "WAITING_FOR_MFA",
  email_verification: "WAITING_FOR_EMAIL_VERIFICATION",
  account_required: "ACCOUNT_REQUIRED",
  unknown_question: "WAITING_FOR_ANSWER",
} as const;
