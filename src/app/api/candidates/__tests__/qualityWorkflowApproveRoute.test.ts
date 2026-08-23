import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import type { JobMatchResult } from "@/lib/match/types";
import type { ComplianceStatus, InstructionComplianceChecks, StructuredResumeReview } from "@/lib/resumeQuality/types";

/**
 * Tests src/app/api/candidates/[candidateId]/jobs/[jobId]/quality-workflow/approve/route.ts (POST) via
 * a relative import from OUTSIDE the bracketed route directories — see tailoringRunsPatchRoute.test.ts's
 * doc comment for why (Node's test runner glob-matches `[...]` path segments as character classes).
 *
 * The safety authority (determineFinalDisposition/evaluateSafety) already has its own extensive unit
 * tests in stage28FastPipeline.test.ts; this file does not re-test that logic. It tests that THIS
 * endpoint reuses it correctly: refuses BLOCKED, refuses READY (no approval needed), accepts
 * SAFE_BEST_ATTEMPT, records the exact workflow/iteration, and is idempotent under a duplicate click.
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
let createResumeQualityIteration: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityIteration;
let getHumanApprovalForWorkflow: typeof import("@/db/queries/resumeQualityHumanApprovals").getHumanApprovalForWorkflow;
let INSTRUCTION_VERSION: string;
let INSTRUCTION_HASH: string;
let INSTRUCTION_COMPLIANCE_CHECK_NAMES: readonly (keyof InstructionComplianceChecks)[];
let POST: typeof import("../[candidateId]/jobs/[jobId]/quality-workflow/approve/route").POST;

let candidateId: number;
let companyId: number;
let hashCounter = 0;
let jobCounter = 0;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-approve-route-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-approve-route-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-approve-route-generated-"));
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
  ({ createResumeQualityWorkflow, transitionWorkflowStatus, createResumeQualityIteration } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ getHumanApprovalForWorkflow } = await import("@/db/queries/resumeQualityHumanApprovals"));
  ({ INSTRUCTION_VERSION, INSTRUCTION_HASH } = await import("@/lib/resumeQuality/canonicalInstructions"));
  ({ INSTRUCTION_COMPLIANCE_CHECK_NAMES } = await import("@/lib/resumeQuality/types"));
  ({ POST } = await import("../[candidateId]/jobs/[jobId]/quality-workflow/approve/route"));
  getDb();

  candidateId = createCandidate({ firstName: "Approve", lastName: "Route" }).id;
  companyId = createCompany({ name: "ApproveRouteCo", source_type: "greenhouse", ats_board_token: "approverouteco" }).id;

  fs.mkdirSync(path.join(tmpCandidatesDir, String(candidateId), "master"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpCandidatesDir, String(candidateId), "candidate-profile.json"),
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
    path.join(tmpCandidatesDir, String(candidateId), "master", "manifest.json"),
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

function nextHash(): string {
  hashCounter += 1;
  return `knowledge-hash-${hashCounter}`;
}

function fakeResult(overrides: Partial<JobMatchResult>): JobMatchResult {
  return {
    candidateId: 1,
    jobId: 1,
    dedupeKey: "x",
    matchEngineVersion: 2,
    matchKnowledgeHash: nextHash(),
    candidateProfileHash: "profile-hash",
    candidateSettingsHash: "settings-hash",
    jdContentHash: "jd-hash",
    computedAt: "2026-01-01T00:00:00Z",
    eligibility: { status: "PASS", reasons: [], sponsorship: { signal: "not_applicable", note: "n/a" } },
    dimensionScores: { roleAlignment: null, required: 90, preferred: 50, experience: 100, seniority: 100 },
    overallScore: 90,
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
    decision: "READY_FOR_TAILORING",
    blockingReasons: [],
    roleAlignmentDetail: null,
    ...overrides,
  };
}

function makeJob() {
  jobCounter += 1;
  const externalId = `ext-${jobCounter}`;
  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, externalId);
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId,
      title: `Senior Data Engineer ${jobCounter}`,
      location: null,
      department: null,
      url: `https://boards.greenhouse.io/approverouteco/${externalId}`,
      descriptionHtml: null,
      descriptionText: "desc",
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

function makeWorkflow(job: { id: number; dedupe_key: string }) {
  insertJobMatchResult(
    fakeResult({ candidateId, jobId: job.id, dedupeKey: job.dedupe_key, candidateProfileHash: `p-${nextHash()}`, decision: "READY_FOR_TAILORING" })
  );
  setMarkedForTailoring(candidateId, job.dedupe_key, true, { approvalType: "READY_DIRECT", decision: "READY_FOR_TAILORING" });
  const { run } = startTailoringRun({ candidateId, jobId: job.id });
  const applicationId = getCandidateJobState(candidateId, job.dedupe_key)!.id;
  const workflow = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: run.id, dedupeKey: run.dedupe_key });
  return workflow;
}

/** Real Resume.docx/CoverLetter.docx/review_feedback.md at the workflow's own iteration directory,
 *  via getIterationDirectory — exactly where publishSafeBestAttempt's source paths expect them. */
