import type { Page } from "playwright";

/**
 * PHASE 9E.2 — clicking a control that may be covered by an overlay.
 *
 * OBSERVED ON A REAL WORKDAY TENANT: some Workday controls sit beneath an overlay
 * `div[data-automation-id="click_filter"]` that intercepts pointer events, so clicking the real
 * `<button>` never lands and times out after 30s. The overlay is what a human's pointer actually
 * hits, and its `aria-label` is NOT reliably the button's own text ("Submit" over a button reading
 * "Sign In"), so it cannot be matched by label.
 *
 * The rule is therefore GEOMETRIC: click whichever overlay covers the target's centre point. On any
 * page with no overlays — every Greenhouse and Lever page, and the authenticated Workday
 * application pages, which carry zero — this is a plain click and nothing changes.
 *
 * This does NOT decide whether a control MAY be clicked. Advance controls are still vetted by
 * `classifyAdvanceControl`, and entry controls by the entry contract's observed-text gate; this
 * only makes an already-authorised click actually land.
 */
export async function clickPossiblyOverlaid(page: Page, selector: string): Promise<void> {
  const target = await page.$(selector);
  if (!target) throw new Error(`control not found: ${selector}`);

  const box = await target.boundingBox();
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (const overlay of await page.$$('[data-automation-id="click_filter"]')) {
      const ob = await overlay.boundingBox();
      if (!ob) continue;
      if (cx >= ob.x && cx <= ob.x + ob.width && cy >= ob.y && cy <= ob.y + ob.height) {
        await overlay.click();
        return;
      }
    }
  }
  await target.click();
}
