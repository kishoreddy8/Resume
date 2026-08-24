import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { evaluateWorkflowRetry } from "../workflowRetry";
import type { WorkflowRetryInput } from "../workflowRetry";

/**
 * RETAILOR-01 through RETAILOR-12 — safe user-initiated Re-tailor Resume flow.
 *
 * Pure evaluateWorkflowRetry tests (no DB, no FS): RETAILOR-01..04, RETAILOR-08, RETAILOR-09.
 * Document-resolution tests using a real temp DB and FS: RETAILOR-05, RETAILOR-06, RETAILOR-07.
 * Safety tests: RETAILOR-11, RETAILOR-12.
 */

// =============================================================================
// Shared helpers for pure evaluateWorkflowRetry tests
// =============================================================================

const READY_WORKFLOW = { id: 1, status: "READY", created_at: "2026-01-01 10:00:00" } as const;
const AUTH_OK = { isAuthorized: true, blockingReason: null } as const;
const AUTH_BLOCKED = { isAuthorized: false, blockingReason: "Not authorized" } as const;
const MARKED_AFTER = "2026-01-01 11:00:00"; // strictly after READY_WORKFLOW.created_at

// =============================================================================
// RETAILOR-01: READY + normal workflow request → REUSE_EXISTING
// =============================================================================
test("RETAILOR-01: READY + no userRequestedRetailor → REUSE_EXISTING", () => {
  const decision = evaluateWorkflowRetry({
    existingWorkflow: READY_WORKFLOW,
    tailoringMarkedAt: MARKED_AFTER,
    authorization: AUTH_OK,
    // userRequestedRetailor omitted / falsy
  });
  assert.equal(decision.action, "REUSE_EXISTING");
  assert.ok(decision.reason.includes(String(READY_WORKFLOW.id)));
});

test("RETAILOR-01b: READY + userRequestedRetailor:false → REUSE_EXISTING", () => {
  const decision = evaluateWorkflowRetry({
    existingWorkflow: READY_WORKFLOW,
    tailoringMarkedAt: MARKED_AFTER,
    authorization: AUTH_OK,
    userRequestedRetailor: false,
  });
  assert.equal(decision.action, "REUSE_EXISTING");
});

// =============================================================================
// RETAILOR-02: READY + explicit freshRewrite/re-tailor → CREATE_RETRY
// =============================================================================
test("RETAILOR-02: READY + userRequestedRetailor:true → CREATE_RETRY", () => {
  const decision = evaluateWorkflowRetry({
    existingWorkflow: READY_WORKFLOW,
    tailoringMarkedAt: MARKED_AFTER,
    authorization: AUTH_OK,
    userRequestedRetailor: true,
  });
  assert.equal(decision.action, "CREATE_RETRY");
  assert.ok(decision.reason.includes(String(READY_WORKFLOW.id)), "reason must reference the old workflow id");
  assert.ok(decision.reason.toLowerCase().includes("preserved") || decision.reason.toLowerCase().includes("request"),
    "reason must indicate this is a user request, not automatic");
});

// =============================================================================
// RETAILOR-03: old READY workflow not altered — CREATE_RETRY does not modify existing
// =============================================================================
test("RETAILOR-03: CREATE_RETRY action preserves the old workflow id as-is, not reopened", () => {
  const input: WorkflowRetryInput = {
    existingWorkflow: { id: 42, status: "READY", created_at: "2026-06-01 00:00:00" },
    tailoringMarkedAt: "2026-06-02 00:00:00",
    authorization: AUTH_OK,
    userRequestedRetailor: true,
  };
  const decision = evaluateWorkflowRetry(input);
  assert.equal(decision.action, "CREATE_RETRY");
  // The function returns a DECISION only — it never mutates the input object
  assert.equal(input.existingWorkflow!.status, "READY", "input object must be untouched");
  assert.equal(input.existingWorkflow!.id, 42, "old workflow id must be unchanged");
});

// =============================================================================
// RETAILOR-04: CREATE_RETRY reason must reference the old workflow
// =============================================================================
test("RETAILOR-04: CREATE_RETRY reason names the parent workflow id", () => {
  const decision = evaluateWorkflowRetry({
    existingWorkflow: { id: 99, status: "READY", created_at: "2026-01-01 00:00:00" },
    tailoringMarkedAt: "2026-02-01 00:00:00",
    authorization: AUTH_OK,
    userRequestedRetailor: true,
  });
  assert.equal(decision.action, "CREATE_RETRY");
  assert.ok(decision.reason.includes("99"), "reason must name the old workflow id (99)");
});

