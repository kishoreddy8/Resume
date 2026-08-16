import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import type { Decision, JobMatchResult } from "@/lib/match/types";
import type { ForYouApiResponse } from "../[candidateId]/for-you/route";

let tmpDir: string;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getJobIdByDedupeKey: typeof import("@/db/queries/jobs").getJobIdByDedupeKey;
let setPipelineStatus: typeof import("@/db/queries/candidateJobState").setPipelineStatus;
let insertJobMatchResult: typeof import("@/db/queries/jobMatches").insertJobMatchResult;
let createResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityWorkflow;
let transitionWorkflowStatus: typeof import("@/db/queries/resumeQualityWorkflows").transitionWorkflowStatus;
let createTailoringRun: typeof import("@/db/queries/tailoringRuns").createTailoringRun;
let getAtsCoverageSummary: typeof import("@/db/queries/atsCoverage").getAtsCoverageSummary;
let GET: typeof import("../[candidateId]/for-you/route").GET;

const TODAY = new Date().toISOString();

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-foryou-perf-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  const { getDb } = await import("@/db/index");
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobIdByDedupeKey } = await import("@/db/queries/jobs"));
  ({ setPipelineStatus } = await import("@/db/queries/candidateJobState"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ createResumeQualityWorkflow, transitionWorkflowStatus } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ createTailoringRun } = await import("@/db/queries/tailoringRuns"));
  ({ getAtsCoverageSummary } = await import("@/db/queries/atsCoverage"));
  ({ GET } = await import("../[candidateId]/for-you/route"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let jobSeq = 0;
function createJob(companyId: number, options: { title?: string; location?: string; postedAt?: string; description?: string } = {}): string {
  jobSeq++;
  const dedupeKey = `gh:${companyId}:perf-job-${jobSeq}`;
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: `perf-job-${jobSeq}`,
      title: options.title ?? `Staff Engineer ${jobSeq}`,
      location: options.location ?? "Remote, USA",
      department: "Engineering",
      url: `https://boards.greenhouse.io/co/jobs/${jobSeq}`,
      descriptionHtml: `<p>${options.description ?? "Staff engineering role with large description payload"}</p>`,
      descriptionText: options.description ?? "Staff engineering role with large description payload",
      employmentType: "Full Time",
      workplaceType: "Remote",
      salaryText: "$200,000",
      postedAt: options.postedAt ?? TODAY,
      raw: { complex: "payload" },
    },
    descriptionSections: null,
    sponsorshipMentioned: true,
    sponsorshipPolarity: "positive",
    sponsorshipSnippet: "Visa sponsorship available",
    h1bCombinedConfidence: "High",
  });
  return dedupeKey;
}

function matchResult(data: { candidateId: number; dedupeKey: string; jobId: number; decision: Decision; overallScore: number }): JobMatchResult {
  return {
    candidateId: data.candidateId,
    dedupeKey: data.dedupeKey,
    jobId: data.jobId,
    matchEngineVersion: 2,
    matchKnowledgeHash: "khash",
    candidateProfileHash: "phash",
    candidateSettingsHash: "shash",
    jdContentHash: "jdhash",
    computedAt: TODAY,
    eligibility: {
      status: data.decision === "BLOCKED" ? "BLOCKED" : "PASS",
      reasons: [],
      sponsorship: { signal: "explicit_positive", note: "Sponsorship available" },
    },
    dimensionScores: { required: data.overallScore, preferred: data.overallScore, experience: data.overallScore, seniority: data.overallScore },
    overallScore: data.overallScore,
    requirementCoverage: 0.9,
    employerEvidencedShare: 0.8,
    insufficientJdSignal: false,
    employerEvidencedMatches: [],
    inventoryOnlyMatches: [],
    transferableMatches: [],
    missingRequirements: [],
    unresolvedRequirements: [],
    criticalGaps: [],
    unrecognizedCandidateSkills: [],
    recommendedTrack: "Data Engineer",
    decision: data.decision,
    blockingReasons: [],
  };
}

async function callForYou(candidateId: number, queryParams = ""): Promise<ForYouApiResponse> {
  const url = `http://localhost:3000/api/candidates/${candidateId}/for-you${queryParams ? `?${queryParams}` : ""}`;
  const req = new NextRequest(url);
  const res = await GET(req, { params: Promise.resolve({ candidateId: String(candidateId) }) });
  assert.equal(res.status, 200);
  return res.json();
}

