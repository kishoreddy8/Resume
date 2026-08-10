import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import type { JobMatchResult } from "@/lib/match/types";

/**
 * Tests src/app/api/candidates/[candidateId]/jobs/[jobId]/tailoring-runs/[runId]/route.ts (PATCH)
 * via a relative import from OUTSIDE the bracketed route directories — see tailoringRunsRoute.test.ts's
 * doc comment for why (Node's test runner glob-matches `[...]` path segments as character classes).
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;

let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let insertJobMatchResult: typeof import("@/db/queries/jobMatches").insertJobMatchResult;
let getLatestJobMatchResult: typeof import("@/db/queries/jobMatches").getLatestJobMatchResult;
let setMarkedForTailoring: typeof import("@/db/queries/candidateJobState").setMarkedForTailoring;
let setPipelineStatus: typeof import("@/db/queries/candidateJobState").setPipelineStatus;
let getCandidateJobState: typeof import("@/db/queries/candidateJobState").getCandidateJobState;
let POST: typeof import("../[candidateId]/jobs/[jobId]/tailoring-runs/route").POST;
let PATCH: typeof import("../[candidateId]/jobs/[jobId]/tailoring-runs/[runId]/route").PATCH;

let candidateAId: number;
let candidateBId: number;
let companyId: number;
let jobOne: { id: number; dedupe_key: string };
let jobTwo: { id: number; dedupe_key: string };
let hashCounter = 0;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-tailoring-runs-patch-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-tailoring-runs-patch-candidates-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;

  const { getDb } = await import("@/db/index");
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ insertJobMatchResult, getLatestJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ setMarkedForTailoring, setPipelineStatus, getCandidateJobState } = await import("@/db/queries/candidateJobState"));
  ({ POST } = await import("../[candidateId]/jobs/[jobId]/tailoring-runs/route"));
  ({ PATCH } = await import("../[candidateId]/jobs/[jobId]/tailoring-runs/[runId]/route"));
  getDb();

  candidateAId = createCandidate({ firstName: "Candidate", lastName: "A" }).id;
  candidateBId = createCandidate({ firstName: "Candidate", lastName: "B" }).id;

  companyId = createCompany({ name: "PatchTestCo", source_type: "greenhouse", ats_board_token: "patchtestco" }).id;

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
        url: `https://boards.greenhouse.io/patchtestco/${externalId}`,
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
  delete process.env.CAREER_OPS_CANDIDATES_DIR;
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
    dimensionScores: { required: 90, preferred: 50, experience: 100, seniority: 100 },
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
    ...overrides,
  };
}

/** Approves and starts ('started' status) a fresh run for a candidate/job pair via the real POST
 *  route — every PATCH test starts from a real, route-created run, not a hand-built fixture. */
