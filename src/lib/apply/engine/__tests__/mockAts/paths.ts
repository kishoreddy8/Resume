import path from "node:path";
import { pathToFileURL } from "node:url";

/** file:// URLs for the mock ATS pages — the only URLs the guarded runtime will open. */
export function mockAtsUrl(
  name:
    | "mock-greenhouse"
    | "mock-lever"
    | "mock-captcha"
    | "mock-mfa"
    | "mock-multipage"
    | "mock-multipage-final-label"
    | "mock-multipage-login-wall"
    | "mock-multipage-captcha"
    | "mock-multipage-stuck"
    | "mock-multipage-validation"
    | "mock-controls"
    | "mock-controls-ambiguous"
    | "mock-auth-authenticated"
    | "mock-auth-login"
    | "mock-auth-create"
    | "mock-auth-create-consent"
    | "mock-submit-reauth"
    | "mock-submit-new-question"
    | "mock-already-applied"
    | "mock-auth-verify"
    | "mock-auth-mfa"
    | "mock-auth-captcha-create"
    | "mock-multipage-auth-login"
    | "mock-multipage-auth-verify"
): string {
  return pathToFileURL(path.join(import.meta.dirname, `${name}.html`)).href;
}
