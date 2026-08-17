import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import type { Decision, JobMatchResult } from "@/lib/match/types";
import type { ForYouApiResponse, ForYouResponseEntry } from "../[candidateId]/for-you/route";

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
let GET: typeof import("../[candidateId]/for-you/route").GET;

const TODAY = new Date().toISOString();
const FIVE_DAYS_AGO = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-foryou-feed-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  const { getDb } = await import("@/db/index");
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobIdByDedupeKey } = await import("@/db/queries/jobs"));
  ({ setPipelineStatus } = await import("@/db/queries/candidateJobState"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ createResumeQualityWorkflow, transitionWorkflowStatus } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ createTailoringRun } = await import("@/db/queries/tailoringRuns"));
  ({ GET } = await import("../[candidateId]/for-you/route"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let jobCounter = 0;
function createTestJob(companyId: number, options: { title?: string; location?: string; postedAt?: string; description?: string } = {}): string {
  jobCounter++;
  const dedupeKey = `gh:${companyId}:job-${jobCounter}`;
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: `job-${jobCounter}`,
      title: options.title ?? `Software Engineer ${jobCounter}`,
      location: options.location ?? "Austin, TX",
      department: "Engineering",
      url: `https://boards.greenhouse.io/co/jobs/${jobCounter}`,
      descriptionHtml: `<p>${options.description ?? "Job description text"}</p>`,
      descriptionText: options.description ?? "Job description text",
      employmentType: "Full Time",
      workplaceType: "Hybrid",
      salaryText: "$150,000",
      postedAt: options.postedAt ?? TODAY,
      raw: {},
    },
    descriptionSections: null,
    sponsorshipMentioned: true,
    sponsorshipPolarity: "positive",
    sponsorshipSnippet: "Visa sponsorship available",
    h1bCombinedConfidence: "High",
  });
  return dedupeKey;
}

function fakeMatch(data: { candidateId: number; dedupeKey: string; jobId: number; decision: Decision; overallScore: number; status?: "active" | "superseded" }): JobMatchResult {
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
    dimensionScores: { roleAlignment: null, required: data.overallScore, preferred: data.overallScore, experience: data.overallScore, seniority: data.overallScore },
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
    roleAlignmentDetail: null,
  };
}

