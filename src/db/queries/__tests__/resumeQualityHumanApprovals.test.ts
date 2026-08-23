import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { JobMatchResult } from "@/lib/match/types";

/**
 * Query-layer tests for resume_quality_human_approvals — the auditable, workflow-scoped human
 * approval record for a SAFE_BEST_ATTEMPT resume. Isolated temp DB/candidates/generated dirs, no
 * network, no filesystem outside the temp roots.
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
let createResumeQualityWorkflow: typeof import("../resumeQualityWorkflows").createResumeQualityWorkflow;
let transitionWorkflowStatus: typeof import("../resumeQualityWorkflows").transitionWorkflowStatus;
let saveHumanApproval: typeof import("../resumeQualityHumanApprovals").saveHumanApproval;
let getHumanApprovalForWorkflow: typeof import("../resumeQualityHumanApprovals").getHumanApprovalForWorkflow;
let listHumanApprovalsForJob: typeof import("../resumeQualityHumanApprovals").listHumanApprovalsForJob;

let candidateId: number;
let companyId: number;
let job: { id: number; dedupe_key: string };
let hashCounter = 0;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-human-approvals-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-human-approvals-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-human-approvals-generated-"));
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
  ({ createResumeQualityWorkflow, transitionWorkflowStatus } = await import("../resumeQualityWorkflows"));
  ({ saveHumanApproval, getHumanApprovalForWorkflow, listHumanApprovalsForJob } = await import("../resumeQualityHumanApprovals"));
  getDb();

  candidateId = createCandidate({ firstName: "Approval", lastName: "Tester" }).id;
  companyId = createCompany({ name: "ApprovalTestCo", source_type: "greenhouse", ats_board_token: "approvaltestco" }).id;

  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, "ext-1");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "ext-1",
      title: "Senior Data Engineer",
      location: null,
      department: null,
      url: "https://boards.greenhouse.io/approvaltestco/ext-1",
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
  job = getJobByDedupeKey(dedupeKey)!;

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

/** Creates a fresh workflow in status FAILED (a legal direct CREATED->FAILED transition), the only
 *  precondition saveHumanApproval's callers ever require. */
function makeFailedWorkflow() {
  insertJobMatchResult(
    fakeResult({ candidateId, jobId: job.id, dedupeKey: job.dedupe_key, candidateProfileHash: `p-${nextHash()}`, decision: "READY_FOR_TAILORING" })
  );
  setMarkedForTailoring(candidateId, job.dedupe_key, true, { approvalType: "READY_DIRECT", decision: "READY_FOR_TAILORING" });
  const { run } = startTailoringRun({ candidateId, jobId: job.id });
  const applicationId = getCandidateJobState(candidateId, job.dedupe_key)!.id;
  const workflow = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: run.id, dedupeKey: run.dedupe_key });
  transitionWorkflowStatus(candidateId, workflow.id, "FAILED", { failureReason: "test fixture" });
  return { workflow, tailoringRunId: run.id };
}

test("getHumanApprovalForWorkflow returns undefined when no approval has been recorded", () => {
  const { workflow } = makeFailedWorkflow();
  assert.equal(getHumanApprovalForWorkflow(candidateId, workflow.id), undefined);
});

test("saveHumanApproval records an approval tied to the exact workflow and selected iteration", () => {
  const { workflow, tailoringRunId } = makeFailedWorkflow();
  const saved = saveHumanApproval({
    candidateId,
    workflowId: workflow.id,
    tailoringRunId,
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    selectedIterationNumber: 2,
    overallScore: 78,
    atsScore: 80,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    instructionVersion: "2026-08-22b",
    instructionHash: "abc123",
    safetyVerdict: { safe: true, blockers: [] },
  });
  assert.equal(saved.workflow_id, workflow.id);
  assert.equal(saved.selected_iteration_number, 2);
  assert.equal(saved.truthfulness_score, 100);
  assert.equal(JSON.parse(saved.safety_verdict_json).safe, true);

  const fetched = getHumanApprovalForWorkflow(candidateId, workflow.id);
  assert.ok(fetched);
  assert.equal(fetched!.id, saved.id);
});

test("saveHumanApproval is idempotent — a repeated call for the same workflow returns the original row, never a duplicate", () => {
  const { workflow, tailoringRunId } = makeFailedWorkflow();
  const first = saveHumanApproval({
    candidateId,
    workflowId: workflow.id,
    tailoringRunId,
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    selectedIterationNumber: 1,
    overallScore: 80,
    atsScore: 80,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    instructionVersion: "v1",
    instructionHash: "h1",
    safetyVerdict: { safe: true, blockers: [] },
  });
  const second = saveHumanApproval({
    candidateId,
    workflowId: workflow.id,
    tailoringRunId,
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    selectedIterationNumber: 1,
    overallScore: 999, // deliberately different — must NOT overwrite the first record
    atsScore: 999,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    instructionVersion: "v2",
    instructionHash: "h2",
    safetyVerdict: { safe: true, blockers: [] },
  });
  assert.equal(second.id, first.id);
  assert.equal(second.overall_score, 80, "the second call's different score must never overwrite the first approval");
  assert.equal(second.approved_at, first.approved_at);

  const all = listHumanApprovalsForJob(candidateId, job.dedupe_key).filter((r) => r.workflow_id === workflow.id);
  assert.equal(all.length, 1, "a duplicate click must never create a second row for the same workflow");
});

test("a newer workflow for the same job has no approval, even after an older workflow was approved", () => {
  const older = makeFailedWorkflow();
  saveHumanApproval({
    candidateId,
    workflowId: older.workflow.id,
    tailoringRunId: older.tailoringRunId,
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    selectedIterationNumber: 1,
    overallScore: 80,
    atsScore: 80,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    instructionVersion: "v1",
    instructionHash: "h1",
    safetyVerdict: { safe: true, blockers: [] },
  });

  const newer = makeFailedWorkflow();
  assert.notEqual(newer.workflow.id, older.workflow.id);
  assert.equal(
    getHumanApprovalForWorkflow(candidateId, newer.workflow.id),
    undefined,
    "a newer, re-tailored workflow must never inherit an older workflow's approval"
  );
  // The older approval is untouched, still queryable — an audit trail, not overwritten or deleted.
  assert.ok(getHumanApprovalForWorkflow(candidateId, older.workflow.id));
});

test("listHumanApprovalsForJob returns every approval for the job, newest first", () => {
  const a = makeFailedWorkflow();
  const b = makeFailedWorkflow();
  saveHumanApproval({
    candidateId,
    workflowId: a.workflow.id,
    tailoringRunId: a.tailoringRunId,
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    selectedIterationNumber: 1,
    overallScore: 80,
    atsScore: 80,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    instructionVersion: "v1",
    instructionHash: "h1",
    safetyVerdict: { safe: true, blockers: [] },
  });
  saveHumanApproval({
    candidateId,
    workflowId: b.workflow.id,
    tailoringRunId: b.tailoringRunId,
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    selectedIterationNumber: 1,
    overallScore: 85,
    atsScore: 85,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    instructionVersion: "v1",
    instructionHash: "h1",
    safetyVerdict: { safe: true, blockers: [] },
  });
  const list = listHumanApprovalsForJob(candidateId, job.dedupe_key);
  const workflowIds = list.map((r) => r.workflow_id);
  assert.ok(workflowIds.includes(a.workflow.id));
  assert.ok(workflowIds.includes(b.workflow.id));
  assert.ok(list[0].id >= list[list.length - 1].id, "newest-first ordering");
});
