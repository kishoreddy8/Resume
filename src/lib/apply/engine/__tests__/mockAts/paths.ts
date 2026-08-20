import path from "node:path";
import { pathToFileURL } from "node:url";

/** file:// URLs for the mock ATS pages — the only URLs the guarded runtime will open. */
export function mockAtsUrl(name: "mock-greenhouse" | "mock-lever" | "mock-captcha" | "mock-mfa"): string {
  return pathToFileURL(path.join(import.meta.dirname, `${name}.html`)).href;
}