async function approveAndStartRun(candidateId: number, job: { id: number; dedupe_key: string }) {
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

  const req = new NextRequest(`http://localhost/api/candidates/${candidateId}/jobs/${job.id}/tailoring-runs`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  const res = await POST(req, { params: Promise.resolve({ candidateId: String(candidateId), jobId: String(job.id) }) });
  assert.equal(res.status, 201, "fixture setup: starting a run must succeed");
  const { run } = await res.json();
  return run as { id: number; dedupe_key: string };
}

function callPATCH(candidateId: number, jobId: number, runId: number, body: unknown) {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateId}/jobs/${jobId}/tailoring-runs/${runId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return PATCH(req, { params: Promise.resolve({ candidateId: String(candidateId), jobId: String(jobId), runId: String(runId) }) });
}

test("11. Candidate B cannot PATCH Candidate A's run (cross-candidate rejected with 404)", async () => {
  const run = await approveAndStartRun(candidateAId, jobOne);
  const res = await callPATCH(candidateBId, jobOne.id, run.id, { status: "completed", validationPassed: true });
  assert.equal(res.status, 404);
});

test("12. a run started under job one cannot be PATCHed via job two's URL (cross-job rejected with 404)", async () => {
  const run = await approveAndStartRun(candidateAId, jobOne);
  const res = await callPATCH(candidateAId, jobTwo.id, run.id, { status: "completed", validationPassed: true });
  assert.equal(res.status, 404);
});

test("13. started -> completed succeeds", async () => {
  const run = await approveAndStartRun(candidateAId, jobOne);
  const res = await callPATCH(candidateAId, jobOne.id, run.id, {
    status: "completed",
    validationPassed: true,
    outputFiles: ["Resume.docx", "CoverLetter.docx"],
    jobFitClassification: "STRONG APPLY",
  });
  assert.equal(res.status, 200);
  const { run: updated } = await res.json();
  assert.equal(updated.status, "completed");
  assert.deepEqual(JSON.parse(updated.output_files), ["Resume.docx", "CoverLetter.docx"]);
  assert.equal(updated.validation_passed, 1);
  assert.equal(updated.job_fit_classification, "STRONG APPLY");
});

test("14. started -> failed succeeds", async () => {
  const run = await approveAndStartRun(candidateAId, jobOne);
  const res = await callPATCH(candidateAId, jobOne.id, run.id, { status: "failed", failureReason: "engine validation failed" });
  assert.equal(res.status, 200);
  const { run: updated } = await res.json();
  assert.equal(updated.status, "failed");
  assert.equal(updated.failure_reason, "engine validation failed");
});

test("15. a completed run cannot be PATCHed again (409, immutable)", async () => {
  const run = await approveAndStartRun(candidateAId, jobOne);
  const first = await callPATCH(candidateAId, jobOne.id, run.id, { status: "completed", validationPassed: true });
  assert.equal(first.status, 200);
  const second = await callPATCH(candidateAId, jobOne.id, run.id, { status: "completed", validationPassed: true });
  assert.equal(second.status, 409);
  const third = await callPATCH(candidateAId, jobOne.id, run.id, { status: "failed", failureReason: "too late" });
  assert.equal(third.status, 409);
});

test("16. a failed run cannot be PATCHed again (409, immutable)", async () => {
  const run = await approveAndStartRun(candidateAId, jobOne);
  const first = await callPATCH(candidateAId, jobOne.id, run.id, { status: "failed", failureReason: "first failure" });
  assert.equal(first.status, 200);
  const second = await callPATCH(candidateAId, jobOne.id, run.id, { status: "failed", failureReason: "second failure" });
  assert.equal(second.status, 409);
  const third = await callPATCH(candidateAId, jobOne.id, run.id, { status: "completed", validationPassed: true });
  assert.equal(third.status, 409);
});

test("17. absolute paths and '..' path traversal in output_files are rejected with 400, and never mutate the run", async () => {
  const run = await approveAndStartRun(candidateAId, jobOne);
  for (const badFile of ["/etc/passwd", "../secrets.txt", "subdir/../../escape.txt", ".."]) {
    const res = await callPATCH(candidateAId, jobOne.id, run.id, {
      status: "completed",
      validationPassed: true,
      outputFiles: [badFile],
    });
    assert.equal(res.status, 400, `expected 400 for output file "${badFile}"`);
  }
  // None of the rejected attempts should have mutated the run — it must still be startable/completable cleanly.
  const finalRes = await callPATCH(candidateAId, jobOne.id, run.id, { status: "completed", validationPassed: true, outputFiles: ["Resume.docx"] });
  assert.equal(finalRes.status, 200, "a legitimate relative filename must still succeed after prior traversal attempts were rejected");
});

test("18. completing/failing tailoring runs never write to job_match_results — Phase 2 stays authoritative", async () => {
  const run = await approveAndStartRun(candidateAId, jobTwo);
  const before = getLatestJobMatchResult(candidateAId, jobTwo.dedupe_key);
  await callPATCH(candidateAId, jobTwo.id, run.id, { status: "completed", validationPassed: true });
  const after = getLatestJobMatchResult(candidateAId, jobTwo.dedupe_key);
  assert.deepEqual(before, after, "job_match_results must be byte-for-byte unchanged by tailoring-run completion");
});

test("19. tailoring-run PATCH never touches candidate_job_state.pipeline_status", async () => {
  setPipelineStatus(candidateAId, jobTwo.dedupe_key, "Applied");
  const beforeState = getCandidateJobState(candidateAId, jobTwo.dedupe_key)!;
  assert.equal(beforeState.pipeline_status, "Applied");

  // approveAndStartRun re-marks candidate_job_state for tailoring, but must not touch pipeline_status.
  const run = await approveAndStartRun(candidateAId, jobTwo);
  await callPATCH(candidateAId, jobTwo.id, run.id, { status: "completed", validationPassed: true });

  const afterState = getCandidateJobState(candidateAId, jobTwo.dedupe_key)!;
  assert.equal(afterState.pipeline_status, "Applied", "pipeline_status must remain exactly what it was before any tailoring-run activity");
});