async function writeIterationArtifacts(workflow: { candidate_id: number; dedupe_key: string; tailoring_run_id: number; id: number }, iterationNumber: number) {
  const { getIterationDirectory } = await import("@/lib/resumeQuality/workspace");
  const dir = getIterationDirectory(
    { candidateId: workflow.candidate_id, dedupeKey: workflow.dedupe_key, runId: workflow.tailoring_run_id, workflowId: workflow.id },
    iterationNumber
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Resume.docx"), `resume-content-iter-${iterationNumber}`);
  fs.writeFileSync(path.join(dir, "CoverLetter.docx"), `cover-content-iter-${iterationNumber}`);
  fs.writeFileSync(path.join(dir, "review_feedback.md"), `feedback-iter-${iterationNumber}`);
}

function allChecks(status: ComplianceStatus): InstructionComplianceChecks {
  const checks = {} as InstructionComplianceChecks;
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) checks[name] = status;
  return checks;
}

function review(overrides: Partial<StructuredResumeReview> = {}): StructuredResumeReview {
  return {
    overallScore: 78,
    atsScore: 78,
    keywordAlignmentScore: 78,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 78,
    formattingScore: 100,
    missingRequiredSkills: [],
    incorrectTechnologyUsage: [],
    genericBullets: [],
    missingImpactEvidence: [],
    summaryIssues: [],
    skillsOrderingIssues: [],
    truthfulnessIssues: [],
    blockingIssues: [],
    requiredCorrections: [],
    blockingFailures: [],
    recruiterQualityAssessment: { status: "REVIEW", score: 40, issues: [] },
    instructionCompliance: {
      instructionVersion: INSTRUCTION_VERSION,
      instructionHash: INSTRUCTION_HASH,
      checks: { ...allChecks("PASS"), bulletWriting: "FAIL", finalValidation: "FAIL" },
      notes: [],
    },
    ...overrides,
  } as StructuredResumeReview;
}

async function seedIteration(workflow: { candidate_id: number; id: number }, iterationNumber: number, r: StructuredResumeReview) {
  createResumeQualityIteration(workflow.candidate_id, workflow.id, iterationNumber, {
    outputFiles: ["Resume.docx", "CoverLetter.docx", "review.json", "review_feedback.md"],
    overallScore: r.overallScore,
    atsScore: r.atsScore,
    keywordAlignmentScore: r.keywordAlignmentScore,
    truthfulnessScore: r.truthfulnessScore,
    architectureConsistencyScore: r.architectureConsistencyScore,
    recruiterReadabilityScore: r.recruiterReadabilityScore,
    formattingScore: r.formattingScore,
    blockingIssueCount: r.blockingIssues.length,
    reviewJson: JSON.stringify(r),
  });
}

function post(candidateId: number, jobId: number, body: unknown = {}) {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ candidateId: String(candidateId), jobId: String(jobId) }) });
}

test("item 1: a genuinely SAFE_BEST_ATTEMPT workflow can be approved", async () => {
  const job = makeJob();
  const workflow = makeWorkflow(job);
  transitionWorkflowStatus(candidateId, workflow.id, "FAILED", { failureReason: "gate not satisfied" });
  await writeIterationArtifacts(workflow, 1);
  await seedIteration(workflow, 1, review({ overallScore: 78 }));

  const res = await post(candidateId, job.id);
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.ok, true);
  assert.equal(json.disposition, "SAFE_BEST_ATTEMPT");
  assert.equal(json.approval.selectedIterationNumber, 1);

  const stored = getHumanApprovalForWorkflow(candidateId, workflow.id);
  assert.ok(stored);
  assert.equal(stored!.truthfulness_score, 100);
});

