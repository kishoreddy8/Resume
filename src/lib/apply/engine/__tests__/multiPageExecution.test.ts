import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockAtsUrl } from "./mockAts/paths";
import type { AtsAdapter } from "@/lib/apply/agent/types";

/**
 * PHASE 9B — the multi-page walk, end to end, against LOCAL mock ATS pages only.
 *
 * NO REAL WEBSITE IS EVER OPENED (the runtime guard refuses non-file:// URLs) and NO APPLICATION
 * IS EVER SUBMITTED: every fixture's final-action control mutates its own page into a
 * submitted-confirmation on click, so a single wrong click would be visible in these assertions.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-multipage-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
delete process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT;

/* eslint-disable @typescript-eslint/no-require-imports */
const runsDb = require("@/db/queries/applicationRuns") as typeof import("@/db/queries/applicationRuns");
const vault = require("@/db/queries/applicationVault") as typeof import("@/db/queries/applicationVault");
const { ApplicationBrowserRuntime } = require("../browserRuntime") as typeof import("../browserRuntime");
const { executeRun } = require("../executor") as typeof import("../executor");

const CONTEXT = {
  candidateId: 1,
  contact: {
    name: "Jordan Rivera",
    email: "jordan@example.test",
    phone: "(214) 555-0100",
    location: "Dallas, TX",
    linkedin: "linkedin.com/in/jordan",
  },
  resumePath: path.join(dir, "Resume.docx"),
  coverLetterPath: path.join(dir, "CoverLetter.docx"),
};
fs.writeFileSync(CONTEXT.resumePath, "mock resume");
fs.writeFileSync(CONTEXT.coverLetterPath, "mock cover letter");

const runtime = new ApplicationBrowserRuntime();

function deps() {
  return {
    context: CONTEXT,
    knownVariants: vault.loadKnownVariants(),
    storedAnswers: new Map(),
  } as Parameters<typeof executeRun>[2];
}

function newRun(url: string, ats: string) {
  return runsDb.createRun({
    candidateId: 1,
    jobId: 1,
    dedupeKey: `mock-multi-${Math.round(performance.now() * 1000)}`,
    ats,
    applyUrl: url,
    resumeFile: CONTEXT.resumePath,
    coverLetterFile: CONTEXT.coverLetterPath,
  });
}

/** The multi-page adapter under test — injected via executeRun's opts, exactly like
 *  approveAndSubmit's submitSelector. NO Workday adapter exists or is registered. */
function multiAdapter(overrides: Partial<AtsAdapter> = {}): AtsAdapter {
  return {
    sourceType: "greenhouse",
    fieldSelectorHints: () => ({}),
    nextPageSelector: () => "#advance",
    reviewPageMarkers: () => ["review your application"],
    loginWallMarkers: () => ["candidate account access"],
    maxPages: () => 5,
    ...overrides,
  };
}

/** An adapter with NO multi-page members at all — the pre-9B contract. */
const singlePageAdapter: AtsAdapter = { sourceType: "greenhouse", fieldSelectorHints: () => ({}) };

test.after(async () => {
  await runtime.close();
});

// ── the happy path ───────────────────────────────────────────────────────────────────────────────

test("MULTIPAGE-01/02/03/04/06/12: pages 1→2→review, Next and Continue clicked, Submit never, page recorded", async () => {
  const run = newRun(mockAtsUrl("mock-multipage"), "greenhouse");
  const after = await executeRun(run.id, runtime, deps(), { adapter: multiAdapter() });

  // MULTIPAGE-01 — the walk ends at READY_FOR_REVIEW, never beyond.
  assert.equal(after.status, "READY_FOR_REVIEW", `expected READY_FOR_REVIEW, got ${after.status}`);

  const events = runsDb.listEvents(run.id);
  const names = events.map((e) => e.event_type);

  // MULTIPAGE-03/04 — the safe Next (page 1) and Continue (page 2) were each allowed exactly once.
  const advanced = events.filter((e) => e.event_type === "page_advanced").map((e) => e.detail);
  assert.deepEqual(advanced, ["page 2 via #advance", "page 3 via #advance"]);

  // MULTIPAGE-06 — the review marker stopped the walk: detected, and nothing advanced past it.
  assert.ok(names.includes("review_page_detected"), "the review page must be detected");
  assert.ok(!names.includes("advance_control_blocked"), "the Submit control must never even be classified on the review page");
  assert.ok(!names.includes("page_did_not_advance"), "no failed advance on the happy path");

  // MULTIPAGE-02 — the Submit Application control received ZERO clicks: the fixture replaces the
  // page with a submitted-confirmation on click, so a single click would poison the review below.
  const checkpoint = JSON.parse(after.checkpoint_json!);
  const reviewText = JSON.stringify(checkpoint.review);
  assert.doesNotMatch(reviewText, /submitted|MP-9999/i, "the page must never reach its submitted state");

  // MULTIPAGE-12 — the checkpoint records the page index the run stopped on.
  assert.equal(checkpoint.page, 3, "checkpoint must record the review page index");

  // Both pages' fields made it into one review.
  const answered = checkpoint.review.answers.map((a: { question: string }) => a.question);
  assert.ok(answered.some((q: string) => q.includes("First Name")), "page 1 fields reach the review");
  assert.ok(answered.some((q: string) => q.includes("Location")), "page 2 fields reach the review");
});

