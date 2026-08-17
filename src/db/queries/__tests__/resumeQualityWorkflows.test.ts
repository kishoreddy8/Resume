import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { JobMatchResult } from "@/lib/match/types";

/**
 * Phase 3 Stage 7 — resume_quality_workflows/resume_quality_iterations query-layer tests. Uses the
 * REAL Stage 5 startTailoringRun() to obtain a genuine tailoring_run_id/application_id pair (rather
 * than fabricating fake foreign keys), which doubles as a light regression check that Stage 4/5/6's
 * existing behavior is untouched by Stage 7. Isolated temp DB/candidates/generated dirs, no network.
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
let getResumeQualityWorkflow: typeof import("../resumeQualityWorkflows").getResumeQualityWorkflow;
let listResumeQualityWorkflowsForRun: typeof import("../resumeQualityWorkflows").listResumeQualityWorkflowsForRun;
let transitionWorkflowStatus: typeof import("../resumeQualityWorkflows").transitionWorkflowStatus;
let createResumeQualityIteration: typeof import("../resumeQualityWorkflows").createResumeQualityIteration;
let getResumeQualityIteration: typeof import("../resumeQualityWorkflows").getResumeQualityIteration;
let listResumeQualityIterations: typeof import("../resumeQualityWorkflows").listResumeQualityIterations;
let IterationAlreadyExistsError: typeof import("../resumeQualityWorkflows").IterationAlreadyExistsError;
let IterationOutOfSequenceError: typeof import("../resumeQualityWorkflows").IterationOutOfSequenceError;
let IterationExceedsMaxError: typeof import("../resumeQualityWorkflows").IterationExceedsMaxError;
let InvalidWorkflowTransitionError: typeof import("@/lib/resumeQuality/stateMachine").InvalidWorkflowTransitionError;
let DEFAULT_MAX_ITERATIONS: number;

let candidateAId: number;
let candidateBId: number;
let companyId: number;
let jobOne: { id: number; dedupe_key: string };
let jobTwo: { id: number; dedupe_key: string };
let hashCounter = 0;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-quality-workflows-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-quality-workflows-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-quality-workflows-generated-"));
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
    getResumeQualityWorkflow,
    listResumeQualityWorkflowsForRun,
    transitionWorkflowStatus,
    createResumeQualityIteration,
    getResumeQualityIteration,
    listResumeQualityIterations,
    IterationAlreadyExistsError,
    IterationOutOfSequenceError,
    IterationExceedsMaxError,
  } = await import("../resumeQualityWorkflows"));
  ({ InvalidWorkflowTransitionError } = await import("@/lib/resumeQuality/stateMachine"));
  ({ DEFAULT_MAX_ITERATIONS } = await import("@/lib/resumeQuality/types"));
  getDb();

  candidateAId = createCandidate({ firstName: "Candidate", lastName: "A" }).id;
  candidateBId = createCandidate({ firstName: "Candidate", lastName: "B" }).id;
  companyId = createCompany({ name: "QualityTestCo", source_type: "greenhouse", ats_board_token: "qualitytestco" }).id;

  function seedJob(externalId: string, title: string) {
    const dedupeKey = dedupeKeyForAts("greenhouse", companyId, externalId);
    upsertJob({
      companyId,
      sourceType: "greenhouse",
      dedupeKey,
      job: {
        externalId,
        title,
        location: null,
        department: null,
        url: `https://boards.greenhouse.io/qualitytestco/${externalId}`,
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

  jobOne = seedJob("ext-1", "Senior Data Engineer");
  jobTwo = seedJob("ext-2", "Staff Data Engineer");
});

after(() => {
  fs.rmSync(tmpDbDir, { recursive: true, force: true });
  fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  fs.rmSync(tmpGeneratedDir, { recursive: true, force: true });
  delete process.env.CAREER_OPS_CANDIDATES_DIR;
  delete process.env.CAREER_OPS_GENERATED_DIR;
});

function writeProfile(candidateId: number, resumeHash: string, skillsHash: string) {
  const dir = path.join(tmpCandidatesDir, String(candidateId));
  const masterDir = path.join(dir, "master");
  fs.mkdirSync(masterDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: resumeHash, skills: skillsHash },
      builtAt: "2026-01-01T00:00:00Z",
      skills: [],
      experience: [],
      education: [],
      certifications: [],
      totalYearsExperience: null,
    })
  );
  fs.writeFileSync(
    path.join(masterDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: resumeHash },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: skillsHash },
    })
  );
}

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

/** Approves + starts a real Stage 5 tailoring run (exercising existing, untouched Stage 3/5 code),
 *  and returns the application_id (candidate_job_state.id) alongside it — this IS the "application
 *  identity" Stage 7 reuses rather than inventing a new concept. */
