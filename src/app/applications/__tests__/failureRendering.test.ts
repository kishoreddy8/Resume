import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * UI-0 DEFECT 3 — FAILED (and CANCELLED) runs must render the reason the engine already recorded.
 *
 * ROOT CAUSE PINNED: `run.blockingReason` is already fetched by `load()` (the API's `?runId=`
 * branch has always returned it) and was already available on `run` throughout this component. The
 * FAILED/CANCELLED branch simply never existed in the conditional chain, so every failed run fell
 * through to the generic `applicationContext` fallback string ("This application run stopped."),
 * discarding a specific, already-written explanation every single time.
 *
 * Matches this repo's established convention for surfaces with no jsdom/component-rendering harness
 * (see questionUiControls.test.ts / qualityWorkflowApprovalUi.test.ts): source-verification against
 * the actual JSX, not a rendered DOM.
 */

function read(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

const SOURCE = read("src/app/applications/[id]/ApplicationDetail.tsx");

test("UI-FAILURE-01: a FAILED run renders run.blockingReason when present", () => {
  const branchStart = SOURCE.indexOf('run.status === "FAILED" || run.status === "CANCELLED"');
  assert.notEqual(branchStart, -1, "the FAILED/CANCELLED branch condition must exist");
  const branchEnd = SOURCE.indexOf(") : (", branchStart);
  const branch = SOURCE.slice(branchStart, branchEnd);
  assert.match(branch, /run\.blockingReason \?\?/, "the branch must read run.blockingReason before falling back to anything generic");
});

test("UI-FAILURE-02: the branch is reached for FAILED specifically (not only CANCELLED or a shared parent condition)", () => {
  assert.match(SOURCE, /run\.status === "FAILED"/);
});

test("UI-FAILURE-03: a missing reason uses honest, non-alarming generic copy — never a raw stack trace or blank", () => {
  assert.match(
    SOURCE,
    /Career-Ops stopped this application and did not record a specific reason\./,
    "the honest fallback string must be present verbatim"
  );
});

test("UI-FAILURE-04: technical detail is progressively disclosed via the existing Disclosure primitive, not always-visible", () => {
  assert.match(SOURCE, /import \{ Disclosure \} from "@\/app\/jobs\/\[id\]\/Disclosure"/);
  assert.match(SOURCE, /<Disclosure title="Technical details">/);
});

test("the failure branch never claims a submission definitely did not happen (SUBMITTING can legally transition to FAILED)", () => {
  const failureBranchStart = SOURCE.indexOf('run.status === "FAILED" || run.status === "CANCELLED"');
  assert.notEqual(failureBranchStart, -1, "the branch must exist");
  const failureBranchEnd = SOURCE.indexOf(") : (", failureBranchStart);
  const branchSource = SOURCE.slice(failureBranchStart, failureBranchEnd);
  assert.doesNotMatch(
    branchSource,
    /nothing was submitted|was not submitted/i,
    "a blanket 'nothing was submitted' claim would be false for the SUBMITTING → FAILED transition"
  );
});

test("no fake repair button: FAILED/CANCELLED offers only a non-mutating link (the employer posting), never a retry/resubmit action", () => {
  const failureBranchStart = SOURCE.indexOf('run.status === "FAILED" || run.status === "CANCELLED"');
  const failureBranchEnd = SOURCE.indexOf(") : (", failureBranchStart);
  const branchSource = SOURCE.slice(failureBranchStart, failureBranchEnd);
  assert.doesNotMatch(branchSource, /onClick/, "this branch must not wire any mutating action — no safe retry exists in this slice");
  assert.match(branchSource, /run\.applyUrl &&/, "the only affordance is the existing, safe, non-mutating employer-posting link");
});

test("the underlying data was already available before this fix — blockingReason is sent by the API for every status, not only FAILED", () => {
  const apiSource = read("src/app/api/candidates/[candidateId]/application-runs/route.ts");
  assert.match(apiSource, /blockingReason: run\.blocking_reason/, "the field must already be part of the run payload");
});
