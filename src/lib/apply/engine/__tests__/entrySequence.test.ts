import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockAtsUrl } from "./mockAts/paths";
import { workdayAdapter } from "@/lib/apply/agent/adapters/workday";
import { greenhouseAdapter } from "@/lib/apply/agent/adapters/greenhouse";
import { leverAdapter } from "@/lib/apply/agent/adapters/lever";
import { classifyAdvanceControl } from "../multiPage";
import { validateEntryStep, boundEntrySteps, entryControlTextMatches, ENTRY_HARD_CAP } from "@/lib/apply/entry";
import type { AtsAdapter } from "@/lib/apply/agent/types";

/**
 * PHASE 9E.2 — ENTRY-01..18. The application-entry stage, against sanitized captures of the real
 * Workday entry path. No network: every fixture is a local file:// page and the runtime's guard
 * refuses anything else.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-entry-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
delete process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT;

/* eslint-disable @typescript-eslint/no-require-imports */
const runsDb = require("@/db/queries/applicationRuns") as typeof import("@/db/queries/applicationRuns");
const vault = require("@/db/queries/applicationVault") as typeof import("@/db/queries/applicationVault");
const { ApplicationBrowserRuntime } = require("../browserRuntime") as typeof import("../browserRuntime");
const { executeRun } = require("../executor") as typeof import("../executor");
const { openApplication } = require("../entry") as typeof import("../entry");

const CONTEXT = {
  candidateId: 1,
  contact: { name: "Jordan Rivera", email: "jordan@example.test", phone: "(214) 555-0100", location: "Dallas, TX" },
  resumePath: path.join(dir, "Resume.docx"),
  coverLetterPath: path.join(dir, "CoverLetter.docx"),
};
fs.writeFileSync(CONTEXT.resumePath, "mock resume");
fs.writeFileSync(CONTEXT.coverLetterPath, "mock cover letter");

const runtime = new ApplicationBrowserRuntime();
const deps = () => ({ context: CONTEXT, knownVariants: vault.loadKnownVariants(), storedAnswers: new Map() }) as Parameters<typeof executeRun>[2];

function newRun(url: string, ats = "workday") {
  return runsDb.createRun({
    candidateId: 1, jobId: 1, dedupeKey: `entry-${Math.round(performance.now() * 1000)}`,
    ats, applyUrl: url, resumeFile: CONTEXT.resumePath, coverLetterFile: CONTEXT.coverLetterPath,
  });
}

/** Runs ONLY the entry stage. The caller closes the session, so assertions can still read the page
 *  after entry has finished. */
async function runEntryOnly(url: string, adapter: AtsAdapter | null) {
  const run = newRun(url);
  const session = await runtime.open(url);
  const result = await openApplication({ runId: run.id, page: session.page, adapter });
  return { run, result, page: session.page, close: () => session.close() };
}

test.after(async () => { await runtime.close(); });

// ── contract-level ───────────────────────────────────────────────────────────────────────────────

test("ENTRY-01: an adapter with no entry contract preserves existing behaviour exactly", async () => {
  for (const adapter of [greenhouseAdapter, leverAdapter, null]) {
    const { result, close } = await runEntryOnly(mockAtsUrl("mock-greenhouse"), adapter);
    assert.equal(result.outcome, "NO_ENTRY_CONTRACT");
    assert.equal(result.stepsTaken, 0, "the page is never touched");
    await close();
  }
});

test("ENTRY-04: the universal core NEVER text-searches for an 'Apply' control", async () => {
  /* The fixture carries a generic "Apply Now" button that submits if clicked. An adapter with no
   * entry contract must leave the whole page alone — the core has no code path that looks for
   * something saying "Apply". */
  const { result, page, close } = await runEntryOnly(mockAtsUrl("mock-workday-entry"), null);
  assert.equal(result.outcome, "NO_ENTRY_CONTRACT");
  assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /WRONGLY SUBMITTED/);
  await close();
});

