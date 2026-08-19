import assert from "node:assert/strict";
import { test } from "node:test";
import { presentDisposition } from "../dispositionPresentation";
import { finalCoverLetterFilename, finalResumeFilename } from "../workspace";

/**
 * Stage 28 closure — how a finished workflow is presented, and the artifact naming it shares with
 * Phase 9A. Pure: no database, no filesystem, no network, no Claude.
 *
 * The gap these close: the browser rendered a red FAILED for workflow 8, whose every truthfulness
 * check passed and whose documents were genuinely usable, because the UI keyed off workflow.status
 * alone and never consulted the Stage 28 disposition.
 */

test("S28-60 READY renders as READY", () => {
  const p = presentDisposition({ workflowStatus: "READY", disposition: "READY" });
  assert.equal(p.label, "READY");
  assert.match(p.headline, /ALL QUALITY GATES PASSED/);
  assert.equal(p.tone, "SUCCESS");
  assert.equal(p.offerDownloads, true);
  assert.equal(p.renderAsFailedStep, false);
});

test("S28-61 SAFE_BEST_ATTEMPT renders distinctly from READY", () => {
  const safe = presentDisposition({ workflowStatus: "FAILED", disposition: "SAFE_BEST_ATTEMPT" });
  const ready = presentDisposition({ workflowStatus: "READY", disposition: "READY" });
  assert.notEqual(safe.label, ready.label);
  assert.notEqual(safe.headline, ready.headline);
  assert.notEqual(safe.tone, ready.tone, "must not be coloured like an approved publication");
  assert.match(safe.headline, /SAFE BEST ATTEMPT — HUMAN REVIEW REQUIRED/);
  assert.doesNotMatch(safe.label, /READY/, "the word READY must never appear for a safe best attempt");
  assert.doesNotMatch(safe.headline, /ALL QUALITY GATES PASSED/);
});

test("S28-62 SAFE_BEST_ATTEMPT is never displayed as FAILED", () => {
  const p = presentDisposition({ workflowStatus: "FAILED", disposition: "SAFE_BEST_ATTEMPT" });
  assert.doesNotMatch(p.label, /FAIL/i, `label must not read as a failure, got ${p.label}`);
  assert.doesNotMatch(p.headline, /BLOCKED|DO NOT APPLY/i);
  assert.notEqual(p.tone, "DANGER", "a truthful usable package must not get danger styling");
  assert.equal(p.renderAsFailedStep, false, "the final pipeline step is not a failure");
  assert.equal(p.offerDownloads, true, "a human must be able to download it");
});

test("S28-63 a genuinely unsafe result is displayed as DO NOT APPLY and offers no downloads", () => {
  const p = presentDisposition({ workflowStatus: "FAILED", disposition: "BLOCKED" });
  assert.match(p.label, /BLOCKED/);
  assert.match(p.headline, /DO NOT APPLY/);
  assert.equal(p.tone, "DANGER");
  assert.equal(p.offerDownloads, false, "an unsafe package must never expose application downloads");
  assert.equal(p.renderAsFailedStep, true);
});

test("S28-64 a terminal workflow with no disposition is treated as unsafe, never as safe", () => {
  const p = presentDisposition({ workflowStatus: "FAILED", disposition: null });
  assert.equal(p.offerDownloads, false, "absence of a verdict is never a free pass");
  assert.equal(p.tone, "DANGER");
});

test("S28-65 in-progress states are neither success nor failure", () => {
  for (const status of ["CREATED", "IMPROVEMENT_RUNNING", "WRITER_RUNNING"]) {
    const p = presentDisposition({ workflowStatus: status, disposition: null });
    assert.equal(p.tone, "NEUTRAL", `${status} must not read as a verdict`);
    assert.equal(p.offerDownloads, false);
    assert.equal(p.renderAsFailedStep, false);
  }
  assert.equal(presentDisposition({ workflowStatus: "CREATED", disposition: null }).label, "AWAITING WRITER");
});

test("S28-66 safe-attempt filenames use the SAME candidate-derived convention as a READY publication", () => {
  // The closure bug: a first name containing a space produced "Sai Kishore_Resume.docx" for the safe
  // attempt while Phase 9A produced "SaiKishore_Resume.docx", because only Phase 9A normalised it.
  // One algorithm now, and it is derived from the candidate rather than hardcoded.
  assert.equal(finalResumeFilename("Sai Kishore"), "SaiKishore_Resume.docx");
  assert.equal(finalCoverLetterFilename("Sai Kishore"), "SaiKishore_CoverLetter.docx");
  for (const [input, expected] of [
    ["Ana-María", "AnaMara_Resume.docx"],
    ["  Bob  ", "Bob_Resume.docx"],
    ["!!!", "Candidate_Resume.docx"],
  ] as const) {
    assert.equal(finalResumeFilename(input), expected, `naming must stay candidate-derived for ${JSON.stringify(input)}`);
  }
});