// =============================================================================
// RETAILOR-08: double-click / concurrent re-tailor — CREATED + any request → REUSE_EXISTING
// =============================================================================
test("RETAILOR-08: second click while new workflow is CREATED → REUSE_EXISTING (not a third workflow)", () => {
  // After the first re-tailor click, the latest workflow is CREATED (non-terminal).
  // A second click (even with userRequestedRetailor:true) must return REUSE_EXISTING.
  const decision = evaluateWorkflowRetry({
    existingWorkflow: { id: 2, status: "CREATED", created_at: "2026-01-01 12:00:00" },
    tailoringMarkedAt: "2026-01-01 11:00:00",
    authorization: AUTH_OK,
    userRequestedRetailor: true,
  });
  assert.equal(decision.action, "REUSE_EXISTING", "a non-terminal workflow must never be duplicated");
});

test("RETAILOR-08b: IMPROVEMENT_RUNNING is also non-terminal — second click → REUSE_EXISTING", () => {
  const decision = evaluateWorkflowRetry({
    existingWorkflow: { id: 3, status: "IMPROVEMENT_RUNNING", created_at: "2026-01-01 12:00:00" },
    tailoringMarkedAt: "2026-01-01 11:00:00",
    authorization: AUTH_OK,
    userRequestedRetailor: true,
  });
  assert.equal(decision.action, "REUSE_EXISTING");
});

// =============================================================================
// RETAILOR-09: page refresh / ordinary POST does NOT trigger re-tailor
// =============================================================================
test("RETAILOR-09: READY + ordinary POST (no freshRewrite) → REUSE_EXISTING, not re-tailor", () => {
  // This is what happens on every normal queue/resume button press or page-level trigger.
  const decision = evaluateWorkflowRetry({
    existingWorkflow: READY_WORKFLOW,
    tailoringMarkedAt: MARKED_AFTER,
    authorization: AUTH_OK,
    // userRequestedRetailor explicitly absent
  });
  assert.equal(decision.action, "REUSE_EXISTING");
  assert.notEqual(decision.action, "CREATE_RETRY", "READY must never spontaneously regenerate");
});

// =============================================================================
// RETAILOR-11: freshRewrite path does NOT produce an ApplicationRun
// =============================================================================
test("RETAILOR-11: evaluateWorkflowRetry with freshRewrite does not return an ApplicationRun id", () => {
  // evaluateWorkflowRetry only decides which WORKFLOW action to take.
  // ApplicationRuns are a separate concept — the run-start API creates them.
  // This test verifies the decision object has no application-run side-effects.
  const decision = evaluateWorkflowRetry({
    existingWorkflow: READY_WORKFLOW,
    tailoringMarkedAt: MARKED_AFTER,
    authorization: AUTH_OK,
    userRequestedRetailor: true,
  });
  assert.equal(decision.action, "CREATE_RETRY");
  // The decision object must only have action + reason (and optionally code for REFUSE)
  const keys = Object.keys(decision);
  assert.ok(!keys.includes("applicationRunId"), "decision must carry no ApplicationRun side-effects");
  assert.ok(!keys.includes("submittedAt"), "decision must not submit anything");
});

// =============================================================================
// RETAILOR-12: freshRewrite path does NOT submit an application
// =============================================================================
test("RETAILOR-12: CREATE_RETRY decision contains no submission signal", () => {
  const decision = evaluateWorkflowRetry({
    existingWorkflow: READY_WORKFLOW,
    tailoringMarkedAt: MARKED_AFTER,
    authorization: AUTH_OK,
    userRequestedRetailor: true,
  });
  assert.equal(decision.action, "CREATE_RETRY");
  assert.ok(!("submitted" in decision), "no submission key");
  assert.ok(!("approved" in decision), "no approval key");
});

// =============================================================================
// Authorization is still enforced even with userRequestedRetailor
// =============================================================================
test("RETAILOR-auth: READY + userRequestedRetailor but not authorized → REFUSE", () => {
  const decision = evaluateWorkflowRetry({
    existingWorkflow: READY_WORKFLOW,
    tailoringMarkedAt: MARKED_AFTER,
    authorization: AUTH_BLOCKED,
    userRequestedRetailor: true,
  });
  assert.equal(decision.action, "REFUSE");
});

