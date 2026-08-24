import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-submit-norm-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
delete process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT;

/* eslint-disable @typescript-eslint/no-require-imports */
import type { ExecutionCheckpoint } from "../executor";
import type { FinalReview } from "../../finalReview";
const runsDb = require("@/db/queries/applicationRuns") as typeof import("@/db/queries/applicationRuns");
const candidatesDb = require("@/db/queries/candidates") as typeof import("@/db/queries/candidates");
const candidateSettingsDb = require("@/db/queries/candidateSettings") as typeof import("@/db/queries/candidateSettings");
const vault = require("@/db/queries/applicationVault") as typeof import("@/db/queries/applicationVault");
const { ApplicationBrowserRuntime } = require("../browserRuntime") as typeof import("../browserRuntime");
const { executeRun, approveAndSubmit, getComboboxNormalizer } = require("../executor") as typeof import("../executor");

const CONTEXT = {
  candidateId: 1,
  contact: { name: "Jordan Rivera", email: "jordan@example.test", phone: "(214) 555-0100", location: "Dallas, TX" },
  resumePath: path.join(dir, "Resume.docx"),
  coverLetterPath: null,
};
fs.writeFileSync(CONTEXT.resumePath, "mock resume");

// Seed candidate contact in database
candidatesDb.createCandidate({
  firstName: "Jordan",
  lastName: "Rivera",
});
candidateSettingsDb.updateCandidateContact(1, {
  email: "jordan@example.test",
  phone: "(214) 555-0100",
  location: "Dallas, TX",
});

const runtime = new ApplicationBrowserRuntime();
const mockUrl = pathToFileURL(path.join(import.meta.dirname, "mockAts/mock-submit-normalization.html")).href;

