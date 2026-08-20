import test from "node:test";
import assert from "node:assert/strict";
import { deriveNextAction, type ApplicationRecord } from "../nextAction";
import { PROTECTED_PIPELINE_STATUSES, isLifecycleProtected } from "@/lib/jobLifecycle";

const app = (over: Partial<ApplicationRecord> = {}): ApplicationRecord => ({
  dedupeKey: "k",
  jobId: 1,
  title: "Data Engineer",
  company: "Acme",
  stage: "New",
  stageUpdatedAt: null,
  markedForTailoring: false,
  pinned: false,
  notInterested: false,
  notes: null,
  generatedFileCount: 0,
  nextAction: "",
  ...over,
});

test("APP-1 the next action is derived from recorded state, stage by stage", () => {
  assert.match(deriveNextAction(app({ stage: "New" })), /Review this job/);
  assert.match(deriveNextAction(app({ stage: "Interested" })), /Approve tailoring/);
  assert.match(deriveNextAction(app({ stage: "Interested", markedForTailoring: true })), /run the writer/);
  assert.match(deriveNextAction(app({ stage: "Interested", generatedFileCount: 2 })), /Review the generated resume/);
  assert.match(deriveNextAction(app({ stage: "Applied" })), /Awaiting response/);
  assert.match(deriveNextAction(app({ stage: "Interviewing" })), /Prepare for interview/);
  assert.match(deriveNextAction(app({ stage: "Offer" })), /Offer recorded/);
  assert.match(deriveNextAction(app({ stage: "Employer Rejected" })), /Closed/);
});

test("APP-2 not-interested overrides every stage and asks for nothing", () => {
  for (const stage of ["New", "Interested", "Applied", "Interviewing"]) {
    assert.match(deriveNextAction(app({ stage, notInterested: true })), /no action/i);
  }
});

test("APP-3 documents outrank approval — a written resume is reviewed, not re-run", () => {
  const both = app({ stage: "Interested", markedForTailoring: true, generatedFileCount: 3 });
  assert.match(deriveNextAction(both), /Review the generated resume/);
});

test("APP-4 no urgency, deadline or score is ever invented", () => {
  const banned = /urgent|asap|priority|score|% |deadline|overdue|recommended for you/i;
  for (const stage of ["New", "Interested", "Applied", "Interviewing", "Offer", "Employer Rejected"]) {
    for (const flags of [{}, { markedForTailoring: true }, { generatedFileCount: 1 }, { notInterested: true }]) {
      const text = deriveNextAction(app({ stage, ...flags }));
      assert.doesNotMatch(text, banned, `"${text}" asserts pressure this app has no basis for`);
      assert.ok(text.length > 0, "every state must offer a next step or say none is needed");
    }
  }
});

test("APP-5 lifecycle protection for applied/interviewing jobs is untouched", () => {
  // Surfacing applications must not change what the age-sweep may archive.
  assert.deepEqual([...PROTECTED_PIPELINE_STATUSES], ["Applied", "Interviewing", "Offer", "Employer Rejected"]);
  for (const s of PROTECTED_PIPELINE_STATUSES) {
    assert.equal(isLifecycleProtected({ pipelineStatus: s, pinned: 0 }), true, `${s} must stay protected`);
  }
  assert.equal(isLifecycleProtected({ pipelineStatus: "New", pinned: 0 }), false);
  assert.equal(isLifecycleProtected({ pipelineStatus: "New", pinned: 1 }), true, "pinning still protects");
});
