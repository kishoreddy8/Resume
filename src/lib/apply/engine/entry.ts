import type { Page } from "playwright";
import { recordEvent } from "@/db/queries/applicationRuns";
import type { AtsAdapter } from "../agent/types";
import { clickPossiblyOverlaid } from "./clickControl";
import { waitForQuietPage } from "./pageSignals";
import {
  boundEntrySteps,
  entryControlTextMatches,
  validateEntryStep,
  type ApplicationEntryStep,
  type EntryOutcome,
} from "../entry";

/**
 * PHASE 9E.2 — the browser half of the application-entry stage.
 *
 * Same split as the rest of this engine: every DECISION is a pure function in `../entry.ts`; this
 * file only drives a page. It runs ONCE, at the start of a run, before any field is discovered or
 * filled — so an entry click can never be a submission of filled data.
 *
 * BOUNDED AND EVIDENCE-DRIVEN. Each step must (1) resolve to its exact declared selector, (2) still
 * carry the text it was observed carrying, and (3) produce an observable transition before the next
 * step is attempted. Any of those failing stops the run; nothing is ever clicked twice.
 */

export interface EntryResult {
  outcome: EntryOutcome;
  stepsTaken: number;
  detail: string;
}

/** A page fingerprint sufficient to prove an entry click did something. Deliberately cheap. */
async function entryFingerprint(page: Page): Promise<string> {
  const parts = await page
    .evaluate(() => ({
      /* The hash is deliberately EXCLUDED. Entry controls are frequently `<a href="#">`, and
       * clicking one changes location.href without changing the page at all — counting that as a
       * transition let the sequence march on to a step that was never reached. A genuine SPA
       * transition still registers through the path, control count, heading, or automation ids
       * below, so dropping the fragment loses nothing real. */
      url: `${location.origin}${location.pathname}${location.search}`,
      controls: [...document.querySelectorAll("input, select, textarea, button, a[role=button]")].length,
      firstHeading: (document.querySelector("h1, h2")?.textContent ?? "").trim().slice(0, 80),
      automationIds: [...document.querySelectorAll("[data-automation-id]")]
        .slice(0, 40)
        .map((el) => el.getAttribute("data-automation-id"))
        .join(","),
    }))
    .catch(() => null);
  return parts ? JSON.stringify(parts) : "";
}

/**
 * Every text the control offers, for the observed-text equality check.
 *
 * WAITS for the control rather than sampling once. `runtime.open()` resolves on `domcontentloaded`,
 * but a Workday posting is a single-page app that paints its Apply control afterwards — a single
 * `page.$()` therefore found nothing and the first real run failed with ENTRY_STEP_MISSING against
 * a control that was demonstrably there moments later. A REQUIRED step waits long enough for an SPA
 * to render; an OPTIONAL one waits only briefly, since its genuine absence is the common case and
 * must not cost the full timeout on every run.
 */
async function readControlTexts(page: Page, selector: string, optional: boolean): Promise<string[] | null> {
  const el = await page
    .waitForSelector(selector, { state: "attached", timeout: optional ? 4000 : 15_000 })
    .catch(() => null);
  if (!el) return null;
  return el
    .evaluate((node) =>
      [
        ((node as HTMLElement).innerText ?? "").trim(),
        (node.getAttribute("aria-label") ?? "").trim(),
        (node.getAttribute("value") ?? "").trim(),
        (node.getAttribute("title") ?? "").trim(),
      ].filter((v) => v.length > 0)
    )
    .catch(() => null);
}

/**
 * Walk the adapter's declared entry sequence.
 *
 * Returns `NO_ENTRY_CONTRACT` when the adapter declares none, which is the Greenhouse/Lever path
 * and does not touch the page at all.
 */