function newRun(applyUrl: string = mockUrl) {
  return runsDb.createRun({
    candidateId: 1,
    jobId: 1,
    dedupeKey: `mock-submit-norm-${Math.round(performance.now() * 1000)}-${Math.random().toString(36).slice(2)}`,
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

test("SUBMIT-NORM-10: getComboboxNormalizer provides single authoritative normalization mapping", () => {
  // location_city with Dallas, TX
  const locNorm = getComboboxNormalizer("location_city", "Dallas", { locationContext: "Dallas, TX" });
  assert.ok(locNorm);
  assert.equal(locNorm(["Dallas, Texas, United States", "Dallas, Georgia, United States"]), "Dallas, Texas, United States");

  // phone_country_code with +1 and United States
  const phoneNorm = getComboboxNormalizer("phone_country_code", "+1", { phoneCountryContext: "United States" });
  assert.ok(phoneNorm);
  assert.equal(phoneNorm(["United States +1", "Canada +1"]), "United States +1");

  // generic combobox (sponsorship / unmapped) has NO normalizer (exact match only)
  assert.equal(getComboboxNormalizer("sponsorship_required", "Yes"), undefined);
  assert.equal(getComboboxNormalizer(null, "Lead Developer"), undefined);
});

test("SUBMIT-NORM-01..07: approveAndSubmit normalizes phone country, location, and refills approved comboboxes to reach SUBMITTED", async () => {
  const run = newRun();

  // 1. Run executeRun to reach WAITING_FOR_ANSWER
  const firstPass = await executeRun(run.id, runtime, deps());
  assert.equal(firstPass.status, "WAITING_FOR_ANSWER");

  const originalCp = JSON.parse(firstPass.checkpoint_json || "{}") as ExecutionCheckpoint;

  // 2. Answer custom and sponsorship questions
  const updatedCp: ExecutionCheckpoint = {
    ...originalCp,
    humanQuestions: [],
    runAnswers: {
      "sponsorship": {
        questionId: "sponsorship",
        selector: "#sponsorship",
        label: "Sponsorship",
        answer: "Yes",
        canonicalKey: "sponsorship_required",
        questionType: "sponsorship",
      },
      "dw-role": {
        questionId: "dw-role",
        selector: "#dw-role",
        label: "Primary Data Warehouse Role",
        answer: "Lead Developer",
        canonicalKey: null,
        questionType: null,
      },
    },
  };

  runsDb.updateCheckpoint(run.id, updatedCp);
  runsDb.advanceRun(run.id, "FILLING");

  // 3. Execute run to reach READY_FOR_REVIEW
  const secondPass = await executeRun(run.id, runtime, deps());
  assert.equal(secondPass.status, "READY_FOR_REVIEW");

  const reviewCp = JSON.parse(secondPass.checkpoint_json || "{}") as ExecutionCheckpoint;
  assert.ok(reviewCp.review);

  // 4. Candidate approves and calls approveAndSubmit
  const submittedRun = await approveAndSubmit(run.id, runtime, { runId: run.id });

  assert.equal(submittedRun.id, run.id);
  assert.equal(submittedRun.status, "SUBMITTED");
  assert.ok(submittedRun.submitted_at);
  assert.ok(submittedRun.confirmation_text);
  assert.ok(submittedRun.confirmation_text.includes("Application submitted"));
});

test("SUBMIT-NORM-08 & SUBMIT-NORM-09: Removed/changed employer option fails closed before submit click", async () => {
  const run = newRun();
  const firstPass = await executeRun(run.id, runtime, deps());

  const originalCp = JSON.parse(firstPass.checkpoint_json || "{}") as ExecutionCheckpoint;

  // Simulate an approved review that has an option no longer present on the form
  const modifiedReview: FinalReview = {
    company: "Celigo",
    role: "Senior Data Engineer",
    ats: "greenhouse",
    resumeFile: CONTEXT.resumePath,
    coverLetterFile: null,
    answers: [
      { question: "First Name", value: "Jordan", source: "PROFILE" },
      { question: "Country", value: "+1", source: "PROFILE" },
      { question: "Phone", value: "(214) 555-0100", source: "PROFILE" },
      { question: "Location (City)", value: "Dallas", source: "PROFILE" },
      { question: "Sponsorship", value: "Invalid Stale Option", source: "USER_INTERVENTION" },
      { question: "Primary Data Warehouse Role", value: "Lead Developer", source: "USER_INTERVENTION" },
    ],
    documents: [],
    unresolved: [],
    warnings: [],
    canApprove: true,
  };

  const updatedCp: ExecutionCheckpoint = {
    ...originalCp,
    completed: [
      { selector: "#first_name", canonicalKey: "first_name", source: "PROFILE", kind: "fill" },
      { selector: "#country", canonicalKey: "phone_country_code", source: "PROFILE", kind: "fill" },
      { selector: "#phone", canonicalKey: "phone", source: "PROFILE", kind: "fill" },
      { selector: "#candidate-location", canonicalKey: "location_city", source: "PROFILE", kind: "fill" },
      { selector: "#sponsorship", canonicalKey: "sponsorship_required", source: "USER_INTERVENTION", kind: "fill" },
      { selector: "#dw-role", canonicalKey: null, source: "USER_INTERVENTION", kind: "fill" },
    ],
    review: modifiedReview,
  };

  runsDb.updateCheckpoint(run.id, updatedCp);
  runsDb.advanceRun(run.id, "FILLING");
  runsDb.advanceRun(run.id, "READY_FOR_REVIEW");

  const submittedRun = await approveAndSubmit(run.id, runtime, { runId: run.id });

  // Must fail closed and not submit
  assert.equal(submittedRun.status, "FAILED");
  assert.equal(submittedRun.submitted_at, null);
  assert.equal(submittedRun.confirmation_text, null);

  const events = runsDb.listEvents(run.id);
  const errorEvent = events.find((e: { event_type: string }) => e.event_type === "execution_error");
  assert.ok(errorEvent);
  assert.ok(errorEvent?.detail?.includes("no longer an exact option"));
});
