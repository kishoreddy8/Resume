import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-run-answers-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
delete process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT;

/* eslint-disable @typescript-eslint/no-require-imports */
import type { ExecutionCheckpoint } from "../executor";
const runsDb = require("@/db/queries/applicationRuns") as typeof import("@/db/queries/applicationRuns");
const vault = require("@/db/queries/applicationVault") as typeof import("@/db/queries/applicationVault");
const { ApplicationBrowserRuntime } = require("../browserRuntime") as typeof import("../browserRuntime");
const { executeRun } = require("../executor") as typeof import("../executor");

const CONTEXT = {
  candidateId: 1,
  contact: { name: "Jordan Rivera", email: "jordan@example.test", phone: "(214) 555-0100", location: "Dallas, TX" },
  resumePath: path.join(dir, "Resume.docx"),
  coverLetterPath: null,
};
fs.writeFileSync(CONTEXT.resumePath, "mock resume");

const runtime = new ApplicationBrowserRuntime();
const mockUrl = pathToFileURL(path.join(import.meta.dirname, "mockAts/mock-run-scoped-answers.html")).href;

function newRun(applyUrl: string = mockUrl) {
  return runsDb.createRun({
    candidateId: 1,
    jobId: 1,
    dedupeKey: `mock-run-ans-${Math.round(performance.now() * 1000)}-${Math.random().toString(36).slice(2)}`,
    ats: "greenhouse",
    applyUrl,
    resumeFile: CONTEXT.resumePath,
    coverLetterFile: null,
  });
}

function deps(storedAnswers: Map<string, unknown> = new Map()) {
  return {
    context: CONTEXT,
    knownVariants: vault.loadKnownVariants(),
    storedAnswers,
  } as Parameters<typeof executeRun>[2];
}

test.after(async () => {
  await runtime.close();
});

test("RUNANS-EXEC-01: First pass pauses with 2 unmapped combobox questions in humanQuestions batch", async () => {
  const run = newRun();
  const res = await executeRun(run.id, runtime, deps());

  assert.equal(res.status, "WAITING_FOR_ANSWER");
  const cp = JSON.parse(res.checkpoint_json || "{}") as ExecutionCheckpoint;
  assert.ok(Array.isArray(cp.humanQuestions));
  assert.equal(cp.humanQuestions.length, 2);

  const dwQ = cp.humanQuestions.find((q) => q.selector === "#dw-role");
  const deQ = cp.humanQuestions.find((q) => q.selector === "#de-env");
  assert.ok(dwQ);
  assert.ok(deQ);
  assert.equal(dwQ.canonicalKey, null);
  assert.equal(deQ.canonicalKey, null);
});

test("RUNANS-EXEC-02: Supplying runAnswers to checkpoint allows executeRun to fill custom questions and reach READY_FOR_REVIEW", async () => {
  const run = newRun();
  const firstPass = await executeRun(run.id, runtime, deps());
  assert.equal(firstPass.status, "WAITING_FOR_ANSWER");

  const originalCp = JSON.parse(firstPass.checkpoint_json || "{}") as ExecutionCheckpoint;

  // Simulate batch answer submission saving runAnswers to checkpoint
  const updatedCp: ExecutionCheckpoint = {
    ...originalCp,
    humanQuestions: [],
    runAnswers: {
      "dw-role": {
        questionId: "dw-role",
        selector: "#dw-role",
        label: "Primary DW Role",
        answer: "Lead Developer",
        canonicalKey: null,
        questionType: null,
      },
      "de-env": {
        questionId: "de-env",
        selector: "#de-env",
        label: "Primary DE Environment",
        answer: "Snowflake",
        canonicalKey: null,
        questionType: null,
      },
    },
  };

  runsDb.updateCheckpoint(run.id, updatedCp);
  runsDb.advanceRun(run.id, "FILLING");

  // Resume the same run
  const secondPass = await executeRun(run.id, runtime, deps());

  // RUNANS-11: same ApplicationRun ID preserved
  assert.equal(secondPass.id, run.id);

  // All required fields were answered and filled -> advances to READY_FOR_REVIEW
  assert.equal(secondPass.status, "READY_FOR_REVIEW");

  // RUNANS-15: Save Answers & Continue / resume cannot submit
  assert.equal(secondPass.submitted_at, null);
  assert.equal(secondPass.submit_approved_at, null);
  assert.equal(secondPass.confirmation_text, null);

  const finalCp = JSON.parse(secondPass.checkpoint_json || "{}") as ExecutionCheckpoint;

  // RUNANS-08: runAnswers survived resume
  assert.ok(finalCp.runAnswers);
  assert.equal(finalCp.runAnswers["dw-role"].answer, "Lead Developer");
  assert.equal(finalCp.runAnswers["de-env"].answer, "Snowflake");

  // RUNANS-09: answered questions are not in humanQuestions
  assert.equal(finalCp.humanQuestions, undefined);

  // RUNANS-06: custom unmapped answers were NOT written to global Answer Vault
  const vaultAnswers = vault.listAnswers(CONTEXT.candidateId);
  const dwVault = vaultAnswers.find((a) => a.canonical_key === "dw-role");
  assert.equal(dwVault, undefined, "Custom unmapped questions must not be in global Answer Vault");
});
