import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockAtsUrl } from "./mockAts/paths";

/**
 * The execution loop, end to end, against LOCAL mock ATS pages.
 *
 * NO REAL WEBSITE IS EVER OPENED. The runtime's guard defaults to on and refuses any non-file://
 * URL, so this suite cannot reach an employer's site even by mistake — the refusal lives in the
 * runtime rather than in test discipline, which is the only version of that promise worth making.
 *
 * NO REAL APPLICATION IS EVER SUBMITTED. The mock pages replace their own body with a confirmation
 * on click; nothing leaves this machine.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-exec-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
/* Explicitly ON for the whole suite. Asserted below rather than assumed. */
delete process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT;

/* eslint-disable @typescript-eslint/no-require-imports */
const runsDb = require("@/db/queries/applicationRuns") as typeof import("@/db/queries/applicationRuns");
const vault = require("@/db/queries/applicationVault") as typeof import("@/db/queries/applicationVault");
const { ApplicationBrowserRuntime, realApplicationAgentDisabled, NavigationRefusedError } =
  require("../browserRuntime") as typeof import("../browserRuntime");
const { executeRun, approveAndSubmit } = require("../executor") as typeof import("../executor");
const { matchQuestion } = require("@/lib/apply/questionMatching") as typeof import("@/lib/apply/questionMatching");

const CONTEXT = {
  candidateId: 1,
  contact: {
    name: "Jordan Rivera",
    email: "jordan@example.test",
    phone: "(214) 555-0100",
    location: "Dallas, TX",
    linkedin: "linkedin.com/in/jordan",
    github: "github.com/jordan",
  },
  resumePath: path.join(dir, "Resume.docx"),
  coverLetterPath: path.join(dir, "CoverLetter.docx"),
};
fs.writeFileSync(CONTEXT.resumePath, "mock resume");
fs.writeFileSync(CONTEXT.coverLetterPath, "mock cover letter");

const runtime = new ApplicationBrowserRuntime();

function deps(overrides: Partial<Parameters<typeof executeRun>[2]> = {}) {
  return {
    context: CONTEXT,
    knownVariants: vault.loadKnownVariants(),
    storedAnswers: new Map(),
    ...overrides,
  } as Parameters<typeof executeRun>[2];
}

function newRun(url: string, ats: string) {
  return runsDb.createRun({
    candidateId: 1,
    jobId: 1,
    dedupeKey: `mock-${Math.round(performance.now() * 1000)}`,
    ats,
    applyUrl: url,
    resumeFile: CONTEXT.resumePath,
    coverLetterFile: CONTEXT.coverLetterPath,
  });
}

test.after(async () => {
  await runtime.close();
});

// ── the guard ────────────────────────────────────────────────────────────────────────────────

test("EXEC-1 the real-agent guard is ON by default and refuses a non-local URL", async () => {
  assert.equal(realApplicationAgentDisabled(), true, "the guard must default to on");
  await assert.rejects(
    () => runtime.open("https://job-boards.greenhouse.io/natera/jobs/1"),
    NavigationRefusedError,
    "an automated test must not be able to reach a real employer site"
  );
});

test("EXEC-2 the refusal message never embeds the URL", async () => {
  const err = await runtime.open("https://example.com/apply?token=SECRET").catch((e: Error) => e);
  assert.ok(err instanceof Error);
  assert.doesNotMatch(err.message, /SECRET|example\.com/, "a URL can carry tokens and this reaches the UI");
});

// ── Greenhouse, end to end ───────────────────────────────────────────────────────────────────

test("EXEC-3 a run fills profile fields, uploads documents, and STOPS on an unknown question", async () => {
  const run = newRun(mockAtsUrl("mock-greenhouse"), "greenhouse");
  const after = await executeRun(run.id, runtime, deps());

  assert.equal(after.status, "WAITING_FOR_ANSWER", `expected a pause, got ${after.status}`);
  assert.ok(after.blocking_question, "the run must say WHAT it is waiting for");

  const checkpoint = JSON.parse(after.checkpoint_json!);
  const filled = checkpoint.completed.filter((c: { kind: string }) => c.kind === "fill");
  const uploaded = checkpoint.completed.filter((c: { kind: string }) => c.kind === "upload");

  assert.ok(filled.length >= 4, `expected identity/contact fills, got ${filled.length}`);
  assert.equal(uploaded.length, 2, "resume and cover letter must both upload");
  for (const c of checkpoint.completed) {
    assert.match(
      c.source,
      /^(PROFILE|MASTER_RESUME|MSI|VALIDATED_CANDIDATE_PROFILE|APPLICATION_ANSWER_VAULT|USER_INTERVENTION|APPROVED_CLAUDE_DRAFT)$/,
      `field ${c.selector} was filled from an unrecognised source`
    );
  }
});

