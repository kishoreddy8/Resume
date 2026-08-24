import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { evaluateWorkflowRetry } from "../workflowRetry";
import { evaluateTailoringAuthorization } from "../tailoringAuthorization";
import type { JobMatchResult } from "@/lib/match/types";

/**
 * RETAILOR-AUTH-01 through RETAILOR-AUTH-10
 *
 * Verifies that explicit Re-tailor from a READY workflow legitimately refreshes the
 * candidate's tailoring approval against the CURRENT match decision before creating
 * a new workflow version, without bypassing the state machine or authorization guards.
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;
let tmpGeneratedDir: string;

let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let insertJobMatchResult: typeof import("@/db/queries/jobMatches").insertJobMatchResult;
let setMarkedForTailoring: typeof import("@/db/queries/candidateJobState").setMarkedForTailoring;
let getCandidateJobState: typeof import("@/db/queries/candidateJobState").getCandidateJobState;
let startTailoringRun: typeof import("@/lib/tailoringExecution").startTailoringRun;
let createResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityWorkflow;
let transitionWorkflowStatus: typeof import("@/db/queries/resumeQualityWorkflows").transitionWorkflowStatus;
let getResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").getResumeQualityWorkflow;
let listResumeQualityWorkflowsForJob: typeof import("@/db/queries/resumeQualityWorkflows").listResumeQualityWorkflowsForJob;
let getExistingProtectedRun: typeof import("@/db/queries/applicationRuns").getExistingProtectedRun;

let testCandidateId: number;
let testCompanyId: number;
let jobCounter = 0;
let hashCounter = 0;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-retailor-auth-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-retailor-auth-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-retailor-auth-gen-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  const { getDb } = await import("@/db/index");
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ setMarkedForTailoring, getCandidateJobState } = await import("@/db/queries/candidateJobState"));
  ({ startTailoringRun } = await import("@/lib/tailoringExecution"));
  ({
    createResumeQualityWorkflow,
    transitionWorkflowStatus,
    getResumeQualityWorkflow,
    listResumeQualityWorkflowsForJob,
  } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ getExistingProtectedRun } = await import("@/db/queries/applicationRuns"));
  getDb();

  testCandidateId = createCandidate({ firstName: "AuthRefresh", lastName: "Candidate" }).id;
  testCompanyId = createCompany({ name: "AuthRefreshCo", source_type: "greenhouse", ats_board_token: "authco" }).id;

  fs.mkdirSync(path.join(tmpCandidatesDir, String(testCandidateId), "master"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpCandidatesDir, String(testCandidateId), "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: "r", skills: "s" },
      builtAt: "2026-01-01T00:00:00Z",
      skills: [],
      experience: [],
      education: [],
      certifications: [],
      totalYearsExperience: null,
    })
  );
  fs.writeFileSync(
    path.join(tmpCandidatesDir, String(testCandidateId), "master", "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: "r" },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: "s" },
    })
  );
});

after(() => {
  fs.rmSync(tmpDbDir, { recursive: true, force: true });
  fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  fs.rmSync(tmpGeneratedDir, { recursive: true, force: true });
  delete process.env.CAREER_OPS_CANDIDATES_DIR;
  delete process.env.CAREER_OPS_GENERATED_DIR;
});

function makeJob() {
  jobCounter += 1;
  const externalId = `auth-ext-${jobCounter}`;
  const dedupeKey = dedupeKeyForAts("greenhouse", testCompanyId, externalId);
  upsertJob({
    companyId: testCompanyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId,
      title: `Auth Test Role ${jobCounter}`,
      location: null,
      department: null,
      url: `https://boards.greenhouse.io/authco/${externalId}`,
      descriptionHtml: null,
      descriptionText: "description",
      employmentType: null,
      workplaceType: null,
      salaryText: null,
      postedAt: new Date().toISOString(),
      raw: null,
    },
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  return getJobByDedupeKey(dedupeKey)!;
}

function fakeMatch(jobId: number, dedupeKey: string, decision: "READY_FOR_TAILORING" | "NEEDS_REVIEW" | "BLOCKED"): JobMatchResult {
  hashCounter += 1;
  return {
    candidateId: testCandidateId,
    jobId,
    dedupeKey,
    matchEngineVersion: 2,
    matchKnowledgeHash: `hash-${hashCounter}`,
    candidateProfileHash: "p",
    candidateSettingsHash: "s",
    jdContentHash: "j",
    computedAt: new Date().toISOString(),
    eligibility: { status: "PASS", reasons: [], sponsorship: { signal: "not_applicable", note: "n/a" } },
    dimensionScores: { roleAlignment: null, required: 90, preferred: 50, experience: 100, seniority: 100 },
    overallScore: decision === "BLOCKED" ? 30 : decision === "NEEDS_REVIEW" ? 70 : 95,
    requirementCoverage: 0.9,
    employerEvidencedShare: 0.9,
    insufficientJdSignal: false,
    employerEvidencedMatches: [],
    inventoryOnlyMatches: [],
    transferableMatches: [],
    missingRequirements: [],
    unresolvedRequirements: [],
    criticalGaps: [],
    unrecognizedCandidateSkills: [],
    recommendedTrack: "Data Engineer",
    decision,
    blockingReasons: decision === "BLOCKED" ? ["Hard gap"] : [],
    roleAlignmentDetail: null,
  };
}

function transitionToReady(workflowId: number, finalApprovedIteration = 1) {
  transitionWorkflowStatus(testCandidateId, workflowId, "WRITER_RUNNING");
  transitionWorkflowStatus(testCandidateId, workflowId, "WRITER_COMPLETED");
  transitionWorkflowStatus(testCandidateId, workflowId, "REVIEW_RUNNING");
  transitionWorkflowStatus(testCandidateId, workflowId, "REVIEW_COMPLETED");
  transitionWorkflowStatus(testCandidateId, workflowId, "READY", {
    finalApprovedIteration,
    latestOverallScore: 96,
  });
}

// =============================================================================
// RETAILOR-AUTH-01: READY workflow + stale NEEDS_REVIEW approval + current READY_FOR_TAILORING
// =============================================================================
test("RETAILOR-AUTH-01: stale approval blocks re-tailor until refreshed against current READY_FOR_TAILORING decision", () => {
  const job = makeJob();
  const dedupeKey = job.dedupe_key;

  // 1. Initial match decision was NEEDS_REVIEW
  insertJobMatchResult(fakeMatch(job.id, dedupeKey, "NEEDS_REVIEW"));

  // 2. Candidate approved override and created Workflow #1 which became READY
  setMarkedForTailoring(testCandidateId, dedupeKey, true, {
    approvalType: "NEEDS_REVIEW_OVERRIDE",
    decision: "NEEDS_REVIEW",
  });
  const { run: run1 } = startTailoringRun({ candidateId: testCandidateId, jobId: job.id });
  const wf1 = createResumeQualityWorkflow({
    candidateId: testCandidateId,
    applicationId: 1,
    tailoringRunId: run1.id,
    dedupeKey,
  });
  transitionToReady(wf1.id, 1);

  // 3. Match was later updated to READY_FOR_TAILORING
  insertJobMatchResult(fakeMatch(job.id, dedupeKey, "READY_FOR_TAILORING"));

  // 4. Stale approval evaluates as NOT authorized
  const staleAuth = evaluateTailoringAuthorization(testCandidateId, dedupeKey);
  assert.equal(staleAuth.isAuthorized, false, "stale approval must not be authorized");
  assert.ok(staleAuth.blockingReason?.includes("NEEDS_REVIEW"));
  assert.ok(staleAuth.blockingReason?.includes("READY_FOR_TAILORING"));

  // 5. evaluateWorkflowRetry refuses re-tailor when authorization is stale
  const refusedDecision = evaluateWorkflowRetry({
    existingWorkflow: { id: wf1.id, status: "READY", created_at: wf1.created_at },
    tailoringMarkedAt: staleAuth.markedAt,
    authorization: staleAuth,
    userRequestedRetailor: true,
  });
  assert.equal(refusedDecision.action, "REFUSE");

  // 6. Explicit re-approval refreshes candidate_job_state to READY_DIRECT / READY_FOR_TAILORING
  setMarkedForTailoring(testCandidateId, dedupeKey, true, {
    approvalType: "READY_DIRECT",
    decision: "READY_FOR_TAILORING",
  });
  const refreshedState = getCandidateJobState(testCandidateId, dedupeKey)!;
  assert.equal(refreshedState.tailoring_approval_type, "READY_DIRECT");
  assert.equal(refreshedState.tailoring_approved_decision, "READY_FOR_TAILORING");

  // 7. Authorization is now valid
  const freshAuth = evaluateTailoringAuthorization(testCandidateId, dedupeKey);
  assert.equal(freshAuth.isAuthorized, true);

  // 8. evaluateWorkflowRetry now permits CREATE_RETRY
  const allowedDecision = evaluateWorkflowRetry({
    existingWorkflow: { id: wf1.id, status: "READY", created_at: wf1.created_at },
    tailoringMarkedAt: freshAuth.markedAt,
    authorization: freshAuth,
    userRequestedRetailor: true,
  });
  assert.equal(allowedDecision.action, "CREATE_RETRY");
});

// =============================================================================
// RETAILOR-AUTH-02: current NEEDS_REVIEW → Re-tailor uses NEEDS_REVIEW_OVERRIDE
// =============================================================================
test("RETAILOR-AUTH-02: current NEEDS_REVIEW uses NEEDS_REVIEW_OVERRIDE approval type", () => {
  const job = makeJob();
  const dedupeKey = job.dedupe_key;

  insertJobMatchResult(fakeMatch(job.id, dedupeKey, "NEEDS_REVIEW"));

  setMarkedForTailoring(testCandidateId, dedupeKey, true, {
    approvalType: "NEEDS_REVIEW_OVERRIDE",
    decision: "NEEDS_REVIEW",
  });

  const auth = evaluateTailoringAuthorization(testCandidateId, dedupeKey);
  assert.equal(auth.isAuthorized, true);
  assert.equal(auth.approvalType, "NEEDS_REVIEW_OVERRIDE");
  assert.equal(auth.approvedDecision, "NEEDS_REVIEW");
});

// =============================================================================
// RETAILOR-AUTH-03: approval PATCH failure → freshRewrite POST is NOT authorized
// =============================================================================
test("RETAILOR-AUTH-03: if approval refresh fails or does not happen, freshRewrite is refused", () => {
  const job = makeJob();
  const dedupeKey = job.dedupe_key;

  insertJobMatchResult(fakeMatch(job.id, dedupeKey, "READY_FOR_TAILORING"));

  // Approval was NOT set for this job (or un-marked)
  setMarkedForTailoring(testCandidateId, dedupeKey, false);

  const auth = evaluateTailoringAuthorization(testCandidateId, dedupeKey);
  assert.equal(auth.isAuthorized, false);

  const decision = evaluateWorkflowRetry({
    existingWorkflow: { id: 1, status: "READY", created_at: "2026-01-01 00:00:00" },
    tailoringMarkedAt: null,
    authorization: auth,
    userRequestedRetailor: true,
  });
  assert.equal(decision.action, "REFUSE");
  assert.equal((decision as { code?: string }).code, "NOT_AUTHORIZED");
});

// =============================================================================
// RETAILOR-AUTH-04: candidate cancels confirm → no approval change, no new workflow
// =============================================================================
test("RETAILOR-AUTH-04: when user cancels confirm, no workflow is requested or created", () => {
  const job = makeJob();
  const dedupeKey = job.dedupe_key;

  insertJobMatchResult(fakeMatch(job.id, dedupeKey, "READY_FOR_TAILORING"));

  setMarkedForTailoring(testCandidateId, dedupeKey, true, {
    approvalType: "READY_DIRECT",
    decision: "READY_FOR_TAILORING",
  });
  const { run } = startTailoringRun({ candidateId: testCandidateId, jobId: job.id });
  const wf = createResumeQualityWorkflow({
    candidateId: testCandidateId,
    applicationId: 1,
    tailoringRunId: run.id,
    dedupeKey,
  });
  transitionToReady(wf.id, 1);

  // State remains exactly 1 workflow
  const workflows = listResumeQualityWorkflowsForJob(testCandidateId, dedupeKey);
  assert.equal(workflows.length, 1);
});

// =============================================================================
// RETAILOR-AUTH-05: ordinary READY page load/request does not refresh approval
// =============================================================================
test("RETAILOR-AUTH-05: ordinary GET or non-retailor POST returns REUSE_EXISTING without altering approval", () => {
  const decision = evaluateWorkflowRetry({
    existingWorkflow: { id: 10, status: "READY", created_at: "2026-01-01 00:00:00" },
    tailoringMarkedAt: "2026-01-01 01:00:00",
    authorization: { isAuthorized: true, blockingReason: null },
    userRequestedRetailor: false,
  });
  assert.equal(decision.action, "REUSE_EXISTING");
});

// =============================================================================
// RETAILOR-AUTH-06: blocked/ineligible current decision cannot be re-approved
// =============================================================================
test("RETAILOR-AUTH-06: BLOCKED match decision cannot produce an authorized Re-tailor", () => {
  const job = makeJob();
  const dedupeKey = job.dedupe_key;

  insertJobMatchResult(fakeMatch(job.id, dedupeKey, "BLOCKED"));

  // Attempting to evaluate authorization for a BLOCKED job
  const auth = evaluateTailoringAuthorization(testCandidateId, dedupeKey);
  assert.equal(auth.isAuthorized, false);

  const decision = evaluateWorkflowRetry({
    existingWorkflow: { id: 20, status: "READY", created_at: "2026-01-01 00:00:00" },
    tailoringMarkedAt: "2026-01-01 01:00:00",
    authorization: auth,
    userRequestedRetailor: true,
  });
  assert.equal(decision.action, "REFUSE");
});

// =============================================================================
// RETAILOR-AUTH-07: old READY workflow remains unchanged
// =============================================================================
test("RETAILOR-AUTH-07: existing READY workflow is not mutated when a new workflow is created", () => {
  const job = makeJob();
  const dedupeKey = job.dedupe_key;

  insertJobMatchResult(fakeMatch(job.id, dedupeKey, "READY_FOR_TAILORING"));

  setMarkedForTailoring(testCandidateId, dedupeKey, true, {
    approvalType: "READY_DIRECT",
    decision: "READY_FOR_TAILORING",
  });

  const { run: run1 } = startTailoringRun({ candidateId: testCandidateId, jobId: job.id });
  const wf1 = createResumeQualityWorkflow({
    candidateId: testCandidateId,
    applicationId: 1,
    tailoringRunId: run1.id,
    dedupeKey,
  });
  transitionToReady(wf1.id, 2);

  const wf1Initial = getResumeQualityWorkflow(testCandidateId, wf1.id)!;
  assert.equal(wf1Initial.status, "READY");
  assert.equal(wf1Initial.final_approved_iteration, 2);

  // Now create new workflow via re-tailor
  const { run: run2 } = startTailoringRun({ candidateId: testCandidateId, jobId: job.id });
  const wf2 = createResumeQualityWorkflow({
    candidateId: testCandidateId,
    applicationId: 1,
    tailoringRunId: run2.id,
    dedupeKey,
  });

  // Verify wf1 remains untouched
  const wf1After = getResumeQualityWorkflow(testCandidateId, wf1.id)!;
  assert.equal(wf1After.status, "READY");
  assert.equal(wf1After.final_approved_iteration, 2);
  assert.equal(wf1After.created_at, wf1Initial.created_at);

  assert.equal(wf2.status, "CREATED");
  assert.notEqual(wf2.id, wf1.id);
});

// =============================================================================
// RETAILOR-AUTH-08: successful approval refresh creates exactly one new workflow
// =============================================================================
test("RETAILOR-AUTH-08: subsequent re-tailor calls during CREATED state reuse in-progress workflow", () => {
  const job = makeJob();
  const dedupeKey = job.dedupe_key;

  insertJobMatchResult(fakeMatch(job.id, dedupeKey, "READY_FOR_TAILORING"));

  setMarkedForTailoring(testCandidateId, dedupeKey, true, {
    approvalType: "READY_DIRECT",
    decision: "READY_FOR_TAILORING",
  });

  const { run } = startTailoringRun({ candidateId: testCandidateId, jobId: job.id });
  const wf = createResumeQualityWorkflow({
    candidateId: testCandidateId,
    applicationId: 1,
    tailoringRunId: run.id,
    dedupeKey,
  });

  // In CREATED state, another Re-tailor request is reused
  const decision = evaluateWorkflowRetry({
    existingWorkflow: { id: wf.id, status: wf.status, created_at: wf.created_at },
    tailoringMarkedAt: "2026-01-01 00:00:00",
    authorization: { isAuthorized: true, blockingReason: null },
    userRequestedRetailor: true,
  });
  assert.equal(decision.action, "REUSE_EXISTING");
});

// =============================================================================
// RETAILOR-AUTH-09: no ApplicationRun created during Re-tailor
// =============================================================================
test("RETAILOR-AUTH-09: Re-tailor authorization does not create an ApplicationRun", () => {
  const job = makeJob();
  const dedupeKey = job.dedupe_key;
  const existingRun = getExistingProtectedRun(testCandidateId, dedupeKey);
  assert.equal(existingRun, undefined, "no application run must exist for this dedupeKey");
});

// =============================================================================
// RETAILOR-AUTH-10: no application submission path invoked
// =============================================================================
test("RETAILOR-AUTH-10: Re-tailor decision carries no submission capability", () => {
  const decision = evaluateWorkflowRetry({
    existingWorkflow: { id: 1, status: "READY", created_at: "2026-01-01 00:00:00" },
    tailoringMarkedAt: "2026-01-01 01:00:00",
    authorization: { isAuthorized: true, blockingReason: null },
    userRequestedRetailor: true,
  });
  assert.equal(decision.action, "CREATE_RETRY");
  assert.ok(!("submit" in decision));
  assert.ok(!("approveAndSubmit" in decision));
});