function startRealRun(candidateId: number, job: { id: number; dedupe_key: string }) {
  writeProfile(candidateId, `resume-${candidateId}-${job.id}`, `skills-${candidateId}-${job.id}`);
  insertJobMatchResult(
    fakeResult({
      candidateId,
      jobId: job.id,
      dedupeKey: job.dedupe_key,
      candidateProfileHash: `resume-${candidateId}-${job.id}:skills-${candidateId}-${job.id}`,
      decision: "READY_FOR_TAILORING",
    })
  );
  setMarkedForTailoring(candidateId, job.dedupe_key, true, { approvalType: "READY_DIRECT", decision: "READY_FOR_TAILORING" });
  const { run } = startTailoringRun({ candidateId, jobId: job.id });
  const applicationId = getCandidateJobState(candidateId, job.dedupe_key)!.id;
  return { run, applicationId };
}

test("application identity: resume_quality_workflows.application_id equals the real candidate_job_state.id — not a new concept", () => {
  const { run, applicationId } = startRealRun(candidateAId, jobOne);
  const workflow = createResumeQualityWorkflow({
    candidateId: candidateAId,
    applicationId,
    tailoringRunId: run.id,
    dedupeKey: run.dedupe_key,
  });
  assert.equal(workflow.application_id, applicationId);
  const actualRow = getCandidateJobState(candidateAId, jobOne.dedupe_key)!;
  assert.equal(workflow.application_id, actualRow.id, "application_id must be the SAME row id as the real candidate_job_state entry, not a fabricated identity");
});

test("application identity is stable across repeated lookups (same candidate+job always resolves to the same application_id)", () => {
  const idFirst = getCandidateJobState(candidateAId, jobOne.dedupe_key)!.id;
  const idSecond = getCandidateJobState(candidateAId, jobOne.dedupe_key)!.id;
  assert.equal(idFirst, idSecond);
});

test("maxIterations defaults to 3 when not specified", () => {
  const { run, applicationId } = startRealRun(candidateAId, jobOne);
  const workflow = createResumeQualityWorkflow({ candidateId: candidateAId, applicationId, tailoringRunId: run.id, dedupeKey: run.dedupe_key });
  assert.equal(workflow.max_iterations, DEFAULT_MAX_ITERATIONS);
  assert.equal(workflow.max_iterations, 3);
});

test("createResumeQualityWorkflow starts a workflow in status CREATED with current_iteration 0", () => {
  const { run, applicationId } = startRealRun(candidateAId, jobOne);
  const workflow = createResumeQualityWorkflow({ candidateId: candidateAId, applicationId, tailoringRunId: run.id, dedupeKey: run.dedupe_key });
  assert.equal(workflow.status, "CREATED");
  assert.equal(workflow.current_iteration, 0);
});

test("candidate isolation: candidate A cannot retrieve candidate B's workflow", () => {
  const { run: runA, applicationId: appA } = startRealRun(candidateAId, jobOne);
  const { run: runB, applicationId: appB } = startRealRun(candidateBId, jobOne);
  const workflowA = createResumeQualityWorkflow({ candidateId: candidateAId, applicationId: appA, tailoringRunId: runA.id, dedupeKey: runA.dedupe_key });
  const workflowB = createResumeQualityWorkflow({ candidateId: candidateBId, applicationId: appB, tailoringRunId: runB.id, dedupeKey: runB.dedupe_key });

  assert.ok(getResumeQualityWorkflow(candidateAId, workflowA.id));
  assert.equal(getResumeQualityWorkflow(candidateAId, workflowB.id), undefined, "candidate A must not be able to read candidate B's workflow by id");
});

test("run/workflow isolation: two different tailoring runs never share a workflow list", () => {
  const { run: run1, applicationId: app1 } = startRealRun(candidateAId, jobOne);
  const { run: run2, applicationId: app2 } = startRealRun(candidateAId, jobTwo);
  const workflow1 = createResumeQualityWorkflow({ candidateId: candidateAId, applicationId: app1, tailoringRunId: run1.id, dedupeKey: run1.dedupe_key });
  const workflow2 = createResumeQualityWorkflow({ candidateId: candidateAId, applicationId: app2, tailoringRunId: run2.id, dedupeKey: run2.dedupe_key });

  const listFor1 = listResumeQualityWorkflowsForRun(candidateAId, run1.id);
  const listFor2 = listResumeQualityWorkflowsForRun(candidateAId, run2.id);
  assert.deepEqual(listFor1.map((w) => w.id), [workflow1.id]);
  assert.deepEqual(listFor2.map((w) => w.id), [workflow2.id]);
});

