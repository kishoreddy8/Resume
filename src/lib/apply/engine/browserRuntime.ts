import { chromium, type Browser, type Page } from "playwright";

/**
 * The browser an application run executes in.
 *
 * NOTHING LAUNCHES UNTIL A RUN IS EXPLICITLY STARTED. This module is imported only by the executor,
 * which is invoked only by the start-run API route, which only a user's click reaches. There is no
 * launch at app startup, none during scanning, none while browsing jobs — asserted by tests that
 * load every page and count browser processes.
 *
 * THE GUARD IS THE FIRST CHECK, AND IT FAILS CLOSED. CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT
 * defaults to ON: unless the user has explicitly set it to "false", the runtime refuses to
 * navigate anywhere that is not a local file. Local file:// pages are what the mock ATS
 * environment uses, so the entire flow is provable without touching an employer's site — and an
 * automated test CANNOT reach a real website even by mistake, because the refusal lives in the
 * runtime rather than in test discipline.
 *
 * Playwright is already this repository's browser layer (the discovery connectors use it); no new
 * automation dependency is introduced.
 *
 * PHASE 9C — SESSION REUSE EXTENSION POINT (not implemented). `open()` always calls
 * `browser.newContext()` with no persisted `storageState`, so every run — including one resuming
 * after a CAPTCHA/MFA/email-verification pause — opens a fresh, cookie-less context and
 * `ensureAuthenticated` runs again from scratch. That is deliberate for this phase: a huge
 * browser-profile-manager was explicitly out of scope, and a stale, silently-reused session is a
 * worse failure mode than one extra sign-in. The safe extension point, if this is ever built, is
 * narrow: `open()` would accept an optional `storageStatePath`, written via
 * `context.storageState({ path })` only after `ensureAuthenticated` returns `AUTHENTICATED` /
 * `ACCOUNT_CREATED`, and read back on the next `open()` for the SAME `AtsAccountIdentity`. That
 * file holds cookies/session tokens — not a password — so it would need the same treatment
 * `credentials.ts` gives a secret: never in SQLite, never logged, never sent anywhere, and invalidated
 * (deleted) the moment login is next attempted and fails. Nothing here builds that; this paragraph
 * only names where it would go.
 */

export function realApplicationAgentDisabled(): boolean {
  /* Explicit "false" is the ONLY thing that enables real navigation. Absent, empty, "0", "off" —
   * everything else keeps the guard on. A safety default should require intent to leave. */
  return process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT !== "false";
}

export function isLocalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

export class NavigationRefusedError extends Error {
  constructor(url: string) {
    super(
      `Real application navigation is disabled (CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT). ` +
        `Refused to open a non-local URL. Set the variable to "false" to enable real runs.`
    );
    this.name = "NavigationRefusedError";
    void url; // deliberately not embedded — a URL can carry tokens, and this message reaches the UI.
  }
}

export interface BrowserSession {
  page: Page;
  close(): Promise<void>;
}

export class ApplicationBrowserRuntime {
  private browser: Browser | null = null;

  /** Launches on first use, only. Constructing the runtime starts nothing. */
  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  async open(url: string): Promise<BrowserSession> {
    if (realApplicationAgentDisabled() && !isLocalUrl(url)) {
      throw new NavigationRefusedError(url);
    }

    const browser = await this.ensureBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    return {
      page,
      close: async () => {
        await context.close().catch(() => {});
      },
    };
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