export async function openApplication(input: {
  runId: number;
  page: Page;
  adapter: AtsAdapter | null;
}): Promise<EntryResult> {
  const { runId, page, adapter } = input;

  const declared: ApplicationEntryStep[] = adapter?.entrySequence?.() ?? [];
  if (declared.length === 0) {
    return { outcome: "NO_ENTRY_CONTRACT", stepsTaken: 0, detail: "This ATS's apply URL is the form itself." };
  }

  /* Static contract validation BEFORE any browser action: a step that could never be a pre-form
   * control is refused outright rather than trusted and clicked. */
  for (const step of declared) {
    const check = validateEntryStep(step);
    if (!check.ok) {
      recordEvent(runId, "entry_contract_invalid", check.reason);
      return { outcome: "ENTRY_CONTRACT_INVALID", stepsTaken: 0, detail: check.reason };
    }
  }

  const bound = boundEntrySteps(adapter?.entryMaxSteps?.());
  let taken = 0;

  for (const step of declared) {
    if (taken >= bound) {
      recordEvent(runId, "entry_step_limit_reached", `${taken} of at most ${bound}`);
      return { outcome: "ENTRY_STEP_LIMIT", stepsTaken: taken, detail: `entry exceeded ${bound} steps` };
    }

    const texts = await readControlTexts(page, step.selector, step.optional === true);
    if (texts === null) {
      if (step.optional) {
        recordEvent(runId, "entry_step_skipped", `${step.selector} (optional, not present)`);
        continue;
      }
      recordEvent(runId, "entry_step_missing", step.selector);
      return { outcome: "ENTRY_STEP_MISSING", stepsTaken: taken, detail: `required entry control absent: ${step.selector}` };
    }

    /* The observed-text gate. A selector that now carries different text is a control this adapter
     * has never seen, and is never clicked on the assumption it is still the same button. */
    if (!entryControlTextMatches(step.expectedText, texts)) {
      recordEvent(
        runId,
        "entry_control_changed",
        `${step.selector}: expected ${JSON.stringify(step.expectedText)}, found ${JSON.stringify(texts.join(" | ")).slice(0, 120)}`
      );
      return {
        outcome: "ENTRY_CONTROL_CHANGED",
        stepsTaken: taken,
        detail: `entry control ${step.selector} no longer reads "${step.expectedText}"`,
      };
    }

    const before = await entryFingerprint(page);
    await clickPossiblyOverlaid(page, step.selector);
    taken++;

    /* Bounded wait for observable evidence the click did something. Polled rather than slept, and
     * capped — the same convention the multi-page walk uses. */
    let transitioned = false;
    const deadline = Date.now() + 8000;
    for (;;) {
      await page.waitForTimeout(250).catch(() => null);
      const after = await entryFingerprint(page);
      if (after !== before && after.length > 0) {
        transitioned = true;
        break;
      }
      if (Date.now() >= deadline) break;
    }

    if (!transitioned) {
      /* A dismissable notice that was already gone is not a failure; a navigation control that did
       * nothing is. Either way the control is NEVER clicked a second time. */
      if (step.kind === "dismiss_notice") {
        recordEvent(runId, "entry_step_no_transition", `${step.selector} (notice; continuing)`);
        continue;
      }
      recordEvent(runId, "entry_step_no_transition", step.selector);
      return {
        outcome: "ENTRY_NO_TRANSITION",
        stepsTaken: taken,
        detail: `entry control ${step.selector} produced no transition; not retried`,
      };
    }

    recordEvent(runId, "entry_step_completed", `${step.kind}: ${step.selector}`);
  }

  /* PHASE 9E.2 — hand a SETTLED page to the rest of the pipeline.
   *
   * Each step above advances the moment the page CHANGES, which is the right test for "did the
   * click do something" but the wrong moment to start typing: on the live Workday sign-in form the
   * engine filled and clicked within a few hundred milliseconds of the form appearing, the values
   * stuck in the DOM, and the click did nothing at all — no error, still signed out — because
   * React had not finished attaching the form's handlers. A manual run with a multi-second pause
   * never reproduced it.
   *
   * So rather than a blind sleep, wait for the page to STOP changing: stable for `quietMs`, capped
   * so an animating page can never hang the run. This is what "the page finished loading" means to
   * a human, and it costs a fast page almost nothing. */
  await waitForQuietPage(page);
  return { outcome: "PROCEED", stepsTaken: taken, detail: `entry completed in ${taken} step(s)` };
}
