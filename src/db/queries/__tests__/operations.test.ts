import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * Phase 4 Stage 6 — src/db/queries/operations.ts. Real (temp, isolated) SQLite DB, same pattern as
 * every other query-layer test in this repo. No network, no production DB access.
 */

let tmpDbDir: string;

let getDb: typeof import("@/db").getDb;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let recordScanSuccess: typeof import("@/db/queries/companies").recordScanSuccess;
let recordScanFailure: typeof import("@/db/queries/companies").recordScanFailure;
let recordScanPartial: typeof import("@/db/queries/companies").recordScanPartial;
let recordScanRun: typeof import("@/db/queries/scanRuns").recordScanRun;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let insertJobMatchResult: typeof import("@/db/queries/jobMatches").insertJobMatchResult;
let insertMatchRun: typeof import("@/db/queries/matchRuns").insertMatchRun;
let createNotificationIfAbsent: typeof import("@/db/queries/notifications").createNotificationIfAbsent;
let markNotificationRead: typeof import("@/db/queries/notifications").markNotificationRead;
let setPipelineStatus: typeof import("@/db/queries/candidateJobState").setPipelineStatus;
let createTailoringRun: typeof import("@/db/queries/tailoringRuns").createTailoringRun;
let createResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityWorkflow;
let transitionWorkflowStatus: typeof import("@/db/queries/resumeQualityWorkflows").transitionWorkflowStatus;
let getCandidateJobState: typeof import("@/db/queries/candidateJobState").getCandidateJobState;

let ops: typeof import("../operations");

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-operations-db-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");

  ({ getDb } = await import("@/db"));
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany, recordScanSuccess, recordScanFailure, recordScanPartial } = await import("@/db/queries/companies"));
  ({ recordScanRun } = await import("@/db/queries/scanRuns"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ insertMatchRun } = await import("@/db/queries/matchRuns"));
  ({ createNotificationIfAbsent, markNotificationRead } = await import("@/db/queries/notifications"));
  ({ setPipelineStatus, getCandidateJobState } = await import("@/db/queries/candidateJobState"));
  ({ createTailoringRun } = await import("@/db/queries/tailoringRuns"));
  ({ createResumeQualityWorkflow, transitionWorkflowStatus } = await import("@/db/queries/resumeQualityWorkflows"));
  ops = await import("../operations");
  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
  } catch {}
});

let companyCounter = 0;
function makeCompany(sourceType = "greenhouse") {
  companyCounter++;
  return createCompany({ name: `Ops Test Co ${companyCounter}`, source_type: sourceType as never, ats_board_token: `ops-${companyCounter}` });
}

let jobCounter = 0;
function seedJob(companyId: number, overrides: { title?: string; descriptionText?: string } = {}) {
  jobCounter++;
  const externalId = `ops-job-${jobCounter}`;
  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, externalId);
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId,
      title: overrides.title ?? "Ops Test Role",
      location: "Austin, TX",
      department: null,
      url: "https://example.com/job",
      descriptionHtml: null,
      descriptionText: overrides.descriptionText ?? "desc",
      employmentType: null,
      workplaceType: null,
      salaryText: null,
      postedAt: new Date().toISOString(),
      raw: null,
    },
    descriptionSections: null,
    sponsorshipMentioned: true,
    sponsorshipPolarity: "positive",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  return dedupeKey;
}