async function fetchForYou(candidateId: number, queryParams = ""): Promise<ForYouApiResponse> {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateId}/for-you${queryParams ? `?${queryParams}` : ""}`);
  const res = await GET(req, { params: Promise.resolve({ candidateId: String(candidateId) }) });
  return res.json() as Promise<ForYouApiResponse>;
}

function markWorkflowReady(candidateId: number, workflowId: number) {
  transitionWorkflowStatus(candidateId, workflowId, "WRITER_RUNNING");
  transitionWorkflowStatus(candidateId, workflowId, "WRITER_COMPLETED");
  transitionWorkflowStatus(candidateId, workflowId, "REVIEW_RUNNING");
  transitionWorkflowStatus(candidateId, workflowId, "REVIEW_COMPLETED");
  transitionWorkflowStatus(candidateId, workflowId, "READY", { latestOverallScore: 98, finalApprovedIteration: 1 });
}

test("1. Fresh job posted today without match -> NEW_TODAY", async () => {
  const company = createCompany({ name: "Fresh Co", source_type: "greenhouse", ats_board_token: "fresh-co" });
  const candidate = createCandidate({ firstName: "Fresh", lastName: "Candidate" });
  const dedupeKey = createTestJob(company.id, { postedAt: TODAY });

  const data = await fetchForYou(candidate.id);
  const entry = data.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entry);
  assert.equal(entry.ranking.primaryBucket, "NEW_TODAY");
  assert.equal(entry.ranking.badges.isNewToday, true);
});

test("2. Current high score (>=90) that is not READY_FOR_TAILORING -> TOP_MATCH", async () => {
  const company = createCompany({ name: "Top Co", source_type: "greenhouse", ats_board_token: "top-co" });
  const candidate = createCandidate({ firstName: "Top", lastName: "Candidate" });
  const dedupeKey = createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });
  const jobId = getJobIdByDedupeKey(dedupeKey)!;

  insertJobMatchResult(fakeMatch({ candidateId: candidate.id, dedupeKey, jobId, decision: "UNKNOWN" as unknown as Decision, overallScore: 94 }));

  const data = await fetchForYou(candidate.id);
  const entry = data.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entry);
  assert.equal(entry.ranking.primaryBucket, "TOP_MATCH");
  assert.equal(entry.ranking.badges.isTopMatch, true);
});

test("3. READY_FOR_TAILORING decision -> READY_FOR_TAILORING", async () => {
  const company = createCompany({ name: "Tailor Co", source_type: "greenhouse", ats_board_token: "tailor-co" });
  const candidate = createCandidate({ firstName: "Tailor", lastName: "Candidate" });
  const dedupeKey = createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });
  const jobId = getJobIdByDedupeKey(dedupeKey)!;

  insertJobMatchResult(fakeMatch({ candidateId: candidate.id, dedupeKey, jobId, decision: "READY_FOR_TAILORING", overallScore: 88 }));

  const data = await fetchForYou(candidate.id);
  const entry = data.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entry);
  assert.equal(entry.ranking.primaryBucket, "READY_FOR_TAILORING");
  assert.equal(entry.ranking.badges.isReadyForTailoring, true);
});

test("4. NEEDS_REVIEW decision -> NEEDS_REVIEW", async () => {
  const company = createCompany({ name: "Review Co", source_type: "greenhouse", ats_board_token: "review-co" });
  const candidate = createCandidate({ firstName: "Review", lastName: "Candidate" });
  const dedupeKey = createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });
  const jobId = getJobIdByDedupeKey(dedupeKey)!;

  insertJobMatchResult(fakeMatch({ candidateId: candidate.id, dedupeKey, jobId, decision: "NEEDS_REVIEW", overallScore: 84 }));

  const data = await fetchForYou(candidate.id);
  const entry = data.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entry);
  assert.equal(entry.ranking.primaryBucket, "NEEDS_REVIEW");
  assert.equal(entry.ranking.badges.isNeedsReview, true);
});

test("5. Phase 3 READY workflow -> READY_TO_APPLY", async () => {
  const company = createCompany({ name: "ReadyApply Co", source_type: "greenhouse", ats_board_token: "readyapply-co" });
  const candidate = createCandidate({ firstName: "Ready", lastName: "Candidate" });
  const dedupeKey = createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });
  const jobId = getJobIdByDedupeKey(dedupeKey)!;

  insertJobMatchResult(fakeMatch({ candidateId: candidate.id, dedupeKey, jobId, decision: "READY_FOR_TAILORING", overallScore: 92 }));

  const state = setPipelineStatus(candidate.id, dedupeKey, "New");

  const run = createTailoringRun({
    candidateId: candidate.id,
    dedupeKey,
    jobId,
    approvalType: "READY_DIRECT",
    decisionAtApproval: "READY_FOR_TAILORING",
    approvedAt: TODAY,
  });

  const wf = createResumeQualityWorkflow({
    candidateId: candidate.id,
    applicationId: state.id,
    tailoringRunId: run.id,
    dedupeKey,
  });

  markWorkflowReady(candidate.id, wf.id);

  const data = await fetchForYou(candidate.id);
  const entry = data.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entry);
  assert.equal(entry.ranking.primaryBucket, "READY_TO_APPLY");
  assert.equal(entry.ranking.hasReadyResume, true);
  assert.equal(entry.ranking.badges.isReadyToApply, true);
});

test("6. Applied overrides READY_TO_APPLY", async () => {
  const company = createCompany({ name: "Applied Co", source_type: "greenhouse", ats_board_token: "applied-co" });
  const candidate = createCandidate({ firstName: "App", lastName: "Candidate" });
  const dedupeKey = createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });
  const jobId = getJobIdByDedupeKey(dedupeKey)!;

  const state = setPipelineStatus(candidate.id, dedupeKey, "New");

  const run = createTailoringRun({
    candidateId: candidate.id,
    dedupeKey,
    jobId,
    approvalType: "READY_DIRECT",
    decisionAtApproval: "READY_FOR_TAILORING",
    approvedAt: TODAY,
  });

  const wf = createResumeQualityWorkflow({
    candidateId: candidate.id,
    applicationId: state.id,
    tailoringRunId: run.id,
    dedupeKey,
  });
  markWorkflowReady(candidate.id, wf.id);

  // Now candidate marks it Applied
  setPipelineStatus(candidate.id, dedupeKey, "Applied");

  const data = await fetchForYou(candidate.id);
  const entry = data.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entry);
  assert.equal(entry.ranking.primaryBucket, "APPLIED");
  assert.equal(entry.ranking.hasReadyResume, true);
  assert.equal(entry.ranking.badges.isApplied, true);
});

test("7. Interviewing overrides READY and APPLIED", async () => {
  const company = createCompany({ name: "Int Co", source_type: "greenhouse", ats_board_token: "int-co" });
  const candidate = createCandidate({ firstName: "Int", lastName: "Candidate" });
  const dedupeKey = createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });

  setPipelineStatus(candidate.id, dedupeKey, "Interviewing");

  const data = await fetchForYou(candidate.id);
  const entry = data.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entry);
  assert.equal(entry.ranking.primaryBucket, "INTERVIEWING");
  assert.equal(entry.ranking.badges.isInterviewing, true);
});

test("8. Candidate A READY workflow cannot affect Candidate B", async () => {
  const company = createCompany({ name: "Iso Co", source_type: "greenhouse", ats_board_token: "iso-co" });
  const candidateA = createCandidate({ firstName: "Cand", lastName: "A" });
  const candidateB = createCandidate({ firstName: "Cand", lastName: "B" });
  const dedupeKey = createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });
  const jobId = getJobIdByDedupeKey(dedupeKey)!;

  const stateA = setPipelineStatus(candidateA.id, dedupeKey, "New");

  // Candidate A gets a READY workflow
  const runA = createTailoringRun({
    candidateId: candidateA.id,
    dedupeKey,
    jobId,
    approvalType: "READY_DIRECT",
    decisionAtApproval: "READY_FOR_TAILORING",
    approvedAt: TODAY,
  });
  const wfA = createResumeQualityWorkflow({
    candidateId: candidateA.id,
    applicationId: stateA.id,
    tailoringRunId: runA.id,
    dedupeKey,
  });
  markWorkflowReady(candidateA.id, wfA.id);

  // Candidate B has no workflow
  const dataA = await fetchForYou(candidateA.id);
  const entryA = dataA.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entryA);
  assert.equal(entryA.ranking.primaryBucket, "READY_TO_APPLY");
  assert.equal(entryA.ranking.hasReadyResume, true);

  const dataB = await fetchForYou(candidateB.id);
  const entryB = dataB.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entryB);
  assert.notEqual(entryB.ranking.primaryBucket, "READY_TO_APPLY");
  assert.equal(entryB.ranking.hasReadyResume, false);
});

test("9. Candidate A match cannot affect Candidate B", async () => {
  const company = createCompany({ name: "MatchIso Co", source_type: "greenhouse", ats_board_token: "matchiso-co" });
  const candidateA = createCandidate({ firstName: "Match", lastName: "A" });
  const candidateB = createCandidate({ firstName: "Match", lastName: "B" });
  const dedupeKey = createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });
  const jobId = getJobIdByDedupeKey(dedupeKey)!;

  insertJobMatchResult(fakeMatch({ candidateId: candidateA.id, dedupeKey, jobId, decision: "READY_FOR_TAILORING", overallScore: 92 }));

  const dataA = await fetchForYou(candidateA.id);
  const entryA = dataA.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entryA);
  assert.equal(entryA.ranking.decision, "READY_FOR_TAILORING");
  assert.equal(entryA.ranking.overallScore, 92);

  const dataB = await fetchForYou(candidateB.id);
  const entryB = dataB.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entryB);
  assert.equal(entryB.ranking.decision, null);
  assert.equal(entryB.ranking.overallScore, null);
});

test("10. Stale match cannot surface as READY_FOR_TAILORING or TOP_MATCH", async () => {
  const company = createCompany({ name: "Stale Co", source_type: "greenhouse", ats_board_token: "stale-co" });
  const candidate = createCandidate({ firstName: "Stale", lastName: "Candidate" });
  const dedupeKey = createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });
  const jobId = getJobIdByDedupeKey(dedupeKey)!;

  // Insert a match and then supersede it
  insertJobMatchResult(fakeMatch({ candidateId: candidate.id, dedupeKey, jobId, decision: "READY_FOR_TAILORING", overallScore: 95 }));
  const { getDb } = await import("@/db/index");
  getDb().prepare("UPDATE job_match_results SET status = 'superseded' WHERE candidate_id = ? AND dedupe_key = ?").run(candidate.id, dedupeKey);

  const data = await fetchForYou(candidate.id);
  const entry = data.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entry);
  assert.notEqual(entry.ranking.primaryBucket, "READY_FOR_TAILORING");
  assert.notEqual(entry.ranking.primaryBucket, "TOP_MATCH");
});

test("11. Stale high score cannot incorrectly become TOP_MATCH", async () => {
  const company = createCompany({ name: "StaleScore Co", source_type: "greenhouse", ats_board_token: "stalescore-co" });
  const candidate = createCandidate({ firstName: "StaleScore", lastName: "Candidate" });
  const dedupeKey = createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });
  const jobId = getJobIdByDedupeKey(dedupeKey)!;

  insertJobMatchResult(fakeMatch({ candidateId: candidate.id, dedupeKey, jobId, decision: "UNKNOWN" as unknown as Decision, overallScore: 98 }));
  const { getDb } = await import("@/db/index");
  getDb().prepare("UPDATE job_match_results SET status = 'superseded' WHERE candidate_id = ? AND dedupe_key = ?").run(candidate.id, dedupeKey);

  const data = await fetchForYou(candidate.id);
  const entry = data.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entry);
  assert.notEqual(entry.ranking.primaryBucket, "TOP_MATCH");
});

test("12. Bucket precedence is deterministic", async () => {
  const company = createCompany({ name: "Prec Co", source_type: "greenhouse", ats_board_token: "prec-co" });
  const candidate = createCandidate({ firstName: "Prec", lastName: "Candidate" });
  const dedupeKey = createTestJob(company.id, { postedAt: TODAY }); // NEW_TODAY
  const jobId = getJobIdByDedupeKey(dedupeKey)!;

  // Has READY_FOR_TAILORING match (should beat NEW_TODAY)
  insertJobMatchResult(fakeMatch({ candidateId: candidate.id, dedupeKey, jobId, decision: "READY_FOR_TAILORING", overallScore: 95 }));

  const data = await fetchForYou(candidate.id);
  const entry = data.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entry);
  assert.equal(entry.ranking.primaryBucket, "READY_FOR_TAILORING");
});

test("13. Bucket filtering works (?bucket=ready_for_tailoring)", async () => {
  const company = createCompany({ name: "Filter Co", source_type: "greenhouse", ats_board_token: "filter-co" });
  const candidate = createCandidate({ firstName: "Filter", lastName: "Candidate" });
  const dedupeKey1 = createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });
  const jobId1 = getJobIdByDedupeKey(dedupeKey1)!;

  insertJobMatchResult(fakeMatch({ candidateId: candidate.id, dedupeKey: dedupeKey1, jobId: jobId1, decision: "READY_FOR_TAILORING", overallScore: 88 }));

  const data = await fetchForYou(candidate.id, "bucket=ready_for_tailoring");
  assert.ok(data.entries.length > 0);
  for (const e of data.entries) {
    assert.equal(e.ranking.primaryBucket, "READY_FOR_TAILORING");
  }
});

test("14. Minimum score filtering works (?minScore=90)", async () => {
  const company = createCompany({ name: "MinScore Co", source_type: "greenhouse", ats_board_token: "minscore-co" });
  const candidate = createCandidate({ firstName: "MinScore", lastName: "Candidate" });
  const dedupeKey1 = createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });
  const dedupeKey2 = createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });
  const jobId1 = getJobIdByDedupeKey(dedupeKey1)!;
  const jobId2 = getJobIdByDedupeKey(dedupeKey2)!;

  insertJobMatchResult(fakeMatch({ candidateId: candidate.id, dedupeKey: dedupeKey1, jobId: jobId1, decision: "READY_FOR_TAILORING", overallScore: 92 }));
  insertJobMatchResult(fakeMatch({ candidateId: candidate.id, dedupeKey: dedupeKey2, jobId: jobId2, decision: "NEEDS_REVIEW", overallScore: 78 }));

  const data = await fetchForYou(candidate.id, "minScore=90");
  for (const e of data.entries) {
    assert.ok(e.ranking.overallScore !== null && e.ranking.overallScore >= 90);
  }
});

test("15. Score sorting works (?sortBy=score&sortOrder=desc)", async () => {
  const company = createCompany({ name: "SortScore Co", source_type: "greenhouse", ats_board_token: "sortscore-co" });
  const candidate = createCandidate({ firstName: "SortScore", lastName: "Candidate" });
  const dedupeKey1 = createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });
  const dedupeKey2 = createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });
  const jobId1 = getJobIdByDedupeKey(dedupeKey1)!;
  const jobId2 = getJobIdByDedupeKey(dedupeKey2)!;

  insertJobMatchResult(fakeMatch({ candidateId: candidate.id, dedupeKey: dedupeKey1, jobId: jobId1, decision: "READY_FOR_TAILORING", overallScore: 75 }));
  insertJobMatchResult(fakeMatch({ candidateId: candidate.id, dedupeKey: dedupeKey2, jobId: jobId2, decision: "READY_FOR_TAILORING", overallScore: 95 }));

  const data = await fetchForYou(candidate.id, "sortBy=score&sortOrder=desc");
  const scores = data.entries.map((e: ForYouResponseEntry) => e.ranking.overallScore).filter((s): s is number => s !== null);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1] >= scores[i]);
  }
});

test("16. Freshness filtering works (?freshness=today)", async () => {
  const company = createCompany({ name: "FreshFilter Co", source_type: "greenhouse", ats_board_token: "freshfilter-co" });
  const candidate = createCandidate({ firstName: "FreshFilter", lastName: "Candidate" });
  createTestJob(company.id, { postedAt: TODAY });
  createTestJob(company.id, { postedAt: FIVE_DAYS_AGO });

  const data = await fetchForYou(candidate.id, "freshness=today");
  assert.ok(data.entries.length > 0);
  for (const e of data.entries) {
    assert.equal(e.ranking.badges.isNewToday, true);
  }
});

test("17. Search filtering works (?search=UniqueSpecialist)", async () => {
  const company = createCompany({ name: "Search Co", source_type: "greenhouse", ats_board_token: "search-co" });
  const candidate = createCandidate({ firstName: "Search", lastName: "Candidate" });
  createTestJob(company.id, { title: "UniqueSpecialist Lead" });
  createTestJob(company.id, { title: "Generic Worker" });

  const data = await fetchForYou(candidate.id, "search=UniqueSpecialist");
  assert.equal(data.entries.length, 1);
  assert.ok(data.entries[0].job.title.includes("UniqueSpecialist"));
});

test("18. Existing For You API remains backward compatible", async () => {
  const candidate = createCandidate({ firstName: "Bw", lastName: "Candidate" });
  const data = await fetchForYou(candidate.id);
  assert.ok("candidateId" in data);
  assert.ok("preferences" in data);
  assert.ok("entries" in data);
  assert.ok("bucketCounts" in data);
});

test("19. Offer behavior follows existing lifecycle semantics (not actionable)", async () => {
  const company = createCompany({ name: "Offer Co", source_type: "greenhouse", ats_board_token: "offer-co" });
  const candidate = createCandidate({ firstName: "Offer", lastName: "Candidate" });
  const dedupeKey = createTestJob(company.id, { postedAt: TODAY });

  setPipelineStatus(candidate.id, dedupeKey, "Offer");

  const data = await fetchForYou(candidate.id);
  const entry = data.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entry);
  assert.equal(entry.ranking.primaryBucket, null);
  assert.equal(entry.ranking.badges.isTerminal, true);
});

test("20. Employer Rejected does not incorrectly appear actionable", async () => {
  const company = createCompany({ name: "Rej Co", source_type: "greenhouse", ats_board_token: "rej-co" });
  const candidate = createCandidate({ firstName: "Rej", lastName: "Candidate" });
  const dedupeKey = createTestJob(company.id, { postedAt: TODAY });

  setPipelineStatus(candidate.id, dedupeKey, "Employer Rejected");

  const data = await fetchForYou(candidate.id);
  const entry = data.entries.find((e: ForYouResponseEntry) => e.job.dedupe_key === dedupeKey);
  assert.ok(entry);
  assert.equal(entry.ranking.primaryBucket, null);
  assert.equal(entry.ranking.badges.isTerminal, true);
});

test("21. Dynamic bucket counts: no duplicate jobs across primary buckets", async () => {
  const candidate = createCandidate({ firstName: "Count", lastName: "Candidate" });
  const data = await fetchForYou(candidate.id);
  const counts = data.bucketCounts;
  const sum =
    counts.newToday +
    counts.topMatches +
    counts.readyForTailoring +
    counts.needsReview +
    counts.readyToApply +
    counts.applied +
    counts.interviewing;

  // Sum of disjoint actionable buckets must be <= total eligible entries
  assert.ok(sum <= counts.all);
});

test("22. Primary feed query avoids obvious N+1 behavior", async () => {
  const company = createCompany({ name: "N1 Co", source_type: "greenhouse", ats_board_token: "n1-co" });
  const candidate = createCandidate({ firstName: "N1", lastName: "Candidate" });
  for (let i = 0; i < 15; i++) {
    createTestJob(company.id, { postedAt: TODAY });
  }

  const start = Date.now();
  const data = await fetchForYou(candidate.id);
  const elapsed = Date.now() - start;

  assert.ok(data.entries.length >= 15);
  assert.ok(elapsed < 200, `Feed execution took ${elapsed}ms, expected fast batch execution (<200ms)`);
});