test("ENTRY-05: a final-action meaning can never be declared as an entry step", () => {
  for (const text of ["Submit Application", "Finish", "Complete Application", "Send Application", "Save and Submit"]) {
    const check = validateEntryStep({ selector: "#x", expectedText: text, kind: "enter_application" });
    assert.equal(check.ok, false, `${text} must be refused as an entry step`);
  }
  // And the universal classifier is untouched: these remain final everywhere else.
  assert.equal(classifyAdvanceControl(["Apply Now"]), "final_action");
  assert.equal(classifyAdvanceControl(["Submit Application"]), "final_action");
});

test("ENTRY-08: the entry step bound is capped by the engine, and an adapter may only lower it", () => {
  assert.equal(boundEntrySteps(undefined), ENTRY_HARD_CAP);
  assert.equal(boundEntrySteps(3), 3);
  assert.equal(boundEntrySteps(99), ENTRY_HARD_CAP, "an adapter can never raise the cap");
  assert.equal(workdayAdapter.entryMaxSteps!(), 4, "Workday bounds itself at its observed 4 controls");
});

test("the observed-text gate is an equality test, never a substring match", () => {
  assert.equal(entryControlTextMatches("Apply", ["Apply"]), true);
  assert.equal(entryControlTextMatches("Apply", ["Apply Now and Submit"]), false, "a drifted control is never matched");
  assert.equal(entryControlTextMatches("Accept Cookies", ["Accept  Cookies"]), true, "whitespace-normalised");
});

// ── the observed Workday entry path ─────────────────────────────────────────────────────────────

test("ENTRY-02/03/06: the observed Workday sequence enters via exact selectors, in order, each proven by a transition", async () => {
  const { run, result, page, close } = await runEntryOnly(mockAtsUrl("mock-workday-entry"), workdayAdapter);
  assert.equal(result.outcome, "PROCEED");
  assert.equal(result.stepsTaken, 3, "cookie notice, Apply, Apply Manually (the sign-in reveal is optional and absent on this fixture)");

  const events = runsDb.listEvents(run.id).filter((e) => e.event_type === "entry_step_completed").map((e) => e.detail);
  assert.deepEqual(events, [
    'dismiss_notice: [data-automation-id="legalNoticeAcceptButton"]',
    'enter_application: [data-automation-id="adventureButton"]',
    'enter_application: [data-automation-id="applyManually"]',
  ]);

  const text = await page.evaluate(() => document.body.innerText);
  assert.match(text, /My Information/, "the application form is now open");
  assert.doesNotMatch(text, /WRONGLY SUBMITTED/, "the generic Apply Now control was never touched");
  await close();
});

test("ENTRY-03b: the deterministic branch is chosen — never autofill-with-resume or last-application", () => {
  const selectors = workdayAdapter.entrySequence!().map((s) => s.selector).join(" ");
  assert.match(selectors, /applyManually/);
  assert.doesNotMatch(selectors, /autofillWithResume/, "Workday must not parse a resume Career-Ops did not author");
  assert.doesNotMatch(selectors, /useMyLastApplication/, "a previous application's answers are not this application's");
});

test("ENTRY-07: a non-transitioning entry click is bounded and stops safely, never retried", async () => {
  const { run, result, close } = await runEntryOnly(mockAtsUrl("mock-workday-entry-stuck"), workdayAdapter);
  assert.equal(result.outcome, "ENTRY_NO_TRANSITION");
  const clicks = runsDb.listEvents(run.id).filter((e) => e.event_type === "entry_step_no_transition");
  assert.equal(clicks.length, 1, `clicked once, stopped — no click loop; saw ${JSON.stringify(runsDb.listEvents(run.id).map((e) => e.event_type))}`);
  await close();
});

