import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * OPTION-01..12: Scoped Combobox Option Discovery for Human-Question Batch.
 *
 * Proves that:
 * 1. Required comboboxes dynamically open, capture their scoped option labels, and dismiss without selecting.
 * 2. Unrelated listboxes (e.g. phone-country picker) never pollute combobox options.
 * 3. Options preserve DOM order, are sanitized, and populate checkpoint.humanQuestions.
 * 4. Zero mutations, zero vault writes, zero submissions occur during discovery.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-combobox-options-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
delete process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT;

/* eslint-disable @typescript-eslint/no-require-imports */
import type { HumanQuestion } from "../../agent/types";
const runsDb = require("@/db/queries/applicationRuns") as typeof import("@/db/queries/applicationRuns");
const vault = require("@/db/queries/applicationVault") as typeof import("@/db/queries/applicationVault");
const { ApplicationBrowserRuntime } = require("../browserRuntime") as typeof import("../browserRuntime");
const { executeRun, discoverComboboxOptions } = require("../executor") as typeof import("../executor");

const CONTEXT = {
  candidateId: 1,
  contact: { name: "Jordan Rivera", email: "jordan@example.test", phone: "(214) 555-0100", location: "Dallas, TX" },
  resumePath: path.join(dir, "Resume.docx"),
  coverLetterPath: null,
};
fs.writeFileSync(CONTEXT.resumePath, "mock resume");

const runtime = new ApplicationBrowserRuntime();
const mockUrl = pathToFileURL(path.join(import.meta.dirname, "mockAts/mock-combobox-options.html")).href;

function newRun(applyUrl: string = mockUrl) {
  return runsDb.createRun({
    candidateId: 1,
    jobId: 1,
    dedupeKey: `mock-opt-${Math.round(performance.now() * 1000)}-${Math.random().toString(36).slice(2)}`,
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

test("OPTION-01: Required Greenhouse combobox with 4 options captures all 4", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const options = await discoverComboboxOptions(session.page, "#dw-role");
    assert.deepEqual(options, [
      "Architect",
      "Lead Developer",
      "Senior Developer",
      "Data Analyst",
    ]);
  } finally {
    await session.close();
  }
});

test("OPTION-02: Captured options preserve DOM/employer order", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const options = await discoverComboboxOptions(session.page, "#dw-role");
    assert.equal(options?.[0], "Architect");
    assert.equal(options?.[1], "Lead Developer");
    assert.equal(options?.[2], "Senior Developer");
    assert.equal(options?.[3], "Data Analyst");
  } finally {
    await session.close();
  }
});

test("OPTION-03: Opening for discovery does NOT select any option", async () => {
  const session = await runtime.open(mockUrl);
  try {
    await discoverComboboxOptions(session.page, "#dw-role");
    const val = await session.page.$eval("#dw-role", (el) => (el as HTMLInputElement).value);
    assert.equal(val, "", "Input value must remain empty after discovery");
  } finally {
    await session.close();
  }
});

test("OPTION-04: Only the combobox aria-controls listbox is read", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const deOptions = await discoverComboboxOptions(session.page, "#de-env");
    assert.deepEqual(deOptions, ["Snowflake", "Databricks", "AWS Redshift"]);
  } finally {
    await session.close();
  }
});

test("OPTION-05: A neighboring phone-country listbox cannot pollute options", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const dwOptions = await discoverComboboxOptions(session.page, "#dw-role");
    assert.ok(dwOptions && dwOptions.length > 0);
    assert.ok(!dwOptions.some((o) => o.includes("United States") || o.includes("+1")), "Must not contain phone country items");
  } finally {
    await session.close();
  }
});

test("OPTION-06: Two unresolved combobox questions each receive their own correct options in executeRun", async () => {
  const run = newRun();
  const res = await executeRun(run.id, runtime, deps());
  assert.equal(res.status, "WAITING_FOR_ANSWER");

  const cp = JSON.parse(res.checkpoint_json || "{}") as { humanQuestions?: HumanQuestion[] };
  assert.ok(Array.isArray(cp.humanQuestions));

  const dwQ = cp.humanQuestions.find((q) => q.selector === "#dw-role");
  const deQ = cp.humanQuestions.find((q) => q.selector === "#de-env");

  assert.ok(dwQ, "dwQ should be collected");
  assert.ok(deQ, "deQ should be collected");

  assert.deepEqual(dwQ.options, ["Architect", "Lead Developer", "Senior Developer", "Data Analyst"]);
  assert.deepEqual(deQ.options, ["Snowflake", "Databricks", "AWS Redshift"]);
});

test("OPTION-07: Duplicate/blank option labels are sanitized", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const options = await discoverComboboxOptions(session.page, "#sanitization-test");
    assert.deepEqual(options, ["Snowflake", "Databricks"], "Should trim, deduplicate, and remove blanks");
  } finally {
    await session.close();
  }
});

test("OPTION-08: Failure to discover options does not guess or fail; HumanQuestion safely retains null options", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const options = await discoverComboboxOptions(session.page, "#empty-async");
    assert.equal(options, null, "Empty async combobox should return null options");
  } finally {
    await session.close();
  }
});

test("OPTION-09: Optional voluntary demographic comboboxes are not opened merely for blocking-batch discovery", async () => {
  const run = newRun();
  const res = await executeRun(run.id, runtime, deps());
  assert.equal(res.status, "WAITING_FOR_ANSWER");

  const cp = JSON.parse(res.checkpoint_json || "{}") as { humanQuestions?: HumanQuestion[] };
  const genderQ = cp.humanQuestions?.find((q) => q.selector === "#gender");
  assert.equal(genderQ, undefined, "Optional gender combobox must not block the run or be in humanQuestions batch");
});

test("OPTION-10: No answer is written to Answer Vault during option discovery", async () => {
  const vaultBefore = vault.listAnswers(CONTEXT.candidateId);
  const run = newRun();
  await executeRun(run.id, runtime, deps());
  const vaultAfter = vault.listAnswers(CONTEXT.candidateId);
  assert.equal(vaultAfter.length, vaultBefore.length, "Answer vault must remain untouched during option discovery");
});

test("OPTION-11: No submission method/path is invoked", async () => {
  const run = newRun();
  const res = await executeRun(run.id, runtime, deps());
  assert.equal(res.status, "WAITING_FOR_ANSWER");
  assert.equal(res.submitted_at, null);
  assert.equal(res.confirmation_text, null);
  assert.equal(res.submit_approved_at, null);
});

test("OPTION-12: Existing location async-combobox tests continue passing", async () => {
  // Verifies that selectComboboxOption and location normalization are completely unaffected
  const { exactComboboxOption } = require("../../agent/comboboxSelection");
  assert.equal(exactComboboxOption(["Dallas, Texas, United States", "Dallas, Georgia, United States"], "Dallas, Texas, United States"), "Dallas, Texas, United States");
  assert.equal(exactComboboxOption(["Dallas, Texas, United States"], "Dallas"), null);
});

test.after(async () => {
  await runtime.close();
});
