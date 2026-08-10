import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import type { JobMatchResult } from "@/lib/match/types";

/**
 * Tests src/app/api/candidates/[candidateId]/jobs/[jobId]/tailoring-runs/route.ts (GET + POST) via
 * a relative import from OUTSIDE the bracketed route directory — Node's test runner treats `[...]`
 * in a file path argument as a glob character class, so a test file that physically lived inside
 * .../[candidateId]/.../__tests__/ would silently match zero files under `npm test`'s glob-based
 * runner. Mirrors forYouProtection.test.ts's existing "test from the non-bracketed __tests__ dir,
 * import the bracketed route with a relative path" pattern exactly.
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;

let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let archiveCandidate: typeof import("@/db/queries/candidates").archiveCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let insertJobMatchResult: typeof import("@/db/queries/jobMatches").insertJobMatchResult;
let setMarkedForTailoring: typeof import("@/db/queries/candidateJobState").setMarkedForTailoring;
let GET: typeof import("../[candidateId]/jobs/[jobId]/tailoring-runs/route").GET;
let POST: typeof import("../[candidateId]/jobs/[jobId]/tailoring-runs/route").POST;

let candidateAId: number;
let candidateBId: number;
let companyId: number;
let job: { id: number; dedupe_key: string };
let hashCounter = 0;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-tailoring-runs-route-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-tailoring-runs-route-candidates-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;

  const { getDb } = await import("@/db/index");
  ({ createCandidate, archiveCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ setMarkedForTailoring } = await import("@/db/queries/candidateJobState"));
  ({ GET, POST } = await import("../[candidateId]/jobs/[jobId]/tailoring-runs/route"));
  getDb();

  candidateAId = createCandidate({ firstName: "Candidate", lastName: "A" }).id;
  candidateBId = createCandidate({ firstName: "Candidate", lastName: "B" }).id;

  companyId = createCompany({ name: "RouteTestCo", source_type: "greenhouse", ats_board_token: "routetestco" }).id;
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
      url: "https://boards.greenhouse.io/routetestco/ext-1",
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

function callGET(candidateId: number, jobId: number) {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateId}/jobs/${jobId}/tailoring-runs`);
  return GET(req, { params: Promise.resolve({ candidateId: String(candidateId), jobId: String(jobId) }) });
}

function callPOST(candidateId: number, jobId: number, body: unknown = {}) {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateId}/jobs/${jobId}/tailoring-runs`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ candidateId: String(candidateId), jobId: String(jobId) }) });
}

test("1. active candidate GET succeeds, returns empty history initially", async () => {
  const res = await callGET(candidateAId, job.id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.runs, []);
});

test("2. a nonexistent candidate is rejected with 404", async () => {
  const res = await callGET(999999, job.id);
  assert.equal(res.status, 404);
});

test("2b. an archived candidate is rejected with 404", async () => {
  const archivedId = createCandidate({ firstName: "Archived", lastName: "One" }).id;
  archiveCandidate(archivedId);
  const res = await callGET(archivedId, job.id);
  assert.equal(res.status, 404);
});

test("3. Candidate A's tailoring runs are invisible to Candidate B's GET on the same job", async () => {
  writeProfile(candidateAId, "resume-a", "skills-a");
  insertJobMatchResult(
    fakeResult({
      candidateId: candidateAId,
      jobId: job.id,
      dedupeKey: job.dedupe_key,
      candidateProfileHash: "resume-a:skills-a",
      decision: "READY_FOR_TAILORING",
    })
  );
  setMarkedForTailoring(candidateAId, job.dedupe_key, true, { approvalType: "READY_DIRECT", decision: "READY_FOR_TAILORING" });
  const postRes = await callPOST(candidateAId, job.id);
  assert.equal(postRes.status, 201);

  const bRes = await callGET(candidateBId, job.id);
  assert.equal(bRes.status, 200);
  const bBody = await bRes.json();
  assert.deepEqual(bBody.runs, [], "Candidate B must see zero runs for a job only Candidate A has tailored");

  const aRes = await callGET(candidateAId, job.id);
  const aBody = await aRes.json();
  assert.equal(aBody.runs.length, 1);
});

test("4. a candidateId in the POST body is ignored — the path segment is always authoritative", async () => {
  // Candidate B has no approval context recorded. If the route trusted a body-supplied candidateId
  // over the path, sending candidateId=B in the body while POSTing to Candidate A's path would either
  // succeed against B's (missing) approval and fail, or incorrectly authorize under A's approval for
  // B. Either way, asserting the result is scoped to A (the path) proves the path wins.
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAId}/jobs/${job.id}/tailoring-runs`, {
    method: "POST",
    body: JSON.stringify({ candidateId: candidateBId }),
  });
  const res = await POST(req, { params: Promise.resolve({ candidateId: String(candidateAId), jobId: String(job.id) }) });
  assert.equal(res.status, 201, "must succeed using the path's candidateId (A, approved), ignoring the body's candidateId (B, unapproved)");
  const { run } = await res.json();
  assert.equal(run.candidate_id, candidateAId);
});

test("5. POST rejects when the job is not marked for tailoring", async () => {
  const res = await callPOST(candidateBId, job.id);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /not marked for tailoring/i);
});

test("6. POST rejects when marked for tailoring but missing approval context", async () => {
  setMarkedForTailoring(candidateBId, job.dedupe_key, true);
  const res = await callPOST(candidateBId, job.id);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /no recorded approval context/i);
  setMarkedForTailoring(candidateBId, job.dedupe_key, false);
});

test("7. READY_DIRECT approval type is only valid when paired with READY_FOR_TAILORING", async () => {
  setMarkedForTailoring(candidateBId, job.dedupe_key, true, { approvalType: "READY_DIRECT", decision: "NEEDS_REVIEW" });
  const res = await callPOST(candidateBId, job.id);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /not compatible/i);
  setMarkedForTailoring(candidateBId, job.dedupe_key, false);
});

test("8. NEEDS_REVIEW_OVERRIDE approval type is only valid when paired with NEEDS_REVIEW", async () => {
  setMarkedForTailoring(candidateBId, job.dedupe_key, true, { approvalType: "NEEDS_REVIEW_OVERRIDE", decision: "READY_FOR_TAILORING" });
  const res = await callPOST(candidateBId, job.id);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /not compatible/i);
  setMarkedForTailoring(candidateBId, job.dedupe_key, false);
});

test("9. a stale approval (Phase 2 decision changed since approval) is rejected — old approval must not authorize a new run", async () => {
  writeProfile(candidateBId, "resume-b", "skills-b");
  insertJobMatchResult(
    fakeResult({
      candidateId: candidateBId,
      jobId: job.id,
      dedupeKey: job.dedupe_key,
      candidateProfileHash: "resume-b:skills-b",
      decision: "NEEDS_REVIEW",
    })
  );
  setMarkedForTailoring(candidateBId, job.dedupe_key, true, { approvalType: "NEEDS_REVIEW_OVERRIDE", decision: "NEEDS_REVIEW" });

  // Phase 2 re-evaluates to a different decision — a brand-new row for the same dedupe_key.
  insertJobMatchResult(
    fakeResult({
      candidateId: candidateBId,
      jobId: job.id,
      dedupeKey: job.dedupe_key,
      candidateProfileHash: "resume-b:skills-b",
      decision: "BLOCKED",
    })
  );

  const res = await callPOST(candidateBId, job.id);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /stale/i);
  assert.equal(body.approvedDecision, "NEEDS_REVIEW");
  assert.equal(body.currentDecision, "BLOCKED");

  setMarkedForTailoring(candidateBId, job.dedupe_key, false);
});

test("10. POST derives all identity/provenance fields server-side, ignoring any client-submitted overrides", async () => {
  writeProfile(candidateBId, "resume-b-fresh", "skills-b-fresh");
  insertJobMatchResult(
    fakeResult({
      candidateId: candidateBId,
      jobId: job.id,
      dedupeKey: job.dedupe_key,
      candidateProfileHash: "resume-b-fresh:skills-b-fresh",
      jdContentHash: "jd-hash-real",
      matchEngineVersion: 2,
      recommendedTrack: "Data Engineer",
      decision: "READY_FOR_TAILORING",
    })
  );
  setMarkedForTailoring(candidateBId, job.dedupe_key, true, { approvalType: "READY_DIRECT", decision: "READY_FOR_TAILORING" });

  const req = new NextRequest(`http://localhost/api/candidates/${candidateBId}/jobs/${job.id}/tailoring-runs`, {
    method: "POST",
    body: JSON.stringify({
      candidateId: 999999,
      dedupeKey: "attacker-supplied",
      masterResumeHash: "attacker-hash",
      masterSkillsHash: "attacker-hash",
      candidateProfileHash: "attacker-hash",
      jdContentHash: "attacker-hash",
      matchEngineVersion: 999,
      recommendedTrack: "attacker-track",
      selectedTrack: "Data Engineer",
      executedBy: "claude-code",
    }),
  });
  const res = await POST(req, { params: Promise.resolve({ candidateId: String(candidateBId), jobId: String(job.id) }) });
  assert.equal(res.status, 201);
  const { run } = await res.json();

  assert.equal(run.candidate_id, candidateBId);
  assert.equal(run.dedupe_key, job.dedupe_key);
  assert.equal(run.master_resume_hash, "resume-b-fresh");
  assert.equal(run.master_skills_hash, "skills-b-fresh");
  assert.equal(run.candidate_profile_hash, "resume-b-fresh:skills-b-fresh");
  assert.equal(run.jd_content_hash, "jd-hash-real");
  assert.equal(run.match_engine_version, 2);
  assert.equal(run.recommended_track, "Data Engineer");
  // selectedTrack/executedBy ARE genuinely client-selected fields — those pass through as given.
  assert.equal(run.selected_track, "Data Engineer");
  assert.equal(run.executed_by, "claude-code");

  setMarkedForTailoring(candidateBId, job.dedupe_key, false);
});