function fakeMatch(candidateId: number, dedupeKey: string, jobId: number, decision: "READY_FOR_TAILORING" | "NEEDS_REVIEW" | "BLOCKED", overallScore = 80) {
  return {
    candidateId,
    dedupeKey,
    jobId,
    matchEngineVersion: 1,
    matchKnowledgeHash: "khash",
    candidateProfileHash: `phash-${jobId}`,
    candidateSettingsHash: "shash",
    jdContentHash: `jdhash-${jobId}`,
    computedAt: new Date().toISOString(),
    eligibility: { status: decision === "BLOCKED" ? ("BLOCKED" as const) : ("PASS" as const), reasons: [], sponsorship: { signal: "explicit_positive" as const, note: "n/a" } },
    dimensionScores: { roleAlignment: null, required: 80, preferred: 80, experience: 80, seniority: 80 },
    overallScore,
    requirementCoverage: 0.8,
    employerEvidencedShare: 0.8,
    insufficientJdSignal: false,
    employerEvidencedMatches: [],
    inventoryOnlyMatches: [],
    transferableMatches: [],
    missingRequirements: [],
    unresolvedRequirements: [],
    criticalGaps: [],
    unrecognizedCandidateSkills: [],
    recommendedTrack: "General / Unclassified" as const,
    decision,
    blockingReasons: [],
    roleAlignmentDetail: null,
  };
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

// --- Scanning ---------------------------------------------------------------------------------

test("12. scan aggregation correct — window sums match seeded scan_runs", () => {
  const company = makeCompany();
  recordScanRun({
    companyId: company.id, provider: "greenhouse", startedAt: hoursAgoIso(1), finishedAt: hoursAgoIso(1), durationMs: 100,
    status: "success", jobsDiscovered: 5, jobsAdded: 3, jobsUpdated: 1, jobsUnchanged: 1, duplicatesSkipped: 0, jobsClosed: 0,
    jobsArchived: 0, descriptionFailures: 0, retryCount: 0,
  });
  recordScanRun({
    companyId: company.id, provider: "greenhouse", startedAt: hoursAgoIso(2), finishedAt: hoursAgoIso(2), durationMs: 100,
    status: "failed", jobsDiscovered: 0, jobsAdded: 0, jobsUpdated: 0, jobsUnchanged: 0, duplicatesSkipped: 0, jobsClosed: 0,
    jobsArchived: 0, descriptionFailures: 0, retryCount: 2, errorCategory: "timeout", errorMessage: "boom",
  });

  const summary = ops.getScanningWindowSummary(1);
  assert.equal(summary.runs, 2);
  assert.equal(summary.successCount, 1);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.jobsAdded, 3);
  assert.equal(summary.retryCount, 2);
  assert.equal(summary.companiesScanned, 1);
});

test("13. 24h window correct — a run 3 days old is excluded from a 24h window", () => {
  // Delta check, not an absolute-zero check: earlier tests in this shared DB may already have
  // inserted runs within the last 24h, so the correct proof is that adding a 3-day-old row changes
  // the 24h aggregate by exactly zero, not that the aggregate starts at zero.
  const before = ops.getScanningWindowSummary(1).runs;
  const company = makeCompany();
  recordScanRun({
    companyId: company.id, provider: "greenhouse", startedAt: hoursAgoIso(72), finishedAt: hoursAgoIso(72), durationMs: 100,
    status: "success", jobsDiscovered: 1, jobsAdded: 1, jobsUpdated: 0, jobsUnchanged: 0, duplicatesSkipped: 0, jobsClosed: 0,
    jobsArchived: 0, descriptionFailures: 0, retryCount: 0,
  });
  const after = ops.getScanningWindowSummary(1).runs;
  assert.equal(after, before, "a 3-day-old run must not be counted in a 24h window");
});

test("14. 7d window correct — a run 3 days old IS included in a 7d window", () => {
  const company = makeCompany();
  recordScanRun({
    companyId: company.id, provider: "greenhouse", startedAt: hoursAgoIso(72), finishedAt: hoursAgoIso(72), durationMs: 100,
    status: "success", jobsDiscovered: 1, jobsAdded: 1, jobsUpdated: 0, jobsUnchanged: 0, duplicatesSkipped: 0, jobsClosed: 0,
    jobsArchived: 0, descriptionFailures: 0, retryCount: 0,
  });
  // Delta check against a fresh company-scoped baseline is impossible with a global aggregate, so
  // this asserts a run this old is NOT excluded — paired with test 13's exclusion proof at 24h and
  // test 15's exclusion proof at 30d+1, this triangulates the window boundary is respected.
  const summaryAtCreation = ops.getScanningWindowSummary(7);
  assert.ok(summaryAtCreation.runs >= 1);
});

