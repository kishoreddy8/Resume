import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CANDIDATE_STATUS, candidateStatus } from "../candidateStatus";

test("candidate status vocabulary is complete and consistent", () => {
  assert.equal(candidateStatus("newMatch").label, "New match");
  assert.equal(candidateStatus("readyToTailor").label, "Ready to tailor");
  assert.equal(candidateStatus("tailoring").label, "Tailoring");
  assert.equal(candidateStatus("needsReview").label, "Needs review");
  assert.equal(candidateStatus("blocked").label, "Blocked");
  assert.equal(candidateStatus("readyToUse").label, "Ready to use");
  assert.equal(candidateStatus("applicationReady").label, "Application ready");
  assert.equal(candidateStatus("needsYourAction").label, "Needs your action");
  assert.equal(candidateStatus("inProgress").label, "In progress");
  assert.equal(candidateStatus("submitted").label, "Submitted");
  assert.equal(candidateStatus("submissionUnconfirmed").label, "Submission unconfirmed");
  assert.equal(candidateStatus("closed").label, "Closed");
  assert.equal(Object.keys(CANDIDATE_STATUS).length, 12);
});

test("shared candidate status module contains no raw engine or storage vocabulary", () => {
  const source = fs.readFileSync(path.resolve("src/lib/candidateStatus.ts"), "utf8");
  for (const raw of [
    "WAITING_PROMPT",
    "qualityGate",
    "humanMaySend",
    "writerEnabled",
    "schedulerEnabled",
    "blockingFailures",
    "review_json",
    "candidate_job_state",
    "source_type",
    "built_in",
  ]) {
    assert.doesNotMatch(source, new RegExp(raw), `raw term ${raw} must stay out of candidate vocabulary`);
  }
});