test("item 2/3/4/5: approval refused when truthfulness/blocking/compliance make the disposition BLOCKED", async () => {
  const job = makeJob();
  const workflow = makeWorkflow(job);
  transitionWorkflowStatus(candidateId, workflow.id, "FAILED", { failureReason: "gate not satisfied" });
  await writeIterationArtifacts(workflow, 1);
  await seedIteration(
    workflow,
    1,
    review({
      overallScore: 80,
      truthfulnessScore: 60, // <-- the safety violation
      blockingIssues: ["Fabricated metric on Resume"],
      blockingFailures: [{ type: "UNSUPPORTED_CLAIM", description: "invented", evidenceSearched: [] }],
    })
  );

  const res = await post(candidateId, job.id);
  const json = await res.json();
  assert.equal(res.status, 403);
  assert.equal(json.code, "BLOCKED");
  assert.ok(Array.isArray(json.blockers) && json.blockers.length > 0);
  assert.equal(getHumanApprovalForWorkflow(candidateId, workflow.id), undefined, "a BLOCKED disposition must never be recorded as approved");
});

test("item 6: BLOCKED disposition (hard-gate compliance FAIL on a truthfulness check) cannot be approved", async () => {
  const job = makeJob();
  const workflow = makeWorkflow(job);
  transitionWorkflowStatus(candidateId, workflow.id, "FAILED", { failureReason: "gate not satisfied" });
  await writeIterationArtifacts(workflow, 1);
  await seedIteration(
    workflow,
    1,
    review({
      instructionCompliance: {
        instructionVersion: INSTRUCTION_VERSION,
        instructionHash: INSTRUCTION_HASH,
        checks: { ...allChecks("PASS"), noContradictingTechnologies: "FAIL" },
        notes: [],
      },
    })
  );

  const res = await post(candidateId, job.id);
  const json = await res.json();
  assert.equal(res.status, 403);
  assert.equal(json.code, "BLOCKED");
});

test("item 7: an autonomous READY workflow needs no approval and the endpoint refuses to create one", async () => {
  const job = makeJob();
  const workflow = makeWorkflow(job);
  transitionWorkflowStatus(candidateId, workflow.id, "WRITER_RUNNING");
  transitionWorkflowStatus(candidateId, workflow.id, "WRITER_COMPLETED");
  transitionWorkflowStatus(candidateId, workflow.id, "REVIEW_RUNNING");
  transitionWorkflowStatus(candidateId, workflow.id, "REVIEW_COMPLETED");
  transitionWorkflowStatus(candidateId, workflow.id, "READY", { finalApprovedIteration: 1, latestOverallScore: 96 });

  const res = await post(candidateId, job.id);
  const json = await res.json();
  assert.equal(res.status, 409);
  assert.equal(json.code, "ALREADY_READY");
});

test("a workflow still in progress cannot be approved", async () => {
  const job = makeJob();
  const workflow = makeWorkflow(job);
  transitionWorkflowStatus(candidateId, workflow.id, "WRITER_RUNNING");

  const res = await post(candidateId, job.id);
  const json = await res.json();
  assert.equal(res.status, 409);
  assert.equal(json.code, "NOT_TERMINAL");
});

test("item 13: a duplicate approval click is idempotent — no second row, same timestamp", async () => {
  const job = makeJob();
  const workflow = makeWorkflow(job);
  transitionWorkflowStatus(candidateId, workflow.id, "FAILED", { failureReason: "gate not satisfied" });
  await writeIterationArtifacts(workflow, 1);
  await seedIteration(workflow, 1, review({ overallScore: 78 }));

  const first = await (await post(candidateId, job.id)).json();
  const second = await (await post(candidateId, job.id)).json();

  assert.equal(first.approval.id, second.approval.id);
  assert.equal(second.alreadyApproved, true);
});

test("stale workflowId sent by the client is refused rather than silently approving the current one", async () => {
  const job = makeJob();
  const workflow = makeWorkflow(job);
  transitionWorkflowStatus(candidateId, workflow.id, "FAILED", { failureReason: "gate not satisfied" });
  await writeIterationArtifacts(workflow, 1);
  await seedIteration(workflow, 1, review({ overallScore: 78 }));

  const res = await post(candidateId, job.id, { workflowId: workflow.id + 999999 });
  const json = await res.json();
  assert.equal(res.status, 409);
  assert.equal(json.code, "STALE_WORKFLOW");
  assert.equal(getHumanApprovalForWorkflow(candidateId, workflow.id), undefined);
});
