import type { Page } from "playwright";

/** Read the signals `detectBlocking` (and, from Phase 9C, `classifyAuthState`) need from the live
 *  page. Shared by `executor.ts` and `engine/auth.ts` so both read a page the same way — extracted
 *  rather than duplicated to avoid a circular import between the two. */
export async function readPageSignals(page: Page): Promise<{ url: string; text: string; markers: string[] }> {
  const [text, markers] = await Promise.all([
    page.evaluate(() => document.body?.innerText ?? ""),
    page.evaluate(() =>
      [...document.querySelectorAll("[class], iframe[src]")]
        .slice(0, 400)
        .map((el) => `${el.getAttribute("class") ?? ""} ${el.getAttribute("src") ?? ""}`)
    ),
  ]);
  return { url: page.url(), text, markers };
}

/**
 * PHASE 9E.2 — wait until the page STOPS changing.
 *
 * Single-page ATS applications paint asynchronously: the engine can reach a page, or finish
 * authenticating, well before the form it needs actually exists. Both real failures this guards
 * against were found on the live Workday tenant — filling a sign-in form before React attached its
 * handlers (the click then did nothing at all), and discovering zero fields on an authenticated
 * page whose form had not yet rendered.
 *
 * Not a blind sleep: it polls a cheap fingerprint and returns as soon as the page has been stable
 * for `quietMs`, so a fast page costs almost nothing. Capped so an animating or polling page can
 * never hang a run.
 */
export async function waitForQuietPage(page: Page, quietMs = 1500, capMs = 12_000): Promise<void> {
  const fingerprint = async () =>
    page
      .evaluate(() => ({
        url: `${location.origin}${location.pathname}${location.search}`,
        controls: document.querySelectorAll("input, select, textarea, button").length,
        heading: (document.querySelector("h1, h2")?.textContent ?? "").trim().slice(0, 80),
      }))
      .then((v) => JSON.stringify(v))
      .catch(() => "");

  const deadline = Date.now() + capMs;
  let last = await fingerprint();
  let stableSince = Date.now();
  for (;;) {
    await page.waitForTimeout(250).catch(() => null);
    const now = await fingerprint();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return;
    }
    if (Date.now() >= deadline) return;
  }
}