// ── never-click fixtures ─────────────────────────────────────────────────────────────────────────

test("MULTIPAGE-02b: an advance control labelled \"Submit Application\" is never clicked", async () => {
  const run = newRun(mockAtsUrl("mock-multipage-final-label"), "greenhouse");
  const after = await executeRun(run.id, runtime, deps(), { adapter: multiAdapter() });

  assert.equal(after.status, "READY_FOR_REVIEW", "the filled page is handed to the user, exactly like a single-page form");
  const events = runsDb.listEvents(run.id);
  const blocked = events.find((e) => e.event_type === "advance_control_blocked");
  assert.ok(blocked, "the block must be audited");
  assert.match(blocked!.detail ?? "", /Submit Application/);
  assert.equal(events.filter((e) => e.event_type === "page_advanced").length, 0, "nothing advanced");
  assert.doesNotMatch(JSON.stringify(JSON.parse(after.checkpoint_json!).review), /Application submitted/i);
});

test("MULTIPAGE-05: \"Finish Application\" is blocked the same way", async () => {
  const run = newRun(`${mockAtsUrl("mock-multipage-final-label")}#Finish%20Application`, "greenhouse");
  const after = await executeRun(run.id, runtime, deps(), { adapter: multiAdapter() });

  assert.equal(after.status, "READY_FOR_REVIEW");
  const blocked = runsDb.listEvents(run.id).find((e) => e.event_type === "advance_control_blocked");
  assert.ok(blocked);
  assert.match(blocked!.detail ?? "", /Finish Application/);
});

// ── blockers appearing AFTER a transition ────────────────────────────────────────────────────────

test("MULTIPAGE-07: a login wall on page 2 stops the walk via the adapter's own markers", async () => {
  const run = newRun(mockAtsUrl("mock-multipage-login-wall"), "greenhouse");
  const after = await executeRun(run.id, runtime, deps(), { adapter: multiAdapter() });

  assert.equal(after.status, "ACCOUNT_REQUIRED", `expected ACCOUNT_REQUIRED, got ${after.status}`);
  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  assert.ok(events.includes("blocking_detected"));
  assert.equal(JSON.parse(after.checkpoint_json!).page, 2, "the wall was met on page 2");
});

test("MULTIPAGE-08: a CAPTCHA appearing after navigation pauses the run", async () => {
  const run = newRun(mockAtsUrl("mock-multipage-captcha"), "greenhouse");
  const after = await executeRun(run.id, runtime, deps(), { adapter: multiAdapter() });

  assert.equal(after.status, "WAITING_FOR_CAPTCHA", `expected WAITING_FOR_CAPTCHA, got ${after.status}`);
  assert.equal(JSON.parse(after.checkpoint_json!).page, 2);
});

// ── bounds and loop protection ───────────────────────────────────────────────────────────────────

test("MULTIPAGE-09: maxPages stops the walk before the review page, safely", async () => {
  const run = newRun(mockAtsUrl("mock-multipage"), "greenhouse");
  const after = await executeRun(run.id, runtime, deps(), { adapter: multiAdapter({ maxPages: () => 2 }) });

  assert.equal(after.status, "FAILED");
  assert.match(after.blocking_reason ?? "", /more pages than the safe limit/);
  const events = runsDb.listEvents(run.id);
  assert.ok(events.some((e) => e.event_type === "multi_page_limit_reached"));
  assert.equal(JSON.parse(after.checkpoint_json!).page, 2, "stopped at the bound, review never reached");
});