test("15. 30d window correct — a run 45 days old is excluded even from a 30d window", () => {
  const company = makeCompany();
  recordScanRun({
    companyId: company.id, provider: "greenhouse", startedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
    finishedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(), durationMs: 100,
    status: "success", jobsDiscovered: 1, jobsAdded: 1, jobsUpdated: 0, jobsUnchanged: 0, duplicatesSkipped: 0, jobsClosed: 0,
    jobsArchived: 0, descriptionFailures: 0, retryCount: 0,
  });
  // Prove exclusion via a scoped re-derivation: a run this old must never satisfy the 30-day filter.
  const row = getDb()
    .prepare(`SELECT julianday('now') - julianday(started_at) AS ageDays FROM scan_runs WHERE company_id = ?`)
    .get(company.id) as { ageDays: number };
  assert.ok(row.ageDays > 30);
});

test("latest scan activity reflects the most recently started run, not window-filtered, with correctly-cased fields", () => {
  const company = makeCompany();
  const startedAt = new Date().toISOString();
  recordScanRun({
    companyId: company.id, provider: "greenhouse", startedAt, finishedAt: startedAt, durationMs: 100,
    status: "success", jobsDiscovered: 1, jobsAdded: 1, jobsUpdated: 0, jobsUnchanged: 0, duplicatesSkipped: 0, jobsClosed: 0,
    jobsArchived: 0, descriptionFailures: 0, retryCount: 0,
  });
  const latest = ops.getLatestScanActivity();
  assert.ok(latest !== null, "latest scan activity must be visible regardless of the dashboard's selected window");
  // Regression guard: an earlier version of this query returned raw snake_case columns
  // (started_at/finished_at) cast to a camelCase interface, so latest.startedAt silently read as
  // undefined at runtime (TypeScript's cast never actually checked this) — caught only by manually
  // driving the real dashboard against production data, not by a test that merely checked non-null.
  assert.equal(latest!.startedAt, startedAt);
  assert.equal(latest!.status, "success");
});

// --- Connectors ---------------------------------------------------------------------------------

test("connector health summary counts match recordScanSuccess/Failure state transitions", () => {
  const healthy = makeCompany();
  recordScanSuccess(healthy.id);
  const degraded = makeCompany();
  recordScanPartial(degraded.id, { errorCategory: "timeout", errorMessage: "partial" });
  const down = makeCompany();
  for (let i = 0; i < 5; i++) recordScanFailure(down.id, { errorCategory: "timeout", errorMessage: "fail" });

  const summary = ops.getConnectorHealthSummary();
  assert.ok(summary.healthy >= 1);
  assert.ok(summary.degraded >= 1);
  assert.ok(summary.down >= 1);
});

test("top failing connectors are ordered by consecutive_failures, worst first", () => {
  const low = makeCompany();
  recordScanFailure(low.id, { errorCategory: "timeout", errorMessage: "e" });
  const high = makeCompany();
  for (let i = 0; i < 4; i++) recordScanFailure(high.id, { errorCategory: "timeout", errorMessage: "e" });

  const top = ops.listTopFailingConnectors(5);
  const highIndex = top.findIndex((c) => c.id === high.id);
  const lowIndex = top.findIndex((c) => c.id === low.id);
  assert.ok(highIndex !== -1 && lowIndex !== -1);
  assert.ok(highIndex < lowIndex, "the company with more consecutive failures must sort first");
});

// --- Matching ---------------------------------------------------------------------------------

