import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * GAP-2/EXEC — the full discover -> plan -> execute pipeline against a REAL `role="combobox"` /
 * `role="option"` control, proving the fix works end to end and not merely in the pure unit tests.
 *
 * A SEPARATE mock file (mock-greenhouse-combobox.html) rather than extending the shared
 * mock-greenhouse.html — this keeps the change additive and isolated from every existing EXEC-*
 * test's field count and DOM order, per the ticket's "small, scoped, do not redesign" instruction.
 *
 * NO REAL WEBSITE IS EVER OPENED — same file:// guard as execution.test.ts.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-combobox-exec-"));
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
  coverLetterPath: null,
};
fs.writeFileSync(CONTEXT.resumePath, "mock resume");

const runtime = new ApplicationBrowserRuntime();
const comboboxUrl = pathToFileURL(path.join(import.meta.dirname, "mockAts/mock-greenhouse-combobox.html")).href;

function newRun() {
  return runsDb.createRun({
    candidateId: 1,
    jobId: 1,
    dedupeKey: `mock-combobox-${Math.round(performance.now() * 1000)}`,
    ats: "greenhouse",
    applyUrl: comboboxUrl,
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

test("EXEC-01 (e2e): an exact approved combobox option is selected and the run proceeds past it", async () => {
  const stored = new Map([
    ["country", { answer_value: "United Kingdom", answer_source: "APPLICATION_ANSWER_VAULT", approved_by_user: 1, auto_fill_allowed: 1 }],
  ]);
  const run = newRun();
  const after = await executeRun(run.id, runtime, deps(stored as never));

  assert.equal(after.status, "READY_FOR_REVIEW", `expected the combobox fill to succeed, got ${after.status}: ${after.blocking_reason}`);
  const checkpoint = JSON.parse(after.checkpoint_json!);
  const country = checkpoint.completed.find((c: { canonicalKey: string }) => c.canonicalKey === "country");
  assert.ok(country, "the country combobox must be recorded as filled");
});

test("EXEC-02 (e2e): an approved value with no exact combobox option pauses the run rather than guessing", async () => {
  const stored = new Map([
    ["country", { answer_value: "France", answer_source: "APPLICATION_ANSWER_VAULT", approved_by_user: 1, auto_fill_allowed: 1 }],
  ]);
  const run = newRun();
  const after = await executeRun(run.id, runtime, deps(stored as never));

  assert.equal(after.status, "WAITING_FOR_ANSWER", "no exact option must never be resolved by guessing a close one");
  assert.match(after.blocking_reason ?? "", /no option.*exactly matches/i);
});

test("EXEC-03 (e2e): an unanswered combobox question pauses the run safely, same as any other unknown question", async () => {
  const run = newRun();
  const after = await executeRun(run.id, runtime, deps());
  assert.equal(after.status, "WAITING_FOR_ANSWER");
  assert.ok(after.blocking_question, "the run must say WHAT it is waiting for");
});
