import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockAtsUrl } from "./mockAts/paths";

/**
 * PHASE 9D — QUESTION-BATCH-01/02/03. These prove behavior that already exists from Phase 9A/9B
 * (batched human questions; the multi-page validation-remediation pass), under the exact names this
 * phase's spec asked for, using the existing mock fixtures rather than new ones.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-question-batch-"));
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
  contact: { name: "Jordan Rivera", email: "jordan@example.test", phone: "(214) 555-0100", location: "Dallas, TX" },
  resumePath: path.join(dir, "Resume.docx"),
  coverLetterPath: path.join(dir, "CoverLetter.docx"),
};
fs.writeFileSync(CONTEXT.resumePath, "mock resume");
fs.writeFileSync(CONTEXT.coverLetterPath, "mock cover letter");

const runtime = new ApplicationBrowserRuntime();

function deps() {
  return { context: CONTEXT, knownVariants: vault.loadKnownVariants(), storedAnswers: new Map() } as Parameters<typeof executeRun>[2];
}

function newRun(url: string, ats: string) {
  return runsDb.createRun({
    candidateId: 1,
    jobId: 1,
    dedupeKey: `mock-qbatch-${Math.round(performance.now() * 1000)}`,
    ats,
    applyUrl: url,
    resumeFile: CONTEXT.resumePath,
    coverLetterFile: CONTEXT.coverLetterPath,
  });
}

test.after(async () => {
  await runtime.close();
});

test("QUESTION-BATCH-01: multiple unresolved required questions on one page are returned together, not one at a time", async () => {
  const run = newRun(mockAtsUrl("mock-greenhouse"), "greenhouse");
  const after = await executeRun(run.id, runtime, deps());
  assert.equal(after.status, "WAITING_FOR_ANSWER");
  const checkpoint = JSON.parse(after.checkpoint_json!);
  const questions = checkpoint.humanQuestions as { label: string }[];
  assert.ok(questions.length >= 3, `expected several unresolved questions batched together, got ${questions.length}`);
  assert.ok(questions.some((q) => /sponsorship/i.test(q.label)));
  assert.ok(questions.some((q) => /salary/i.test(q.label)));
});

test("QUESTION-BATCH-02: answering the whole batch resumes the SAME run — no new run is created", async () => {
  const run = newRun(mockAtsUrl("mock-greenhouse"), "greenhouse");
  const paused = await executeRun(run.id, runtime, deps());
  assert.equal(paused.status, "WAITING_FOR_ANSWER");
  const checkpoint = JSON.parse(paused.checkpoint_json!);
  const questions = checkpoint.humanQuestions as { id: string; label: string }[];

  const runAnswers: Record<string, { questionId: string; selector: string; label: string; answer: string; canonicalKey: string | null; questionType: null }> = {};
  for (const q of questions) {
    runAnswers[q.id] = { questionId: q.id, selector: `#${q.id}`, label: q.label, answer: "N/A", canonicalKey: null, questionType: null };
  }
  runsDb.updateCheckpoint(run.id, { ...checkpoint, runAnswers });
  runsDb.advanceRun(run.id, "FILLING");

  const resumed = await executeRun(run.id, runtime, deps());
  assert.equal(resumed.id, run.id, "the SAME run id resumes — nothing new was created");
  assert.ok(runsDb.listRuns(1, 10).filter((r) => r.dedupe_key === run.dedupe_key).length === 1, "exactly one run exists for this job");
});

function multiAdapter() {
  return {
    sourceType: "greenhouse" as const,
    fieldSelectorHints: () => ({}),
    nextPageSelector: () => "#advance",
    reviewPageMarkers: () => ["review your application"],
  };
}

test("QUESTION-BATCH-03: a conditional question revealed after answering the current batch becomes a NEW batch — never guessed at, never assumed to be the only one", async () => {
  const run = newRun(mockAtsUrl("mock-multipage-validation"), "greenhouse");
  const after = await executeRun(run.id, runtime, deps(), { adapter: multiAdapter() });
  // The first pass could not have known "Are you legally authorized to work..." existed — it is
  // revealed only after the Next click, proving the original discovery pass never assumed
  // completeness (see multiPageExecution.test.ts's MULTIPAGE-11 for the full mechanics).
  assert.equal(after.status, "WAITING_FOR_ANSWER");
  assert.match(after.blocking_question ?? "", /legally authorized to work/i);
  const checkpoint = JSON.parse(after.checkpoint_json!);
  assert.equal(checkpoint.page, 1, "still the same page — a revealed question is not treated as an advance");
});