test("ENTRY-14/15: a control whose text has drifted is NEVER clicked", async () => {
  /* The fixture's adventureButton now reads "Submit Application" and would submit if clicked. */
  const { result, page, close } = await runEntryOnly(mockAtsUrl("mock-workday-entry-changed"), workdayAdapter);
  assert.equal(result.outcome, "ENTRY_CONTROL_CHANGED");
  assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /WRONGLY SUBMITTED/);
  await close();
});

test("ENTRY-14b: the cookie notice is optional — its absence is not a failure", async () => {
  /* mock-workday-entry-stuck has no notice at all; entry proceeds past it to the Apply control. */
  const { run, close } = await runEntryOnly(mockAtsUrl("mock-workday-entry-stuck"), workdayAdapter);
  const skipped = runsDb.listEvents(run.id).filter((e) => e.event_type === "entry_step_skipped");
  assert.equal(skipped.length, 1, "the absent optional notice is skipped, not fatal");
  await close();
});

// ── end-to-end through the real executor ────────────────────────────────────────────────────────

test("ENTRY-11/12: entry reaches the form and the run proceeds to real discovery and filling", async () => {
  const run = newRun(mockAtsUrl("mock-workday-entry"));
  const after = await executeRun(run.id, runtime, deps(), { adapter: workdayAdapter });

  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  assert.ok(events.includes("application_entry_completed"), "entry ran");
  assert.ok(events.includes("field_filled"), "and the form behind it was actually filled");
  assert.ok(!events.includes("no_application_form_found"), "the zero-fill guard is not triggered once entry works");

  const checkpoint = JSON.parse(after.checkpoint_json!);
  assert.ok(checkpoint.completed.length > 0, "real fields were completed");
  assert.notEqual(after.status, "SUBMITTED");
});

test("ENTRY-12b: the zero-fill guard still fires when entry succeeds but no form is behind it", async () => {
  /* Entry contract present, page has no form: the guard must still refuse a false READY. */
  const noFormAdapter: AtsAdapter = {
    ...workdayAdapter,
    entrySequence: () => [{ selector: '[data-automation-id="adventureButton"]', expectedText: "Apply", kind: "enter_application" }],
  };
  const run = newRun(mockAtsUrl("mock-workday-entry-stuck"));
  const after = await executeRun(run.id, runtime, deps(), { adapter: noFormAdapter });
  assert.notEqual(after.status, "READY_FOR_REVIEW", "no form behind entry is never 'ready'");
});

test("ENTRY-13: a job posting page is never mistaken for the review page", async () => {
  const run = newRun(mockAtsUrl("mock-no-form-landing"));
  const after = await executeRun(run.id, runtime, deps(), { adapter: workdayAdapter });
  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  assert.ok(!events.includes("review_page_detected"), "a posting is not a review page");
  assert.notEqual(after.status, "READY_FOR_REVIEW");
});

test("ENTRY-16/17: Greenhouse and Lever run unchanged — entry does nothing for them", async () => {
  for (const [url, ats] of [["mock-greenhouse", "greenhouse"], ["mock-lever", "lever"]] as const) {
    const run = newRun(mockAtsUrl(url), ats);
    const after = await executeRun(run.id, runtime, deps());
    assert.equal(after.status, "WAITING_FOR_ANSWER", `${ats} pauses exactly as before`);
    const events = runsDb.listEvents(run.id).map((e) => e.event_type);
    assert.ok(!events.includes("application_entry_completed"), `${ats} has no entry contract and runs no entry stage`);
  }
});

test("ENTRY-18: no entry path ever reaches a final submit — the run never leaves the safe states", async () => {
  const run = newRun(mockAtsUrl("mock-workday-entry"));
  const after = await executeRun(run.id, runtime, deps(), { adapter: workdayAdapter });
  assert.ok(!["SUBMITTING", "SUBMITTED", "SUBMISSION_UNCONFIRMED"].includes(after.status), `unexpected ${after.status}`);
  assert.equal(after.submitted_at, null);
  assert.equal(runsDb.listEvents(run.id).filter((e) => e.event_type === "submit_attempted").length, 0);
});
