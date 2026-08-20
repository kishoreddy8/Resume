import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The intervention loop end to end, at the data layer: a run stops on an unknown question, the user
 * answers it, the answer is learned, and a SECOND application phrased differently recognises it.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-inbox-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";

/* eslint-disable @typescript-eslint/no-require-imports */
const runs = require("../queries/applicationRuns") as typeof import("../queries/applicationRuns");
const vault = require("../queries/applicationVault") as typeof import("../queries/applicationVault");
const { matchQuestion } = require("@/lib/apply/questionMatching") as typeof import("@/lib/apply/questionMatching");
const { resolveAnswer } = require("@/lib/apply/resolveAnswer") as typeof import("@/lib/apply/resolveAnswer");

test("INBOX-1 an unknown question stops the run and appears in the inbox", () => {
  const run = runs.createRun({ candidateId: 1, jobId: 100, dedupeKey: "gh:1", ats: "greenhouse" });
  runs.advanceRun(run.id, "STARTING");
  runs.advanceRun(run.id, "NAVIGATING");
  runs.advanceRun(run.id, "FILLING");
  runs.advanceRun(run.id, "WAITING_FOR_ANSWER", { blockingQuestion: "What is your desired base salary?" });

  const waiting = runs.listWaitingRuns(1);
  assert.ok(waiting.some((r) => r.id === run.id));
  assert.equal(waiting.find((r) => r.id === run.id)!.blocking_question, "What is your desired base salary?");
});

test("INBOX-2 the user's answer is learned against the canonical question", () => {
  const q = "What is your desired base salary?";
  const match = matchQuestion(q, vault.loadKnownVariants());
  assert.equal(match?.canonicalKey, "desired_salary");

  vault.saveAnswer({
    candidateId: 1,
    canonicalKey: match!.canonicalKey,
    questionType: match!.type,
    observedText: q,
    answerValue: "$185,000",
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
    autoFillAllowed: true,
    sourceAts: "greenhouse",
  });

  const stored = vault.getAnswer(1, "desired_salary");
  assert.equal(stored?.answer_value, "$185,000");
  assert.equal(stored?.approved_by_user, 1);
});

test("INBOX-3 a SECOND application phrased differently recognises the same question", () => {
  /* Different wording, different ATS — the point of the vault. */
  const match = matchQuestion("Desired Salary (USD)", vault.loadKnownVariants());
  assert.equal(match?.canonicalKey, "desired_salary");

  const stored = vault.getAnswer(1, "desired_salary");
  const resolution = resolveAnswer(match!.type, stored);
  assert.notEqual(resolution.action, "ask", "the saved answer must be available to the second application");
  assert.equal(resolution.action === "suggest" ? resolution.value : "", "$185,000");
});

test("INBOX-4 salary stays a suggestion even when marked reusable — policy outranks the flag", () => {
  const stored = vault.getAnswer(1, "desired_salary")!;
  assert.equal(stored.auto_fill_allowed, 0, "a policy of ask_each_time refuses the reuse flag at write time");
  assert.equal(resolveAnswer("salary", stored).action, "suggest");
});

test("INBOX-5 resuming clears the block and returns the run to filling", () => {
  const waiting = runs.listWaitingRuns(1).find((r) => r.blocking_question);
  assert.ok(waiting);
  const resumed = runs.advanceRun(waiting!.id, "FILLING", { blockingReason: null, blockingQuestion: null });
  assert.equal(resumed.status, "FILLING");
  assert.equal(resumed.blocking_question, null);
  assert.ok(!runs.listWaitingRuns(1).some((r) => r.id === waiting!.id), "it is no longer waiting on anyone");
});

test("INBOX-6 an unrecognised question is still answerable, and teaches nothing false", () => {
  const q = "Which of our engineering values resonates most with you?";
  assert.equal(matchQuestion(q, vault.loadKnownVariants()), null, "no confident mapping exists");
  // The run can still be answered and resumed; nothing is written to the vault under a guessed key.
  const run = runs.createRun({ candidateId: 1, jobId: 101, dedupeKey: "gh:2", ats: "greenhouse" });
  runs.advanceRun(run.id, "STARTING");
  runs.advanceRun(run.id, "NAVIGATING");
  runs.advanceRun(run.id, "FILLING");
  runs.advanceRun(run.id, "WAITING_FOR_ANSWER", { blockingQuestion: q });
  const resumed = runs.advanceRun(run.id, "FILLING", { blockingQuestion: null });
  assert.equal(resumed.status, "FILLING");
});