test("workflow-state transitions validated at the query layer: an illegal transition throws and does not write", () => {
  const { run, applicationId } = startRealRun(candidateAId, jobOne);
  const workflow = createResumeQualityWorkflow({ candidateId: candidateAId, applicationId, tailoringRunId: run.id, dedupeKey: run.dedupe_key });
  assert.throws(
    () => transitionWorkflowStatus(candidateAId, workflow.id, "READY"),
    (err: unknown) => err instanceof InvalidWorkflowTransitionError
  );
  const unchanged = getResumeQualityWorkflow(candidateAId, workflow.id)!;
  assert.equal(unchanged.status, "CREATED", "an illegal transition attempt must not change the persisted status");
});

test("workflow-state transitions validated at the query layer: the full legal happy path persists correctly, including completed_at only at a terminal state", () => {
  const { run, applicationId } = startRealRun(candidateAId, jobOne);
  const workflow = createResumeQualityWorkflow({ candidateId: candidateAId, applicationId, tailoringRunId: run.id, dedupeKey: run.dedupe_key });

  let w = transitionWorkflowStatus(candidateAId, workflow.id, "WRITER_RUNNING");
  assert.equal(w.status, "WRITER_RUNNING");
  assert.equal(w.completed_at, null);

  w = transitionWorkflowStatus(candidateAId, workflow.id, "WRITER_COMPLETED");
  w = transitionWorkflowStatus(candidateAId, workflow.id, "REVIEW_RUNNING");
  w = transitionWorkflowStatus(candidateAId, workflow.id, "REVIEW_COMPLETED", { latestOverallScore: 97 });
  assert.equal(w.latest_overall_score, 97);

  w = transitionWorkflowStatus(candidateAId, workflow.id, "READY", { finalApprovedIteration: 1 });
  assert.equal(w.status, "READY");
  assert.equal(w.final_approved_iteration, 1);
  assert.ok(w.completed_at, "completed_at must be set once a terminal status is reached");
});

test("FAILED after max iterations records a human-readable failure_reason, without inventing a 9th status", () => {
  const { run, applicationId } = startRealRun(candidateAId, jobTwo);
  const workflow = createResumeQualityWorkflow({ candidateId: candidateAId, applicationId, tailoringRunId: run.id, dedupeKey: run.dedupe_key });
  transitionWorkflowStatus(candidateAId, workflow.id, "WRITER_RUNNING");
  transitionWorkflowStatus(candidateAId, workflow.id, "WRITER_COMPLETED");
  transitionWorkflowStatus(candidateAId, workflow.id, "REVIEW_RUNNING");
  transitionWorkflowStatus(candidateAId, workflow.id, "REVIEW_COMPLETED");
  const failed = transitionWorkflowStatus(candidateAId, workflow.id, "FAILED", {
    failureReason: "Max iterations (3) reached without meeting the quality gate — human review required.",
  });
  assert.equal(failed.status, "FAILED");
  assert.match(failed.failure_reason!, /human review required/);
  assert.ok(failed.completed_at);
});

test("iteration isolation + immutability: iteration 1 cannot be overwritten by iteration 2, and re-creating iteration 1 is rejected", () => {
  const { run, applicationId } = startRealRun(candidateAId, jobOne);
  const workflow = createResumeQualityWorkflow({ candidateId: candidateAId, applicationId, tailoringRunId: run.id, dedupeKey: run.dedupe_key });

  const iterationInput = (overallScore: number) => ({
    outputFiles: ["Resume.docx", "CoverLetter.docx", "review.json", "review_feedback.md"],
    overallScore,
    atsScore: 80,
    keywordAlignmentScore: 80,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 80,
    formattingScore: 100,
    blockingIssueCount: 0,
    reviewJson: JSON.stringify({ overallScore }),
  });

  const iter1 = createResumeQualityIteration(candidateAId, workflow.id, 1, iterationInput(70));
  const iter2 = createResumeQualityIteration(candidateAId, workflow.id, 2, iterationInput(85));

  assert.notEqual(iter1.id, iter2.id);
  const stillIter1 = getResumeQualityIteration(candidateAId, workflow.id, 1)!;
  assert.equal(stillIter1.overall_score, 70, "iteration 1's own score must be untouched by iteration 2's creation");

  assert.throws(
    () => createResumeQualityIteration(candidateAId, workflow.id, 1, iterationInput(999)),
    (err: unknown) => err instanceof IterationAlreadyExistsError
  );
  // Confirm the throw truly didn't mutate the existing row.
  assert.equal(getResumeQualityIteration(candidateAId, workflow.id, 1)!.overall_score, 70);
});