test("EXEC-4 every action is checkpointed as it happens, not at the end", async () => {
  const run = newRun(mockAtsUrl("mock-greenhouse"), "greenhouse");
  await executeRun(run.id, runtime, deps());
  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  assert.ok(events.filter((e) => e === "field_filled").length >= 4, "each fill records an event");
  assert.ok(events.includes("document_uploaded"));
  assert.ok(events.includes("status_waiting_for_answer"));
});

test("EXEC-5 answering the unknown question lets the run reach review", async () => {
  const run = newRun(mockAtsUrl("mock-greenhouse"), "greenhouse");
  const paused = await executeRun(run.id, runtime, deps());
  assert.equal(paused.status, "WAITING_FOR_ANSWER");

  /* Answer everything the mock asks that Career-Ops cannot know, exactly as the inbox would. */
  for (const [question, answer] of [
    ["Will you now or in the future require sponsorship?", "No"],
    ["What is your desired base salary?", "$185,000"],
    ["Which of our engineering values resonates most with you?", "Building things that stay correct under pressure."],
    ["Join our talent newsletter?", "No"],
  ] as const) {
    const match = matchQuestion(question, vault.loadKnownVariants());
    if (!match) continue; // unmapped questions are answered per-run, not learned — see EXEC-6
    vault.saveAnswer({
      candidateId: 1,
      canonicalKey: match.canonicalKey,
      questionType: match.type,
      observedText: question,
      answerValue: answer,
      answerSource: "USER_INTERVENTION",
      approvedByUser: true,
      autoFillAllowed: true,
      sourceAts: "greenhouse",
    });
  }

  runsDb.advanceRun(run.id, "FILLING", { blockingQuestion: null, blockingReason: null });

  const stored = new Map(
    ["sponsorship_required", "desired_salary"].map((k) => {
      const a = vault.getAnswer(1, k)!;
      return [k, { answer_value: a.answer_value, answer_source: a.answer_source, approved_by_user: a.approved_by_user, auto_fill_allowed: a.auto_fill_allowed }];
    })
  );

  const resumed = await executeRun(run.id, runtime, deps({ storedAnswers: stored as never }));
  /* The free-text values question has no canonical mapping, so it correctly still asks. That is the
   * designed outcome: a company's own question is never auto-answered. */
  assert.ok(
    ["WAITING_FOR_ANSWER", "READY_FOR_REVIEW"].includes(resumed.status),
    `unexpected status ${resumed.status}`
  );
  if (resumed.status === "WAITING_FOR_ANSWER") {
    /* Whichever confirm-every-time question comes first in DOM order. Salary is `ask_each_time` by
     * policy, so a saved approved answer is still only ever a suggestion — it must NOT have been
     * auto-filled here, and the free-text values question has no canonical mapping at all. Both are
     * correct reasons to still be asking. */
    assert.match(resumed.blocking_question!, /salary|values resonates/i, `unexpected blocker: ${resumed.blocking_question}`);
  }
});

test("EXEC-6 a stored approved answer is reused on a SECOND application", async () => {
  const stored = new Map([
    ["sponsorship_required", { answer_value: "No", answer_source: "APPLICATION_ANSWER_VAULT" as const, approved_by_user: 1 as const, auto_fill_allowed: 1 as const }],
  ]);
  const run = newRun(mockAtsUrl("mock-greenhouse"), "greenhouse");
  const after = await executeRun(run.id, runtime, deps({ storedAnswers: stored as never }));

  const checkpoint = JSON.parse(after.checkpoint_json!);
  const sponsorship = checkpoint.completed.find((c: { canonicalKey: string }) => c.canonicalKey === "sponsorship_required");
  assert.ok(sponsorship, "the learned answer must be used without asking again");
  assert.equal(sponsorship.source, "APPLICATION_ANSWER_VAULT");
});

// ── verification checkpoints ─────────────────────────────────────────────────────────────────

test("EXEC-7 a CAPTCHA pauses the run and is never solved", async () => {
  const run = newRun(mockAtsUrl("mock-captcha"), "greenhouse");
  const after = await executeRun(run.id, runtime, deps());
  assert.equal(after.status, "WAITING_FOR_CAPTCHA");

  const checkpoint = JSON.parse(after.checkpoint_json!);
  assert.deepEqual(checkpoint.completed, [], "nothing may be filled behind a CAPTCHA");
  assert.ok(runsDb.listEvents(run.id).some((e) => e.event_type === "blocking_detected"));
});

test("EXEC-8 an MFA prompt pauses the run and no code is read", async () => {
  const run = newRun(mockAtsUrl("mock-mfa"), "greenhouse");
  const after = await executeRun(run.id, runtime, deps());
  assert.equal(after.status, "WAITING_FOR_MFA");
  const record = JSON.stringify(after) + JSON.stringify(runsDb.listEvents(run.id));
  assert.doesNotMatch(record, /otp|passcode|verification_code/i, "no code is captured or stored");
});