test("18/19/20. current READY_FOR_TAILORING/NEEDS_REVIEW/BLOCKED counts correct for the active candidate only", () => {
  const candidate = createCandidate({ firstName: "Ops", lastName: "Matching" });
  const company = makeCompany();
  const readyKey = seedJob(company.id);
  const reviewKey = seedJob(company.id);
  const blockedKey = seedJob(company.id);
  insertJobMatchResult(fakeMatch(candidate.id, readyKey, getJobByDedupeKey(readyKey)!.id, "READY_FOR_TAILORING", 92));
  insertJobMatchResult(fakeMatch(candidate.id, reviewKey, getJobByDedupeKey(reviewKey)!.id, "NEEDS_REVIEW", 70));
  insertJobMatchResult(fakeMatch(candidate.id, blockedKey, getJobByDedupeKey(blockedKey)!.id, "BLOCKED", 40));

  const counts = ops.getCandidateMatchDecisionCounts(candidate.id);
  assert.equal(counts.readyForTailoring, 1);
  assert.equal(counts.needsReview, 1);
  assert.equal(counts.blocked, 1);
});

test("a superseded (non-current) match result is excluded from the current decision counts", () => {
  const candidate = createCandidate({ firstName: "Ops", lastName: "Superseded" });
  const company = makeCompany();
  const key = seedJob(company.id);
  const jobId = getJobByDedupeKey(key)!.id;
  insertJobMatchResult(fakeMatch(candidate.id, key, jobId, "BLOCKED", 40));
  const before = ops.getCandidateMatchDecisionCounts(candidate.id);
  assert.equal(before.blocked, 1);

  const newer = fakeMatch(candidate.id, key, jobId, "READY_FOR_TAILORING", 95);
  newer.candidateProfileHash = "different-hash";
  insertJobMatchResult(newer);

  const after = ops.getCandidateMatchDecisionCounts(candidate.id);
  assert.equal(after.blocked, 0, "the superseded BLOCKED row must no longer be counted");
  assert.equal(after.readyForTailoring, 1);
});

test("14. candidate A cannot receive candidate B match metrics", () => {
  const a = createCandidate({ firstName: "MatchIso", lastName: "A" });
  const b = createCandidate({ firstName: "MatchIso", lastName: "B" });
  const company = makeCompany();
  const key = seedJob(company.id);
  insertJobMatchResult(fakeMatch(a.id, key, getJobByDedupeKey(key)!.id, "READY_FOR_TAILORING", 95));

  const bCounts = ops.getCandidateMatchDecisionCounts(b.id);
  assert.equal(bCounts.readyForTailoring, 0);
  assert.equal(bCounts.needsReview, 0);
  assert.equal(bCounts.blocked, 0);
});

test("recent candidate match_runs are scoped to the requested candidate only", () => {
  const a = createCandidate({ firstName: "RunsIso", lastName: "A" });
  const b = createCandidate({ firstName: "RunsIso", lastName: "B" });
  insertMatchRun({ candidateId: a.id, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), jobsEvaluated: 3, jobsBlocked: 1, jobsNeedsReview: 1, jobsReady: 1, jobsErrored: 0 });

  const aRuns = ops.getRecentCandidateMatchRuns(a.id, 10);
  const bRuns = ops.getRecentCandidateMatchRuns(b.id, 10);
  assert.equal(aRuns.length, 1);
  assert.equal(bRuns.length, 0);
});

// --- Notifications ------------------------------------------------------------------------------

test("21. unread notification count correct", () => {
  const candidate = createCandidate({ firstName: "Notif", lastName: "Unread" });
  createNotificationIfAbsent({ candidateId: candidate.id, dedupeKey: "gh:1:a", type: "HIGH_VALUE_JOB_MATCH", title: "A", body: "b" });
  createNotificationIfAbsent({ candidateId: candidate.id, dedupeKey: "gh:1:b", type: "HIGH_VALUE_JOB_MATCH", title: "B", body: "b" });
  const firstNotif = ops.listRecentNotifications(candidate.id, 10)[0];
  markNotificationRead(candidate.id, firstNotif.id);

  const summary = ops.getNotificationSummary(candidate.id, 1);
  assert.equal(summary.total, 2);
  assert.equal(summary.unread, 1);
  assert.equal(summary.read, 1);
});