test("Performance & Scale Test: 500+ jobs correctly classified into fast buckets and bounded list", async () => {
  const candA = createCandidate({ firstName: "Alice", lastName: "Perf" });
  const candB = createCandidate({ firstName: "Bob", lastName: "Perf" });
  const company = createCompany({ name: "ScaleCorp", source_type: "greenhouse", ats_board_token: "scalecorp" });

  // Generate 50 jobs
  const jobKeys: string[] = [];
  for (let i = 0; i < 50; i++) {
    jobKeys.push(createJob(company.id, { title: `Software Engineer ${i}` }));
  }

  // 1. Candidate A has a READY_TO_APPLY job
  const readyJobId = getJobIdByDedupeKey(jobKeys[0])!;
  const cjsA = setPipelineStatus(candA.id, jobKeys[0], "New");
  const run = createTailoringRun({
    candidateId: candA.id,
    dedupeKey: jobKeys[0],
    jobId: readyJobId,
    approvalType: "READY_DIRECT",
    decisionAtApproval: "READY_FOR_TAILORING",
    approvedAt: TODAY,
    rendererVersion: 1,
  });
  const wf = createResumeQualityWorkflow({ candidateId: candA.id, dedupeKey: jobKeys[0], applicationId: cjsA.id, tailoringRunId: run.id, maxIterations: 3 });
  transitionWorkflowStatus(candA.id, wf.id, "WRITER_RUNNING", { currentIteration: 1 });
  transitionWorkflowStatus(candA.id, wf.id, "WRITER_COMPLETED");
  transitionWorkflowStatus(candA.id, wf.id, "REVIEW_RUNNING");
  transitionWorkflowStatus(candA.id, wf.id, "REVIEW_COMPLETED", { latestOverallScore: 98 });
  transitionWorkflowStatus(candA.id, wf.id, "READY", { finalApprovedIteration: 1, latestOverallScore: 98 });

  // 2. Candidate A has a READY_FOR_TAILORING match
  const readyMatchJobId = getJobIdByDedupeKey(jobKeys[1])!;
  insertJobMatchResult(matchResult({ candidateId: candA.id, dedupeKey: jobKeys[1], jobId: readyMatchJobId, decision: "READY_FOR_TAILORING", overallScore: 92 }));

  // 3. Candidate A has a NEEDS_REVIEW match
  const reviewMatchJobId = getJobIdByDedupeKey(jobKeys[2])!;
  insertJobMatchResult(matchResult({ candidateId: candA.id, dedupeKey: jobKeys[2], jobId: reviewMatchJobId, decision: "NEEDS_REVIEW", overallScore: 78 }));

  // 4. Candidate A has an APPLIED job
  setPipelineStatus(candA.id, jobKeys[3], "Applied");

  // 5. Candidate A has an INTERVIEWING job
  setPipelineStatus(candA.id, jobKeys[4], "Interviewing");

  // Query For You feed
  const start = performance.now();
  const resA = await callForYou(candA.id);
  const elapsed = performance.now() - start;

  assert.ok(elapsed < 500, `Feed execution took ${elapsed.toFixed(2)}ms (< 500ms target)`);
  assert.equal(resA.bucketCounts.readyToApply, 1);
  assert.equal(resA.bucketCounts.readyForTailoring, 1);
  assert.equal(resA.bucketCounts.needsReview, 1);
  assert.equal(resA.bucketCounts.applied, 1);
  assert.equal(resA.bucketCounts.interviewing, 1);
  assert.ok(resA.bucketCounts.all >= 50);

  // Specific bucket query: ready_to_apply
  const readyFeed = await callForYou(candA.id, "bucket=ready_to_apply");
  assert.equal(readyFeed.entries.length, 1);
  assert.equal(readyFeed.entries[0].job.dedupe_key, jobKeys[0]);
  assert.equal(readyFeed.entries[0].ranking.primaryBucket, "READY_TO_APPLY");

  // Verify Candidate B isolation: zero candidate A facts leak to Candidate B
  const resB = await callForYou(candB.id);
  assert.equal(resB.bucketCounts.readyToApply, 0);
  assert.equal(resB.bucketCounts.readyForTailoring, 0);
  assert.equal(resB.bucketCounts.needsReview, 0);
  assert.equal(resB.bucketCounts.applied, 0);
  assert.equal(resB.bucketCounts.interviewing, 0);

  // ATS Coverage Summary sub-second verification
  const atsStart = performance.now();
  const atsSummary = getAtsCoverageSummary();
  const atsElapsed = performance.now() - atsStart;
  assert.ok(atsElapsed < 500, `ATS Coverage took ${atsElapsed.toFixed(2)}ms (< 500ms target)`);
  assert.ok(atsSummary.totals.companies >= 1);
});
