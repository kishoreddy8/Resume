import test from "node:test";
import assert from "node:assert/strict";
import { workdayAdapter } from "@/lib/apply/agent/adapters/workday";
import { resolveMultiPageConfig, classifyAdvanceControl } from "../multiPage";

/**
 * PHASE 9E — the Workday adapter's declared contract, and the two observed traps it exists to
 * avoid. Pure: no browser, no network. Every expectation mirrors markup captured read-only from a
 * live tenant on 2026-08-25 (see adapters/workday.ts for provenance).
 */

// ── advance control ──────────────────────────────────────────────────────────────────────────────

test("WORKDAY-ADVANCE-01: the observed footer control is where the adapter says it is", () => {
  assert.equal(workdayAdapter.nextPageSelector!(), '[data-automation-id="pageFooterNextButton"]');
});

test("WORKDAY-ADVANCE-02: the observed visible text 'Save and Continue' classifies as a SAFE advance", () => {
  assert.equal(classifyAdvanceControl(["Save and Continue"]), "safe_advance");
});

test("WORKDAY-ADVANCE-03: the adapter never bypasses the classifier — it only says WHERE, never WHETHER", () => {
  /* The adapter declares a selector. It has no way to express "click this regardless", and the
   * executor routes every advance through classifyAdvanceControl before clicking. This test pins
   * that the adapter surface offers no such escape hatch. */
  const declared = Object.keys(workdayAdapter);
  for (const key of declared) {
    assert.doesNotMatch(key, /force|bypass|skipClassif|alwaysClick/i, `${key} must not be a classifier bypass`);
  }
});

test("ADVANCE-SAFETY-WORKDAY-01: a mixed signal containing a final action is BLOCKED even with a safe phrase present", () => {
  assert.equal(classifyAdvanceControl(["Save and Continue", "Submit Application"]), "final_action");
  assert.equal(classifyAdvanceControl(["Save and Continue", "Submit"]), "final_action");
});

test("ADVANCE-SAFETY-WORKDAY-02: the overlay's own aria-label is classified too — an overlay labelled Submit blocks", () => {
  /* OBSERVED: on Workday's AUTH forms every button is covered by a
   * div[data-automation-id="click_filter"] whose aria-label does NOT match the button's text (the
   * sign-in button's overlay reads "Submit"). On the authenticated APPLICATION pages there are ZERO
   * such overlays — the footer button is directly clickable. Whenever an overlay does exist, its
   * label is one more text the classifier must see, and a final-action reading must win. */
  assert.equal(classifyAdvanceControl(["Sign In", "Submit"]), "final_action");
  assert.equal(classifyAdvanceControl(["Save and Continue", "Continue"]), "safe_advance");
});

// ── review-page trap ─────────────────────────────────────────────────────────────────────────────

test("WORKDAY-REVIEW-01: the adapter offers NO text marker, so the navigator's inactive 'Review' cannot stop the walk", () => {
  assert.deepEqual(
    workdayAdapter.reviewPageMarkers!(),
    [],
    "Workday prints every step name including 'Review' on every page; a text marker would fire on page 1"
  );
  const config = resolveMultiPageConfig(workdayAdapter);
  assert.deepEqual(config!.reviewMarkers, [], "no text marker reaches the engine");
});

test("WORKDAY-REVIEW-02: the structural marker targets the ACTIVE step specifically", () => {
  const selector = workdayAdapter.reviewPageSelector!();
  assert.match(selector, /progressBarActiveStep/, "must key on the ACTIVE step, observed as progressBarActiveStep");
  assert.doesNotMatch(selector, /progressBarInactiveStep/, "must never match an inactive navigator item");
  assert.match(selector, /Review/, "and specifically the step named Review");

  const config = resolveMultiPageConfig(workdayAdapter);
  assert.equal(config!.reviewSelector, selector, "the engine receives the structural test");
});

test("WORKDAY-REVIEW-03/04: the adapter names no final-submit control anywhere in its contract", () => {
  /* Review detection happens before the advance control is read (see executor.ts), and the adapter
   * gives the engine no way to reach a Submit control: its only click target is the footer Next
   * control, which the classifier independently vets. */
  /* The APPLICATION surface — everything the multi-page walk can click — names no submit control
   * of any kind. Its only click target is the footer Next control. */
  const applicationSurface = JSON.stringify({
    hints: workdayAdapter.fieldSelectorHints(),
    next: workdayAdapter.nextPageSelector!(),
    review: workdayAdapter.reviewPageSelector!(),
    login: workdayAdapter.loginWallMarkers!(),
  });
  assert.doesNotMatch(applicationSurface, /submit/i, "the application surface declares no submit control at all");

  /* The AUTH surface legitimately names ONE submit control — the sign-in button, which
   * ensureAuthenticated clicks to authenticate. That is not an application submit, and it is the
   * only submit-shaped selector anywhere in this adapter. */
  const auth = workdayAdapter.auth!();
  const authSubmitSelectors = Object.entries(auth)
    .filter(([, v]) => typeof v === "string" && /submit/i.test(v))
    .map(([k, v]) => `${k}=${v}`);
  assert.deepEqual(
    authSubmitSelectors,
    ['signInSelector=[data-automation-id="signInSubmitButton"]'],
    "the sign-in button is the ONLY submit-shaped selector, and it belongs to authentication"
  );
});

// ── contract resolution ─────────────────────────────────────────────────────────────────────────

test("the adapter's page bound reflects the OBSERVED 7-step authenticated flow", () => {
  const config = resolveMultiPageConfig(workdayAdapter);
  assert.equal(config!.maxPages, 8, "observed 7 steps, bounded at 8, under the engine's own hard cap");
});

test("auth is LOGIN_ONLY — one observed tenant is not evidence that unattended account creation is safe everywhere", () => {
  const auth = workdayAdapter.auth!();
  assert.equal(auth.mode, "LOGIN_ONLY");
  assert.ok(!("createAccountSelector" in auth) || !auth.createAccountSelector, "no unattended creation path is declared");
});

test("the beecatcher honeypot appears in NO adapter selector", () => {
  const serialized = JSON.stringify({
    hints: workdayAdapter.fieldSelectorHints(),
    auth: workdayAdapter.auth!(),
    next: workdayAdapter.nextPageSelector!(),
  });
  assert.doesNotMatch(serialized, /beecatcher/i, "the observed bot honeypot must never be targeted");
});
