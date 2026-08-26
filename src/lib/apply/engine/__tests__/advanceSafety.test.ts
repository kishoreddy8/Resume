import test from "node:test";
import assert from "node:assert/strict";
import {
  boundMaxPages,
  classifyAdvanceControl,
  hasPageAdvanced,
  matchesAnyMarker,
  MULTI_PAGE_HARD_CAP,
  resolveMultiPageConfig,
  type PageFingerprint,
} from "../multiPage";
import type { AtsAdapter } from "@/lib/apply/agent/types";

/**
 * PHASE 9B — the never-submit advance classifier and the other pure multi-page decisions.
 * No browser: these are the rules the executor obeys, tested the same way the planner is.
 */

// ── ADVANCE-SAFETY — what may be clicked ─────────────────────────────────────────────────────────

test("ADVANCE-SAFETY-01: \"Next\" is classified SAFE", () => {
  assert.equal(classifyAdvanceControl(["Next"]), "safe_advance");
  assert.equal(classifyAdvanceControl(["NEXT"]), "safe_advance");
  assert.equal(classifyAdvanceControl(["Next →"]), "safe_advance");
  assert.equal(classifyAdvanceControl(["Next Step"]), "safe_advance");
});

test("ADVANCE-SAFETY-02: \"Continue\" is classified SAFE", () => {
  assert.equal(classifyAdvanceControl(["Continue"]), "safe_advance");
  assert.equal(classifyAdvanceControl(["Proceed"]), "safe_advance");
});

test("ADVANCE-SAFETY-03: \"Save and Continue\" is classified SAFE", () => {
  assert.equal(classifyAdvanceControl(["Save and Continue"]), "safe_advance");
  assert.equal(classifyAdvanceControl(["Save & Continue"]), "safe_advance");
});

test("ADVANCE-SAFETY-04: \"Submit\" is FINAL and blocked", () => {
  assert.equal(classifyAdvanceControl(["Submit"]), "final_action");
});

test("ADVANCE-SAFETY-05: \"Submit Application\" is FINAL and blocked", () => {
  assert.equal(classifyAdvanceControl(["Submit Application"]), "final_action");
  assert.equal(classifyAdvanceControl(["Submit application"]), "final_action");
});

test("ADVANCE-SAFETY-06: every final-action meaning is blocked, not just one literal list", () => {
  for (const label of ["Finish", "Finish Application", "Complete Application", "Send Application", "Apply", "Apply Now", "Save and Submit"]) {
    assert.equal(classifyAdvanceControl([label]), "final_action", `"${label}" must be blocked`);
  }
});

test("ADVANCE-SAFETY-07: unknown or ambiguous controls default to DO_NOT_CLICK", () => {
  assert.equal(classifyAdvanceControl(["Begin"]), "unknown");
  assert.equal(classifyAdvanceControl(["OK"]), "unknown");
  assert.equal(classifyAdvanceControl([""]), "unknown");
  assert.equal(classifyAdvanceControl([]), "unknown", "a control with no readable text is never clicked");
  // One dangerous reading outranks any number of safe ones — visible text "Next" with a
  // submit-flavoured accessible name is a submit control wearing a costume.
  assert.equal(classifyAdvanceControl(["Next", "Submit Application"]), "final_action");
});

// ── CONTROL-BUTTON — the same rules under the form-control support contract ─────────────────────

test("CONTROL-BUTTON-01: safe Next/Continue navigation buttons are allowed", () => {
  for (const label of ["Next", "Continue", "Save and Continue"]) {
    assert.equal(classifyAdvanceControl([label]), "safe_advance", `"${label}" must be clickable`);
  }
});

test("CONTROL-BUTTON-02: Submit/Finish controls are never auto-clicked", () => {
  for (const label of ["Submit", "Submit Application", "Finish", "Finish Application", "Complete Application", "Send Application"]) {
    assert.notEqual(classifyAdvanceControl([label]), "safe_advance", `"${label}" must never classify as safe`);
  }
});

// ── page bound ───────────────────────────────────────────────────────────────────────────────────