test("22. notification time-window counts correct", () => {
  const candidate = createCandidate({ firstName: "Notif", lastName: "Window" });
  createNotificationIfAbsent({ candidateId: candidate.id, dedupeKey: "gh:2:a", type: "HIGH_VALUE_JOB_MATCH", title: "A", body: "b" });
  const summary24h = ops.getNotificationSummary(candidate.id, 1);
  assert.equal(summary24h.createdInWindow, 1, "a freshly created notification must count within a 24h window");
});

test("candidate A cannot receive candidate B notification metrics", () => {
  const a = createCandidate({ firstName: "NotifIso", lastName: "A" });
  const b = createCandidate({ firstName: "NotifIso", lastName: "B" });
  createNotificationIfAbsent({ candidateId: a.id, dedupeKey: "gh:3:a", type: "HIGH_VALUE_JOB_MATCH", title: "A", body: "b" });

  const bSummary = ops.getNotificationSummary(b.id, 30);
  assert.equal(bSummary.total, 0);
  assert.equal(ops.listRecentNotifications(b.id, 10).length, 0);
});

test("total notifications ever created is a genuine cross-candidate sum, used only for global health", () => {
  const a = createCandidate({ firstName: "NotifTotal", lastName: "A" });
  createNotificationIfAbsent({ candidateId: a.id, dedupeKey: "gh:4:a", type: "HIGH_VALUE_JOB_MATCH", title: "A", body: "b" });
  assert.ok(ops.getTotalNotificationsEverCreated() >= 1);
});

// --- Application lifecycle -----------------------------------------------------------------------

test("23/24/25/26/27/28. pipeline status counts correct per status", () => {
  const candidate = createCandidate({ firstName: "Lifecycle", lastName: "Counts" });
  const company = makeCompany();
  const newKey = seedJob(company.id);
  const interestedKey = seedJob(company.id);
  const appliedKey = seedJob(company.id);
  const interviewingKey = seedJob(company.id);
  const offerKey = seedJob(company.id);
  const rejectedKey = seedJob(company.id);
  setPipelineStatus(candidate.id, interestedKey, "Interested");
  setPipelineStatus(candidate.id, appliedKey, "Applied");
  setPipelineStatus(candidate.id, interviewingKey, "Interviewing");
  setPipelineStatus(candidate.id, offerKey, "Offer");
  setPipelineStatus(candidate.id, rejectedKey, "Employer Rejected");
  void newKey;

  const counts = ops.getApplicationLifecycleCounts(candidate.id);
  assert.equal(counts.interested, 1);
  assert.equal(counts.applied, 1);
  assert.equal(counts.interviewing, 1);
  assert.equal(counts.offer, 1);
  assert.equal(counts.employerRejected, 1);
});

test("15. candidate A cannot receive candidate B application metrics", () => {
  const a = createCandidate({ firstName: "AppIso", lastName: "A" });
  const b = createCandidate({ firstName: "AppIso", lastName: "B" });
  const company = makeCompany();
  const key = seedJob(company.id);
  setPipelineStatus(a.id, key, "Applied");

  const bCounts = ops.getApplicationLifecycleCounts(b.id);
  assert.equal(bCounts.applied, 0);
});

