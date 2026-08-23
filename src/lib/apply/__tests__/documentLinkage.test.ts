import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { JobMatchResult } from "@/lib/match/types";

/**
 * resolveApplicationDocuments (documentLinkage.ts) — the sole gate on which resume an application run
 * may upload. Covers CASE A (autonomous READY, via the fixed publication-tree lookup) and CASE B
 * (a human-approved SAFE_BEST_ATTEMPT, tied to the exact workflow/iteration approved). Isolated temp
 * DB/candidates/generated dirs, real filesystem writes via the real publication helpers — no network,
 * no Claude, no mocking of the safety authorities.
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;
let tmpGeneratedDir: string;

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
let saveHumanApproval: typeof import("@/db/queries/resumeQualityHumanApprovals").saveHumanApproval;
let publishFinalApplicationArtifacts: typeof import("@/lib/resumeQuality/finalPublication").publishFinalApplicationArtifacts;
let publishSafeBestAttempt: typeof import("@/lib/resumeQuality/safeAttemptPublication").publishSafeBestAttempt;
let SafeAttemptPublicationError: typeof import("@/lib/resumeQuality/safeAttemptPublication").SafeAttemptPublicationError;
let resolveApplicationDocuments: typeof import("../documentLinkage").resolveApplicationDocuments;

let candidateId: number;
let companyId: number;
let hashCounter = 0;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-doc-linkage-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-doc-linkage-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-doc-linkage-generated-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  const { getDb } = await import("@/db/index");
  ({ createCandidate, getCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany, getCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ setMarkedForTailoring, getCandidateJobState } = await import("@/db/queries/candidateJobState"));
  ({ startTailoringRun } = await import("@/lib/tailoringExecution"));
  ({ createResumeQualityWorkflow, transitionWorkflowStatus } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ saveHumanApproval } = await import("@/db/queries/resumeQualityHumanApprovals"));
  ({ publishFinalApplicationArtifacts } = await import("@/lib/resumeQuality/finalPublication"));
  ({ publishSafeBestAttempt, SafeAttemptPublicationError } = await import("@/lib/resumeQuality/safeAttemptPublication"));
  ({ resolveApplicationDocuments } = await import("../documentLinkage"));
  getDb();

  candidateId = createCandidate({ firstName: "Doc", lastName: "Linkage" }).id;
  companyId = createCompany({ name: "DocLinkageCo", source_type: "greenhouse", ats_board_token: "doclinkageco" }).id;

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

let jobCounter = 0;
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
      url: `https://boards.greenhouse.io/doclinkageco/${externalId}`,
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
  return { workflow, applicationId, tailoringRunId: run.id };
}

function makeSourceDocs(content: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-doc-linkage-src-"));
  const resumePath = path.join(dir, "Resume.docx");
  const coverPath = path.join(dir, "CoverLetter.docx");
  const feedbackPath = path.join(dir, "review_feedback.md");
  fs.writeFileSync(resumePath, content);
  fs.writeFileSync(coverPath, `cover:${content}`);
  fs.writeFileSync(feedbackPath, `feedback:${content}`);
  return { dir, resumePath, coverPath, feedbackPath };
}

test("no workflow at all: not ready, no crash", () => {
  const job = makeJob();
  const result = resolveApplicationDocuments({ candidateId, dedupeKey: job.dedupe_key, jobId: job.id, companyName: null });
  assert.equal(result.ready, false);
});

test("CASE A: autonomous READY workflow is application-eligible with no human approval required", () => {
  const job = makeJob();
  const { workflow } = makeWorkflow(job);
  transitionWorkflowStatus(candidateId, workflow.id, "WRITER_RUNNING");
  transitionWorkflowStatus(candidateId, workflow.id, "WRITER_COMPLETED");
  transitionWorkflowStatus(candidateId, workflow.id, "REVIEW_RUNNING");
  transitionWorkflowStatus(candidateId, workflow.id, "REVIEW_COMPLETED");
  transitionWorkflowStatus(candidateId, workflow.id, "READY", { finalApprovedIteration: 1, latestOverallScore: 96 });

  const candidate = getCandidate(candidateId)!;
  const company = getCompany(companyId)!;
  const src = makeSourceDocs("ready-content");
  publishFinalApplicationArtifacts({
    candidateId,
    candidateFirstName: candidate.first_name || "Candidate",
    companyId: company.id,
    companyName: company.name,
    jobId: job.id,
    jobTitle: job.title,
    dedupeKey: job.dedupe_key,
    applicationId: (getCandidateJobState(candidateId, job.dedupe_key) ?? { id: 0 }).id,
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

  const result = resolveApplicationDocuments({ candidateId, dedupeKey: job.dedupe_key, jobId: job.id, companyName: company.name });
  assert.equal(result.ready, true);
  if (result.ready) {
    assert.equal(result.source, "AUTONOMOUS_READY");
    assert.equal(result.workflowId, workflow.id);
    assert.equal(fs.readFileSync(result.resumePath, "utf-8"), "ready-content");
  }
});

test("CASE B setup: a FAILED workflow with a published safe-attempt package but NO approval remains ineligible (item 9)", () => {
  const job = makeJob();
  const { workflow, tailoringRunId } = makeWorkflow(job);
  transitionWorkflowStatus(candidateId, workflow.id, "FAILED", { failureReason: "gate not satisfied" });

  const candidate = getCandidate(candidateId)!;
  const company = getCompany(companyId)!;
  const src = makeSourceDocs("safe-attempt-content");
  publishSafeBestAttempt({
    disposition: { disposition: "SAFE_BEST_ATTEMPT", selectedIterationNumber: 2, selectionReason: "best of exhausted attempts", safety: { safe: true, blockers: [] }, optimizationScore: 78, optimizationFindings: [], humanMaySend: true },
    candidateId,
    candidateName: candidate.display_name,
    candidateFirstName: candidate.first_name || "Candidate",
    companyId: company.id,
    companyName: company.name,
    jobId: job.id,
    jobTitle: job.title,
    workflowId: workflow.id,
    tailoringRunId,
    sourceResumePath: src.resumePath,
    sourceCoverLetterPath: src.coverPath,
    sourceReviewFeedbackPath: src.feedbackPath,
  });

  const result = resolveApplicationDocuments({ candidateId, dedupeKey: job.dedupe_key, jobId: job.id, companyName: company.name });
  assert.equal(result.ready, false, "an unapproved SAFE_BEST_ATTEMPT must remain ineligible");
});

test("CASE B: an approved SAFE_BEST_ATTEMPT becomes application-eligible, linked to the exact approved iteration (items 8, 14)", () => {
  const job = makeJob();
  const { workflow, tailoringRunId } = makeWorkflow(job);
  transitionWorkflowStatus(candidateId, workflow.id, "FAILED", { failureReason: "gate not satisfied" });

  const candidate = getCandidate(candidateId)!;
  const company = getCompany(companyId)!;
  const src = makeSourceDocs("approved-iteration-2-content");
  const disposition = {
    disposition: "SAFE_BEST_ATTEMPT" as const,
    selectedIterationNumber: 2,
    selectionReason: "best of exhausted attempts",
    safety: { safe: true, blockers: [] },
    optimizationScore: 78,
    optimizationFindings: [],
    humanMaySend: true,
  };
  publishSafeBestAttempt({
    disposition,
    candidateId,
    candidateName: candidate.display_name,
    candidateFirstName: candidate.first_name || "Candidate",
    companyId: company.id,
    companyName: company.name,
    jobId: job.id,
    jobTitle: job.title,
    workflowId: workflow.id,
    tailoringRunId,
    sourceResumePath: src.resumePath,
    sourceCoverLetterPath: src.coverPath,
    sourceReviewFeedbackPath: src.feedbackPath,
  });

  saveHumanApproval({
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
    instructionVersion: "v1",
    instructionHash: "h1",
    safetyVerdict: disposition.safety,
  });

  const result = resolveApplicationDocuments({ candidateId, dedupeKey: job.dedupe_key, jobId: job.id, companyName: company.name });
  assert.equal(result.ready, true);
  if (result.ready) {
    assert.equal(result.source, "HUMAN_APPROVED_SAFE_ATTEMPT");
    assert.equal(result.workflowId, workflow.id);
    assert.equal(fs.readFileSync(result.resumePath, "utf-8"), "approved-iteration-2-content", "must link to the exact approved iteration's artifact, not any other");
  }
});

test("a plain unrelated FAILED workflow with no safe-attempt publication at all remains ineligible (item 10)", () => {
  const job = makeJob();
  const { workflow } = makeWorkflow(job);
  transitionWorkflowStatus(candidateId, workflow.id, "FAILED", { failureReason: "blocked, no safe attempt" });

  const result = resolveApplicationDocuments({ candidateId, dedupeKey: job.dedupe_key, jobId: job.id, companyName: "DocLinkageCo" });
  assert.equal(result.ready, false);
});

test("an old workflow's approval does not approve a newer workflow for the same job (items 11, 12)", () => {
  const job = makeJob();
  const candidate = getCandidate(candidateId)!;
  const company = getCompany(companyId)!;

  // Older workflow: approved.
  const older = makeWorkflow(job);
  transitionWorkflowStatus(candidateId, older.workflow.id, "FAILED", { failureReason: "gate not satisfied" });
  const srcOld = makeSourceDocs("older-approved-content");
  const dispositionOld = {
    disposition: "SAFE_BEST_ATTEMPT" as const,
    selectedIterationNumber: 1,
    selectionReason: "best available",
    safety: { safe: true, blockers: [] },
    optimizationScore: 75,
    optimizationFindings: [],
    humanMaySend: true,
  };
  publishSafeBestAttempt({
    disposition: dispositionOld,
    candidateId,
    candidateName: candidate.display_name,
    candidateFirstName: candidate.first_name || "Candidate",
    companyId: company.id,
    companyName: company.name,
    jobId: job.id,
    jobTitle: job.title,
    workflowId: older.workflow.id,
    tailoringRunId: older.tailoringRunId,
    sourceResumePath: srcOld.resumePath,
    sourceCoverLetterPath: srcOld.coverPath,
    sourceReviewFeedbackPath: srcOld.feedbackPath,
  });
  saveHumanApproval({
    candidateId,
    workflowId: older.workflow.id,
    tailoringRunId: older.tailoringRunId,
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    selectedIterationNumber: 1,
    overallScore: 75,
    atsScore: 75,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    instructionVersion: "v1",
    instructionHash: "h1",
    safetyVerdict: dispositionOld.safety,
  });

  // Sanity: while `older` is the latest workflow, its approval DOES make the job eligible.
  const beforeRetry = resolveApplicationDocuments({ candidateId, dedupeKey: job.dedupe_key, jobId: job.id, companyName: company.name });
  assert.equal(beforeRetry.ready, true);

  // Re-tailor: a brand-new workflow for the SAME job, unapproved. This also reaches SAFE_BEST_ATTEMPT
  // and republishes the SHARED human-review/ directory with its own (different) content.
  const newer = makeWorkflow(job);
  transitionWorkflowStatus(candidateId, newer.workflow.id, "FAILED", { failureReason: "gate not satisfied again" });
  const srcNew = makeSourceDocs("newer-unapproved-content");
  const dispositionNew = {
    disposition: "SAFE_BEST_ATTEMPT" as const,
    selectedIterationNumber: 1,
    selectionReason: "best available",
    safety: { safe: true, blockers: [] },
    optimizationScore: 80,
    optimizationFindings: [],
    humanMaySend: true,
  };
  publishSafeBestAttempt({
    disposition: dispositionNew,
    candidateId,
    candidateName: candidate.display_name,
    candidateFirstName: candidate.first_name || "Candidate",
    companyId: company.id,
    companyName: company.name,
    jobId: job.id,
    jobTitle: job.title,
    workflowId: newer.workflow.id,
    tailoringRunId: newer.tailoringRunId,
    sourceResumePath: srcNew.resumePath,
    sourceCoverLetterPath: srcNew.coverPath,
    sourceReviewFeedbackPath: srcNew.feedbackPath,
  });

  const afterRetry = resolveApplicationDocuments({ candidateId, dedupeKey: job.dedupe_key, jobId: job.id, companyName: company.name });
  assert.equal(afterRetry.ready, false, "the newer, unapproved workflow must NOT inherit the older workflow's approval");

  // The older approval row itself is untouched (audit trail preserved).
  assert.notEqual(older.workflow.id, newer.workflow.id);
});

test("missing approved artifact on disk prevents application even with a valid approval row (item 15)", () => {
  const job = makeJob();
  const { workflow, tailoringRunId } = makeWorkflow(job);
  transitionWorkflowStatus(candidateId, workflow.id, "FAILED", { failureReason: "gate not satisfied" });

  const candidate = getCandidate(candidateId)!;
  const company = getCompany(companyId)!;
  const src = makeSourceDocs("will-be-deleted");
  const disposition = {
    disposition: "SAFE_BEST_ATTEMPT" as const,
    selectedIterationNumber: 1,
    selectionReason: "best available",
    safety: { safe: true, blockers: [] },
    optimizationScore: 78,
    optimizationFindings: [],
    humanMaySend: true,
  };
  const published = publishSafeBestAttempt({
    disposition,
    candidateId,
    candidateName: candidate.display_name,
    candidateFirstName: candidate.first_name || "Candidate",
    companyId: company.id,
    companyName: company.name,
    jobId: job.id,
    jobTitle: job.title,
    workflowId: workflow.id,
    tailoringRunId,
    sourceResumePath: src.resumePath,
    sourceCoverLetterPath: src.coverPath,
    sourceReviewFeedbackPath: src.feedbackPath,
  });
  saveHumanApproval({
    candidateId,
    workflowId: workflow.id,
    tailoringRunId,
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    selectedIterationNumber: 1,
    overallScore: 78,
    atsScore: 78,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    instructionVersion: "v1",
    instructionHash: "h1",
    safetyVerdict: disposition.safety,
  });

  // Simulate the published resume disappearing from disk after approval.
  fs.rmSync(published.resumePath);

  const result = resolveApplicationDocuments({ candidateId, dedupeKey: job.dedupe_key, jobId: job.id, companyName: company.name });
  assert.equal(result.ready, false, "a missing artifact must block the application even though the approval row exists");
});

test("publishSafeBestAttempt (the promotion helper) refuses a non-SAFE_BEST_ATTEMPT disposition — an unsafe/blocked attempt can never be promoted (item 16)", () => {
  const job = makeJob();
  const { workflow, tailoringRunId } = makeWorkflow(job);
  const candidate = getCandidate(candidateId)!;
  const company = getCompany(companyId)!;
  const src = makeSourceDocs("blocked-content");

  assert.throws(
    () =>
      publishSafeBestAttempt({
        disposition: {
          disposition: "BLOCKED",
          selectedIterationNumber: 1,
          selectionReason: null,
          safety: { safe: false, blockers: ["Truthfulness score is 60, not 100."] },
          optimizationScore: 40,
          optimizationFindings: [],
          humanMaySend: false,
        },
        candidateId,
        candidateName: candidate.display_name,
        candidateFirstName: candidate.first_name || "Candidate",
        companyId: company.id,
        companyName: company.name,
        jobId: job.id,
        jobTitle: job.title,
        workflowId: workflow.id,
        tailoringRunId,
        sourceResumePath: src.resumePath,
        sourceCoverLetterPath: src.coverPath,
        sourceReviewFeedbackPath: src.feedbackPath,
      }),
    (err: unknown) => err instanceof SafeAttemptPublicationError && err.code === "NOT_SAFE_BEST_ATTEMPT"
  );
});