// =============================================================================
// Document-resolution integration tests (RETAILOR-05, 06, 07)
// Use the exact same temp-DB/FS setup pattern as documentLinkage.test.ts
// =============================================================================

let tmpDbDir2: string;
let tmpCandidatesDir2: string;
let tmpGeneratedDir2: string;

let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let getCandidate: typeof import("@/db/queries/candidates").getCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let getCompany: typeof import("@/db/queries/companies").getCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let insertJobMatchResult: typeof import("@/db/queries/jobMatches").insertJobMatchResult;
let setMarkedForTailoring: typeof import("@/db/queries/candidateJobState").setMarkedForTailoring;
let getCandidateJobState: typeof import("@/db/queries/candidateJobState").getCandidateJobState;
let startTailoringRun: typeof import("@/lib/tailoringExecution").startTailoringRun;
let createResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityWorkflow;
let transitionWorkflowStatus: typeof import("@/db/queries/resumeQualityWorkflows").transitionWorkflowStatus;
let publishFinalApplicationArtifacts: typeof import("@/lib/resumeQuality/finalPublication").publishFinalApplicationArtifacts;
let resolveApplicationDocuments: typeof import("@/lib/apply/documentLinkage").resolveApplicationDocuments;

let intCandidateId: number;
let intCompanyId: number;
let intHashCounter = 0;

before(async () => {
  tmpDbDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-retailor-db-"));
  tmpCandidatesDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-retailor-cand-"));
  tmpGeneratedDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-retailor-gen-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir2, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir2;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir2;

  const { getDb } = await import("@/db/index");
  ({ createCandidate, getCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany, getCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ setMarkedForTailoring, getCandidateJobState } = await import("@/db/queries/candidateJobState"));
  ({ startTailoringRun } = await import("@/lib/tailoringExecution"));
  ({ createResumeQualityWorkflow, transitionWorkflowStatus } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ publishFinalApplicationArtifacts } = await import("@/lib/resumeQuality/finalPublication"));
  ({ resolveApplicationDocuments } = await import("@/lib/apply/documentLinkage"));
  getDb();

  intCandidateId = createCandidate({ firstName: "Retailor", lastName: "Test" }).id;
  intCompanyId = createCompany({ name: "RetailorCo", source_type: "greenhouse", ats_board_token: "retailorco" }).id;

  fs.mkdirSync(path.join(tmpCandidatesDir2, String(intCandidateId), "master"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpCandidatesDir2, String(intCandidateId), "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1, sourceHashes: { resume: "r", skills: "s" }, builtAt: "2026-01-01T00:00:00Z",
      skills: [], experience: [], education: [], certifications: [], totalYearsExperience: null,
    })
  );
  fs.writeFileSync(
    path.join(tmpCandidatesDir2, String(intCandidateId), "master", "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: "r" },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: "s" },
    })
  );
});

after(() => {
  fs.rmSync(tmpDbDir2, { recursive: true, force: true });
  fs.rmSync(tmpCandidatesDir2, { recursive: true, force: true });
  fs.rmSync(tmpGeneratedDir2, { recursive: true, force: true });
  delete process.env.CAREER_OPS_CANDIDATES_DIR;
  delete process.env.CAREER_OPS_GENERATED_DIR;
});

function nextIntHash(): string {
  intHashCounter += 1;
  return `retailor-hash-${intHashCounter}`;
}

import type { JobMatchResult } from "@/lib/match/types";
function fakeMatchResult(overrides: Partial<JobMatchResult>): JobMatchResult {
  return {
    candidateId: intCandidateId, jobId: 1, dedupeKey: "x",
    matchEngineVersion: 2, matchKnowledgeHash: nextIntHash(),
    candidateProfileHash: "p", candidateSettingsHash: "s", jdContentHash: "j",
    computedAt: "2026-01-01T00:00:00Z",
    eligibility: { status: "PASS", reasons: [], sponsorship: { signal: "not_applicable", note: "n/a" } },
    dimensionScores: { roleAlignment: null, required: 90, preferred: 50, experience: 100, seniority: 100 },
    overallScore: 90, requirementCoverage: 0.9, employerEvidencedShare: 0.9, insufficientJdSignal: false,
    employerEvidencedMatches: [], inventoryOnlyMatches: [], transferableMatches: [],
    missingRequirements: [], unresolvedRequirements: [], criticalGaps: [], unrecognizedCandidateSkills: [],
    recommendedTrack: "Data Engineer", decision: "READY_FOR_TAILORING", blockingReasons: [],
    roleAlignmentDetail: null,
    ...overrides,
  };
}