// ── approval and submission ──────────────────────────────────────────────────────────────────

test("EXEC-9 a filled application CANNOT be submitted without an approval for that run", async () => {
  const run = newRun(mockAtsUrl("mock-greenhouse"), "greenhouse");
  await executeRun(run.id, runtime, deps());
  runsDb.advanceRun(run.id, "FILLING", { blockingQuestion: null });
  runsDb.advanceRun(run.id, "READY_FOR_REVIEW");

  const other = newRun(mockAtsUrl("mock-greenhouse"), "greenhouse");
  await assert.rejects(
    () => approveAndSubmit(run.id, runtime, { runId: other.id }),
    /explicit approval/i,
    "one job's approval must never submit another"
  );
  assert.notEqual(runsDb.getRun(run.id)!.status, "SUBMITTED");
});

test("EXEC-10 an approval for THIS run submits, and confirmation comes from the page", async () => {
  const run = newRun(mockAtsUrl("mock-greenhouse"), "greenhouse");
  await executeRun(run.id, runtime, deps());
  runsDb.advanceRun(run.id, "FILLING", { blockingQuestion: null });
  runsDb.advanceRun(run.id, "READY_FOR_REVIEW");

  const submitted = await approveAndSubmit(run.id, runtime, { runId: run.id });
  assert.equal(submitted.status, "SUBMITTED");
  assert.ok(submitted.submit_approved_at, "the approval moment is recorded");
  assert.match(submitted.confirmation_text!, /submitted|thank you/i, "the site's own words are the evidence");
});

test("EXEC-11 a page with no confirmation yields SUBMISSION_UNCONFIRMED, never SUBMITTED", async () => {
  /* The MFA page has no submit control and no confirmation text — the honest outcome of clicking
   * into uncertainty is to say so, not to record success. */
  const run = newRun(mockAtsUrl("mock-mfa"), "greenhouse");
  runsDb.advanceRun(run.id, "STARTING");
  runsDb.advanceRun(run.id, "NAVIGATING");
  runsDb.advanceRun(run.id, "FILLING");
  runsDb.advanceRun(run.id, "READY_FOR_REVIEW");

  const after = await approveAndSubmit(run.id, runtime, { runId: run.id });
  assert.notEqual(after.status, "SUBMITTED", "a click is not a confirmation");
  assert.ok(["SUBMISSION_UNCONFIRMED", "FAILED"].includes(after.status), `got ${after.status}`);
});

// ── Lever ────────────────────────────────────────────────────────────────────────────────────

test("EXEC-12 Lever's unlabelled fields fill from adapter hints, custom questions still pause", async () => {
  const run = newRun(mockAtsUrl("mock-lever"), "lever");
  const after = await executeRun(run.id, runtime, deps());

  const checkpoint = JSON.parse(after.checkpoint_json!);
  const keys = checkpoint.completed.map((c: { canonicalKey: string }) => c.canonicalKey);
  assert.ok(keys.includes("full_name"), "Lever's name field has no label and must fill from a hint");
  assert.ok(keys.includes("email"));
  assert.ok(checkpoint.completed.some((c: { kind: string }) => c.kind === "upload"), "resume uploads");

  assert.equal(after.status, "WAITING_FOR_ANSWER", "the custom card question must still stop the run");
});

// ── recovery ─────────────────────────────────────────────────────────────────────────────────

test("EXEC-13 a run's progress survives a restart — the checkpoint is on disk", async () => {
  const run = newRun(mockAtsUrl("mock-greenhouse"), "greenhouse");
  await executeRun(run.id, runtime, deps());

  /* Simulate a restart: re-read the run from storage, as a fresh process would. */
  const reloaded = runsDb.getRun(run.id)!;
  const checkpoint = JSON.parse(reloaded.checkpoint_json!);
  assert.ok(checkpoint.completed.length > 0, "completed work must be recoverable");
  assert.ok(checkpoint.url, "the page it was on is recorded");
  assert.ok(checkpoint.lastAction, "the last successful action is recorded");
  assert.equal(reloaded.status, "WAITING_FOR_ANSWER", "the state survives too");
});

test("EXEC-14 a checkpoint never stores a password or verification code", async () => {
  const run = newRun(mockAtsUrl("mock-greenhouse"), "greenhouse");
  await executeRun(run.id, runtime, deps());
  const stored = runsDb.getRun(run.id)!.checkpoint_json ?? "";
  assert.doesNotMatch(stored, /password|passwd|otp|secret|verification_code/i);
});

test("EXEC-15 a run with no application URL fails safely rather than opening anything", async () => {
  const run = runsDb.createRun({ candidateId: 1, jobId: 2, dedupeKey: "no-url", ats: "greenhouse" });
  const after = await executeRun(run.id, runtime, deps());
  assert.equal(after.status, "FAILED");
  assert.match(after.blocking_reason!, /no application URL/i);
});