test("MULTIPAGE-10: a Next that does nothing is clicked a bounded number of times, then the run stops", async () => {
  const run = newRun(mockAtsUrl("mock-multipage-stuck"), "greenhouse");
  const after = await executeRun(run.id, runtime, deps(), { adapter: multiAdapter() });

  assert.equal(after.status, "FAILED");
  assert.match(after.blocking_reason ?? "", /did not advance/);
  const stuckEvents = runsDb.listEvents(run.id).filter((e) => e.event_type === "page_did_not_advance");
  assert.equal(stuckEvents.length, 1, "one failed advance, no click loop — nothing earned a retry");
  assert.equal(JSON.parse(after.checkpoint_json!).page, 1, "the page index never moved");
});

test("MULTIPAGE-11: a validation error after Next is not a page transition — the revealed question pauses the run", async () => {
  const run = newRun(mockAtsUrl("mock-multipage-validation"), "greenhouse");
  const after = await executeRun(run.id, runtime, deps(), { adapter: multiAdapter() });

  assert.equal(after.status, "WAITING_FOR_ANSWER", `expected WAITING_FOR_ANSWER, got ${after.status}`);
  assert.match(after.blocking_question ?? "", /legally authorized to work/i, "the revealed required question is what pauses the run");
  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  assert.ok(events.includes("page_did_not_advance"), "the failed advance is audited");
  assert.ok(!events.includes("page_advanced"), "the page count must not increment");
  assert.equal(JSON.parse(after.checkpoint_json!).page, 1);
});

// ── compatibility fences ─────────────────────────────────────────────────────────────────────────

test("MULTIPAGE-13: an old checkpoint without a page index remains readable", async () => {
  const run = newRun(mockAtsUrl("mock-multipage"), "greenhouse");
  runsDb.updateCheckpoint(run.id, {
    url: null,
    ats: "greenhouse",
    step: "filling",
    completed: [{ selector: "#first_name", canonicalKey: "first_name", source: "PROFILE", kind: "fill" }],
    runAnswers: {},
    lastAction: "legacy checkpoint from before Phase 9B",
  });
  const after = await executeRun(run.id, runtime, deps(), { adapter: multiAdapter() });
  assert.equal(after.status, "READY_FOR_REVIEW", "a pre-9B checkpoint must not break the walk");
  assert.equal(JSON.parse(after.checkpoint_json!).page, 3);
});

test("MULTIPAGE-14: an adapter without the multi-page contract keeps the single-page flow, byte for byte", async () => {
  const run = newRun(mockAtsUrl("mock-multipage"), "greenhouse");
  const after = await executeRun(run.id, runtime, deps(), { adapter: singlePageAdapter });

  assert.equal(after.status, "READY_FOR_REVIEW");
  const checkpoint = JSON.parse(after.checkpoint_json!);
  assert.ok(!("page" in checkpoint), "a single-page checkpoint must not grow a page field");
  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  for (const name of ["page_advanced", "review_page_detected", "advance_control_blocked", "page_did_not_advance"]) {
    assert.ok(!events.includes(name), `single-page flow must not emit ${name}`);
  }
  const answered = checkpoint.review.answers.map((a: { question: string }) => a.question);
  assert.ok(!answered.some((q: string) => q.includes("Location")), "page 2 was never visited");
});

test("MULTIPAGE-15: Greenhouse regression fence — production selection, unchanged behavior", async () => {
  const run = newRun(mockAtsUrl("mock-greenhouse"), "greenhouse");
  const after = await executeRun(run.id, runtime, deps());

  assert.equal(after.status, "WAITING_FOR_ANSWER", "the EXEC-3 pause, unchanged");
  const checkpoint = JSON.parse(after.checkpoint_json!);
  assert.ok(!("page" in checkpoint), "Greenhouse checkpoints must stay pre-9B shaped");
  assert.ok(checkpoint.completed.filter((c: { kind: string }) => c.kind === "fill").length >= 4);
  assert.equal(checkpoint.completed.filter((c: { kind: string }) => c.kind === "upload").length, 2);
});

test("MULTIPAGE-16: Lever regression fence — production selection, unchanged behavior", async () => {
  const run = newRun(mockAtsUrl("mock-lever"), "lever");
  const after = await executeRun(run.id, runtime, deps());

  assert.equal(after.status, "WAITING_FOR_ANSWER", "the EXEC-12 pause, unchanged");
  const checkpoint = JSON.parse(after.checkpoint_json!);
  assert.ok(!("page" in checkpoint), "Lever checkpoints must stay pre-9B shaped");
  assert.ok(checkpoint.completed.length >= 4, "hint-driven fills still happen");
});