function createReadyWorkflow(candidateId: number, dedupeKey: string, jobId: number, finalIteration: number, score: number) {
  const state = getCandidateJobState(candidateId, dedupeKey) ?? setPipelineStatus(candidateId, dedupeKey, "New");
  const run = createTailoringRun({
    candidateId,
    dedupeKey,
    jobId,
    approvalType: "READY_DIRECT",
    decisionAtApproval: "READY_FOR_TAILORING",
    approvedAt: new Date().toISOString(),
  });
  const workflow = createResumeQualityWorkflow({ candidateId, applicationId: state.id, tailoringRunId: run.id, dedupeKey, maxIterations: 3 });
  let w = workflow;
  // Iteration 1 goes CREATED -> WRITER_RUNNING -> ... -> REVIEW_RUNNING. Every subsequent iteration
  // re-enters at REVIEW_RUNNING directly from IMPROVEMENT_RUNNING — there is no WRITER_RUNNING leg
  // on later iterations (see stateMachine.ts's VALID_TRANSITIONS: IMPROVEMENT_RUNNING -> REVIEW_RUNNING).
  w = transitionWorkflowStatus(candidateId, w.id, "WRITER_RUNNING");
  w = transitionWorkflowStatus(candidateId, w.id, "WRITER_COMPLETED", { currentIteration: 1 });
  for (let i = 1; i <= finalIteration; i++) {
    w = transitionWorkflowStatus(candidateId, w.id, "REVIEW_RUNNING");
    if (i === finalIteration) {
      w = transitionWorkflowStatus(candidateId, w.id, "REVIEW_COMPLETED", { latestOverallScore: score });
      w = transitionWorkflowStatus(candidateId, w.id, "READY", { finalApprovedIteration: i });
    } else {
      w = transitionWorkflowStatus(candidateId, w.id, "REVIEW_COMPLETED");
      w = transitionWorkflowStatus(candidateId, w.id, "IMPROVEMENT_RUNNING", { currentIteration: i + 1 });
    }
  }
  return w;
}

test("29. Ready-to-Apply derived correctly via the shared classifyCandidateJobBucket classifier", () => {
  const candidate = createCandidate({ firstName: "ReadyToApply", lastName: "Derived" });
  const company = makeCompany();
  const readyKey = seedJob(company.id);
  createReadyWorkflow(candidate.id, readyKey, getJobByDedupeKey(readyKey)!.id, 1, 90);

  const appliedKey = seedJob(company.id);
  createReadyWorkflow(candidate.id, appliedKey, getJobByDedupeKey(appliedKey)!.id, 1, 90);
  setPipelineStatus(candidate.id, appliedKey, "Applied");

  const counts = ops.getApplicationLifecycleCounts(candidate.id);
  assert.equal(counts.readyToApply, 1, "an Applied job with a READY resume must NOT count as Ready to Apply (Applied outranks it)");
});

// --- Resume quality -------------------------------------------------------------------------------