test("boundMaxPages: adapter bound is respected, absent falls back to the hard cap, and nothing exceeds it", () => {
  assert.equal(boundMaxPages(undefined), MULTI_PAGE_HARD_CAP);
  assert.equal(boundMaxPages(3), 3);
  assert.equal(boundMaxPages(50), MULTI_PAGE_HARD_CAP, "an adapter may lower the cap, never raise it");
  assert.equal(boundMaxPages(0), 1);
  assert.equal(boundMaxPages(Number.NaN), MULTI_PAGE_HARD_CAP);
});

// ── transition evidence ─────────────────────────────────────────────────────────────────────────

const fp = (url: string, fieldIds: string[], buttonTexts: string[] = [], heading = "Same Step"): PageFingerprint => ({
  url,
  fieldIds,
  buttonTexts,
  heading,
});

test("hasPageAdvanced: a URL change, or the step's heading changing, is a transition", () => {
  assert.equal(hasPageAdvanced(fp("file:///a", ["input:first_name"]), fp("file:///b", ["input:first_name"])), true);
  assert.equal(
    hasPageAdvanced(fp("file:///a", ["input:first_name"], [], "Contact"), fp("file:///a", ["input:city"], [], "Your Details")),
    true,
    "same URL, different step heading — a real SPA page change"
  );
});

test("hasPageAdvanced: field-id CHURN on the same step is NOT a transition (real Workday regression)", () => {
  /* Workday re-mounts its form after a rejected "Save and Continue", regenerating every id. Trusting
   * "old ids disappeared" counted eight phantom advances through one page on the live run. */
  const before = fp("file:///a", ["input:input-6", "input:input-7"], [], "My Information");
  const after = fp("file:///a", ["input:input-9", "input:input-10"], [], "My Information");
  assert.equal(hasPageAdvanced(before, after), false, "same URL and same heading means the same page, whatever the ids did");
});

test("hasPageAdvanced: a validation reveal (all old fields kept, new ones added) is NOT a transition", () => {
  const before = fp("file:///a", ["input:first_name", "input:email"], [], "Contact");
  const after = fp("file:///a", ["input:first_name", "input:email", "input:q_workauth"], [], "Contact");
  assert.equal(hasPageAdvanced(before, after), false, "same page complaining, not progress");
  assert.equal(hasPageAdvanced(before, before), false, "an unchanged page is not a transition");
});

test("hasPageAdvanced: a field-less page falls back to field appearance or button changes", () => {
  assert.equal(hasPageAdvanced(fp("file:///a", [], ["Begin"], ""), fp("file:///a", ["input:email"], ["Next"], "")), true);
  assert.equal(hasPageAdvanced(fp("file:///a", [], ["Begin"], ""), fp("file:///a", [], ["Begin"], "")), false);
});

// ── markers and contract resolution ─────────────────────────────────────────────────────────────

test("matchesAnyMarker: case-insensitive substring, empty marker list never matches", () => {
  assert.equal(matchesAnyMarker("Please REVIEW YOUR APPLICATION before submitting", ["review your application"]), true);
  assert.equal(matchesAnyMarker("anything at all", []), false);
});

test("resolveMultiPageConfig: no nextPageSelector means null — the single-page flow, exactly", () => {
  const singlePage: AtsAdapter = { sourceType: "greenhouse", fieldSelectorHints: () => ({}) };
  assert.equal(resolveMultiPageConfig(singlePage), null);
  assert.equal(resolveMultiPageConfig(null), null);
});

test("resolveMultiPageConfig: declared members surface lowercased and bounded", () => {
  const adapter: AtsAdapter = {
    sourceType: "greenhouse",
    fieldSelectorHints: () => ({}),
    nextPageSelector: () => "#advance",
    reviewPageMarkers: () => ["Review Your Application"],
    loginWallMarkers: () => ["Candidate Account Access"],
    maxPages: () => 99,
  };
  const config = resolveMultiPageConfig(adapter);
  assert.ok(config);
  assert.equal(config.nextSelector, "#advance");
  assert.deepEqual(config.reviewMarkers, ["review your application"]);
  assert.deepEqual(config.loginMarkers, ["candidate account access"]);
  assert.equal(config.maxPages, MULTI_PAGE_HARD_CAP, "an adapter cannot raise the engine's cap");
});
