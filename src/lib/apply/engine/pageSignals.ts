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