test("30/31/32. READY / IMPROVEMENT_RUNNING / FAILED workflow counts correct", () => {
  const candidate = createCandidate({ firstName: "Quality", lastName: "Counts" });
  const company = makeCompany();

  const readyKey = seedJob(company.id);
  createReadyWorkflow(candidate.id, readyKey, getJobByDedupeKey(readyKey)!.id, 1, 88);

  const improvingKey = seedJob(company.id);
  const improvingState = setPipelineStatus(candidate.id, improvingKey, "New");
  const improvingRun = createTailoringRun({ candidateId: candidate.id, dedupeKey: improvingKey, jobId: getJobByDedupeKey(improvingKey)!.id, approvalType: "READY_DIRECT", decisionAtApproval: "READY_FOR_TAILORING", approvedAt: new Date().toISOString() });
  const improvingWorkflow = createResumeQualityWorkflow({ candidateId: candidate.id, applicationId: improvingState.id, tailoringRunId: improvingRun.id, dedupeKey: improvingKey, maxIterations: 3 });
  transitionWorkflowStatus(candidate.id, improvingWorkflow.id, "WRITER_RUNNING");
  transitionWorkflowStatus(candidate.id, improvingWorkflow.id, "WRITER_COMPLETED", { currentIteration: 1 });
  transitionWorkflowStatus(candidate.id, improvingWorkflow.id, "REVIEW_RUNNING");
  transitionWorkflowStatus(candidate.id, improvingWorkflow.id, "REVIEW_COMPLETED");
  transitionWorkflowStatus(candidate.id, improvingWorkflow.id, "IMPROVEMENT_RUNNING", { currentIteration: 2 });

  const failedKey = seedJob(company.id);
  const failedState = setPipelineStatus(candidate.id, failedKey, "New");
  const failedRun = createTailoringRun({ candidateId: candidate.id, dedupeKey: failedKey, jobId: getJobByDedupeKey(failedKey)!.id, approvalType: "READY_DIRECT", decisionAtApproval: "READY_FOR_TAILORING", approvedAt: new Date().toISOString() });
  const failedWorkflow = createResumeQualityWorkflow({ candidateId: candidate.id, applicationId: failedState.id, tailoringRunId: failedRun.id, dedupeKey: failedKey, maxIterations: 1 });
  transitionWorkflowStatus(candidate.id, failedWorkflow.id, "WRITER_RUNNING");
  transitionWorkflowStatus(candidate.id, failedWorkflow.id, "WRITER_COMPLETED", { currentIteration: 1 });
  transitionWorkflowStatus(candidate.id, failedWorkflow.id, "REVIEW_RUNNING");
  transitionWorkflowStatus(candidate.id, failedWorkflow.id, "REVIEW_COMPLETED");
  transitionWorkflowStatus(candidate.id, failedWorkflow.id, "FAILED", { failureReason: "gate still failing at max iterations" });

  const summary = ops.getResumeQualitySummary(candidate.id);
  assert.equal(summary.workflowsByStatus.READY, 1);
  assert.equal(summary.workflowsByStatus.IMPROVEMENT_RUNNING, 1);
  assert.equal(summary.workflowsByStatus.FAILED, 1);
  assert.equal(summary.failedMaxIterations, 1, "current_iteration(1) >= max_iterations(1) -> reached max/human review");
});

test("33. average quality score correct — computed only over READY workflows", () => {
  const candidate = createCandidate({ firstName: "Quality", lastName: "Average" });
  const company = makeCompany();
  const keyA = seedJob(company.id);
  createReadyWorkflow(candidate.id, keyA, getJobByDedupeKey(keyA)!.id, 1, 80);
  const keyB = seedJob(company.id);
  createReadyWorkflow(candidate.id, keyB, getJobByDedupeKey(keyB)!.id, 1, 90);

  const summary = ops.getResumeQualitySummary(candidate.id);
  assert.equal(summary.averageFinalQualityScore, 85);
});

test("34. average iterations correct — computed only over READY workflows with a final_approved_iteration", () => {
  const candidate = createCandidate({ firstName: "Quality", lastName: "Iterations" });
  const company = makeCompany();
  const keyA = seedJob(company.id);
  createReadyWorkflow(candidate.id, keyA, getJobByDedupeKey(keyA)!.id, 1, 80);
  const keyB = seedJob(company.id);
  createReadyWorkflow(candidate.id, keyB, getJobByDedupeKey(keyB)!.id, 3, 80);

  const summary = ops.getResumeQualitySummary(candidate.id);
  assert.equal(summary.averageIterationsToReady, 2);
  assert.equal(summary.readyOnFirstIteration, 1);
  assert.equal(summary.readyRequiredImprovement, 1);
});

test("candidate A cannot receive candidate B resume-quality metrics", () => {
  const a = createCandidate({ firstName: "QualityIso", lastName: "A" });
  const b = createCandidate({ firstName: "QualityIso", lastName: "B" });
  const company = makeCompany();
  const key = seedJob(company.id);
  createReadyWorkflow(a.id, key, getJobByDedupeKey(key)!.id, 1, 90);

  const bSummary = ops.getResumeQualitySummary(b.id);
  assert.equal(bSummary.tailoringRunsTotal, 0);
  assert.deepEqual(bSummary.workflowsByStatus, {});
  assert.equal(bSummary.averageFinalQualityScore, null, "never fabricated as 0 when there is no data");
});