test("invalid iteration rejected: out-of-sequence iteration numbers are refused", () => {
  const { run, applicationId } = startRealRun(candidateAId, jobTwo);
  const workflow = createResumeQualityWorkflow({ candidateId: candidateAId, applicationId, tailoringRunId: run.id, dedupeKey: run.dedupe_key });
  const input = {
    outputFiles: ["Resume.docx"],
    overallScore: 80,
    atsScore: 80,
    keywordAlignmentScore: 80,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 80,
    formattingScore: 100,
    blockingIssueCount: 0,
    reviewJson: "{}",
  };
  assert.throws(
    () => createResumeQualityIteration(candidateAId, workflow.id, 2, input), // skipping iteration 1
    (err: unknown) => err instanceof IterationOutOfSequenceError
  );
});

test("invalid iteration rejected: iteration numbers beyond max_iterations are refused", () => {
  const { run, applicationId } = startRealRun(candidateBId, jobOne);
  const workflow = createResumeQualityWorkflow({ candidateId: candidateBId, applicationId, tailoringRunId: run.id, dedupeKey: run.dedupe_key, maxIterations: 2 });
  const input = {
    outputFiles: ["Resume.docx"],
    overallScore: 80,
    atsScore: 80,
    keywordAlignmentScore: 80,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 80,
    formattingScore: 100,
    blockingIssueCount: 0,
    reviewJson: "{}",
  };
  createResumeQualityIteration(candidateBId, workflow.id, 1, input);
  createResumeQualityIteration(candidateBId, workflow.id, 2, input);
  assert.throws(
    () => createResumeQualityIteration(candidateBId, workflow.id, 3, input),
    (err: unknown) => err instanceof IterationExceedsMaxError
  );
});

test("listResumeQualityIterations returns all iterations for a workflow in ascending order", () => {
  const { run, applicationId } = startRealRun(candidateAId, jobOne);
  const workflow = createResumeQualityWorkflow({ candidateId: candidateAId, applicationId, tailoringRunId: run.id, dedupeKey: run.dedupe_key, maxIterations: 3 });
  const input = (score: number) => ({
    outputFiles: ["Resume.docx"],
    overallScore: score,
    atsScore: score,
    keywordAlignmentScore: score,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: score,
    formattingScore: 100,
    blockingIssueCount: 0,
    reviewJson: "{}",
  });
  createResumeQualityIteration(candidateAId, workflow.id, 1, input(60));
  createResumeQualityIteration(candidateAId, workflow.id, 2, input(75));
  createResumeQualityIteration(candidateAId, workflow.id, 3, input(96));

  const all = listResumeQualityIterations(candidateAId, workflow.id);
  assert.deepEqual(all.map((i) => i.iteration_number), [1, 2, 3]);
  assert.deepEqual(all.map((i) => i.overall_score), [60, 75, 96]);
});

test("output_files on an iteration are stored as a JSON array of relative filenames, never absolute paths", () => {
  const { run, applicationId } = startRealRun(candidateAId, jobTwo);
  const workflow = createResumeQualityWorkflow({ candidateId: candidateAId, applicationId, tailoringRunId: run.id, dedupeKey: run.dedupe_key });
  const iteration = createResumeQualityIteration(candidateAId, workflow.id, 1, {
    outputFiles: ["Resume.docx", "CoverLetter.docx", "review.json", "review_feedback.md"],
    overallScore: 90,
    atsScore: 90,
    keywordAlignmentScore: 90,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 90,
    formattingScore: 100,
    blockingIssueCount: 0,
    reviewJson: "{}",
  });
  const files = JSON.parse(iteration.output_files!) as string[];
  for (const f of files) {
    assert.equal(path.isAbsolute(f), false);
    assert.ok(!f.includes("/"));
  }
});

test("blocking_issue_count is persisted for cheap gate-checking without JSON parsing", () => {
  const { run, applicationId } = startRealRun(candidateBId, jobTwo);
  const workflow = createResumeQualityWorkflow({ candidateId: candidateBId, applicationId, tailoringRunId: run.id, dedupeKey: run.dedupe_key });
  const iteration = createResumeQualityIteration(candidateBId, workflow.id, 1, {
    outputFiles: [],
    overallScore: 50,
    atsScore: 50,
    keywordAlignmentScore: 50,
    truthfulnessScore: 80,
    architectureConsistencyScore: 80,
    recruiterReadabilityScore: 50,
    formattingScore: 80,
    blockingIssueCount: 2,
    reviewJson: JSON.stringify({ blockingIssues: ["a", "b"] }),
  });
  assert.equal(iteration.blocking_issue_count, 2);
});