let intJobCounter = 0;
function makeIntJob() {
  intJobCounter += 1;
  const externalId = `retailor-ext-${intJobCounter}`;
  const dedupeKey = dedupeKeyForAts("greenhouse", intCompanyId, externalId);
  upsertJob({
    companyId: intCompanyId, sourceType: "greenhouse", dedupeKey,
    job: {
      externalId, title: `Senior Data Engineer ${intJobCounter}`, location: null, department: null,
      url: `https://boards.greenhouse.io/retailorco/${externalId}`, descriptionHtml: null, descriptionText: "desc",
      employmentType: null, workplaceType: null, salaryText: null, postedAt: new Date().toISOString(), raw: null,
    },
    descriptionSections: null, sponsorshipMentioned: false, sponsorshipPolarity: "none",
    sponsorshipSnippet: null, h1bCombinedConfidence: "Unknown",
  });
  return getJobByDedupeKey(dedupeKey)!;
}

function makeIntWorkflow(job: { id: number; dedupe_key: string }) {
  insertJobMatchResult(fakeMatchResult({ candidateId: intCandidateId, jobId: job.id, dedupeKey: job.dedupe_key, candidateProfileHash: `p-${nextIntHash()}`, decision: "READY_FOR_TAILORING" }));
  setMarkedForTailoring(intCandidateId, job.dedupe_key, true, { approvalType: "READY_DIRECT", decision: "READY_FOR_TAILORING" });
  const { run } = startTailoringRun({ candidateId: intCandidateId, jobId: job.id });
  const applicationId = getCandidateJobState(intCandidateId, job.dedupe_key)!.id;
  const workflow = createResumeQualityWorkflow({ candidateId: intCandidateId, applicationId, tailoringRunId: run.id, dedupeKey: run.dedupe_key });
  return { workflow, tailoringRunId: run.id };
}

function makeSourceDocs2(content: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-retailor-src-"));
  const resumePath = path.join(dir, "Resume.docx");
  const coverPath = path.join(dir, "CoverLetter.docx");
  const feedbackPath = path.join(dir, "review_feedback.md");
  fs.writeFileSync(resumePath, content);
  fs.writeFileSync(coverPath, `cover:${content}`);
  fs.writeFileSync(feedbackPath, `feedback:${content}`);
  return { dir, resumePath, coverPath, feedbackPath };
}

function publishReadyWorkflow(
  job: { id: number; dedupe_key: string; title: string },
  workflow: { id: number; tailoring_run_id: number },
  content: string
) {
  const candidate = getCandidate(intCandidateId)!;
  const company = getCompany(intCompanyId)!;
  const src = makeSourceDocs2(content);
  transitionWorkflowStatus(intCandidateId, workflow.id, "WRITER_RUNNING");
  transitionWorkflowStatus(intCandidateId, workflow.id, "WRITER_COMPLETED");
  transitionWorkflowStatus(intCandidateId, workflow.id, "REVIEW_RUNNING");
  transitionWorkflowStatus(intCandidateId, workflow.id, "REVIEW_COMPLETED");
  transitionWorkflowStatus(intCandidateId, workflow.id, "READY", { finalApprovedIteration: 1, latestOverallScore: 96 });
  publishFinalApplicationArtifacts({
    candidateId: intCandidateId,
    candidateFirstName: candidate.first_name || "Retailor",
    companyId: company.id,
    companyName: company.name,
    jobId: job.id,
    jobTitle: job.title,
    dedupeKey: job.dedupe_key,
    applicationId: getCandidateJobState(intCandidateId, job.dedupe_key)!.id,
    tailoringRunId: workflow.tailoring_run_id,
    workflowId: workflow.id,
    workflowStatus: "READY",
    iterationNumber: 1,
    sourceFinalDirectory: src.dir,
    sourceResumePath: src.resumePath,
    sourceCoverLetterPath: src.coverPath,
    sourceReviewFeedbackPath: src.feedbackPath,
    publishedAt: new Date().toISOString(),
  });
  return src;
}

// =============================================================================
// RETAILOR-05: old READY artifacts remain eligible while new workflow is CREATED
// =============================================================================
test("RETAILOR-05: old READY remains eligible while new re-tailor workflow is in-progress (CREATED)", () => {
  const job = makeIntJob();

  // Workflow #1: READY with published artifacts
  const w1 = makeIntWorkflow(job);
  publishReadyWorkflow(job, w1.workflow, "workflow-1-ready-content");

  // Sanity: Workflow #1 alone → ready
  const before = resolveApplicationDocuments({ candidateId: intCandidateId, dedupeKey: job.dedupe_key, jobId: job.id, companyName: "RetailorCo" });
  assert.equal(before.ready, true, "Workflow #1 should be ready before re-tailor");
  if (before.ready) assert.equal(before.workflowId, w1.workflow.id);

  // Re-tailor clicked: Workflow #2 created (CREATED status, no artifacts yet)
  const w2 = makeIntWorkflow(job);
  // w2 is in CREATED status — the newest workflow, not yet READY

  // Workflow #2 is newest but CREATED — resolveApplicationDocuments should fall back to Workflow #1
  const after = resolveApplicationDocuments({ candidateId: intCandidateId, dedupeKey: job.dedupe_key, jobId: job.id, companyName: "RetailorCo" });
  assert.equal(after.ready, true, "old READY workflow must remain eligible while new workflow is CREATED");
  if (after.ready) {
    assert.equal(after.workflowId, w1.workflow.id, "must use old READY workflow, not new CREATED one");
    assert.equal(after.source, "AUTONOMOUS_READY");
    assert.equal(fs.readFileSync(after.resumePath, "utf-8"), "workflow-1-ready-content");
  }
  assert.notEqual(w1.workflow.id, w2.workflow.id, "two distinct workflow rows created");
});

// =============================================================================
// RETAILOR-06: new FAILED workflow does NOT invalidate old READY
// =============================================================================
test("RETAILOR-06: new FAILED re-tailor does not invalidate old READY workflow", () => {
  const job = makeIntJob();

  // Workflow #1: READY
  const w1 = makeIntWorkflow(job);
  publishReadyWorkflow(job, w1.workflow, "workflow-1-still-valid");

  // Workflow #2: FAILED (re-tailor attempt that failed)
  const w2 = makeIntWorkflow(job);
  transitionWorkflowStatus(intCandidateId, w2.workflow.id, "FAILED", { failureReason: "quality gate not met" });

  // Workflow #2 is newest and FAILED — no approval — resolveApplicationDocuments falls back to Workflow #1
  const result = resolveApplicationDocuments({ candidateId: intCandidateId, dedupeKey: job.dedupe_key, jobId: job.id, companyName: "RetailorCo" });
  assert.equal(result.ready, true, "old READY must remain eligible when re-tailor FAILED");
  if (result.ready) {
    assert.equal(result.workflowId, w1.workflow.id, "must fall back to old READY, not the new FAILED one");
    assert.equal(result.source, "AUTONOMOUS_READY");
    assert.equal(fs.readFileSync(result.resumePath, "utf-8"), "workflow-1-still-valid");
  }
});

// =============================================================================
// RETAILOR-07: new successful READY workflow becomes the current eligible artifact
// =============================================================================
test("RETAILOR-07: new READY re-tailor becomes the current eligible artifact", () => {
  const job = makeIntJob();

  // Workflow #1: READY
  const w1 = makeIntWorkflow(job);
  publishReadyWorkflow(job, w1.workflow, "workflow-1-old-version");

  // Workflow #2: also reaches READY (the re-tailor succeeded)
  const w2 = makeIntWorkflow(job);
  publishReadyWorkflow(job, w2.workflow, "workflow-2-new-version");

  // Workflow #2 is newest and READY — resolveApplicationDocuments must use Workflow #2
  const result = resolveApplicationDocuments({ candidateId: intCandidateId, dedupeKey: job.dedupe_key, jobId: job.id, companyName: "RetailorCo" });
  assert.equal(result.ready, true);
  if (result.ready) {
    assert.equal(result.workflowId, w2.workflow.id, "new READY workflow must supersede the old one");
    assert.equal(result.source, "AUTONOMOUS_READY");
    assert.equal(fs.readFileSync(result.resumePath, "utf-8"), "workflow-2-new-version");
  }
});
