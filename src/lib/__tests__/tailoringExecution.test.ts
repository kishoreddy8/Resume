import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import JSZip from "jszip";
import type { JobMatchResult } from "@/lib/match/types";
import { makePng } from "../../../tools/tailoring-engine/__tests__/pngFixture";
import { writeMasterResumeDocxFixture } from "../../../tools/tailoring-engine/__tests__/masterResumeFixture";

/**
 * Phase 3 Stage 5 — executeTailoringRun end-to-end tests. Isolated temp DB (CAREER_OPS_DB_PATH),
 * temp candidates dir (CAREER_OPS_CANDIDATES_DIR), and temp generated-artifacts dir
 * (CAREER_OPS_GENERATED_DIR, added this stage) — never touches data/app.db, data/candidates/**, or
 * data/generated/** on disk. No network access anywhere in this file.
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
let getTailoringRun: typeof import("@/db/queries/tailoringRuns").getTailoringRun;
let listTailoringRuns: typeof import("@/db/queries/tailoringRuns").listTailoringRuns;
let executeTailoringRun: typeof import("@/lib/tailoringExecution").executeTailoringRun;
let startTailoringRun: typeof import("@/lib/tailoringExecution").startTailoringRun;
let TailoringRunAuthorizationError: typeof import("@/lib/tailoringExecution").TailoringRunAuthorizationError;
let RENDERER_VERSION: number;

let candidateAId: number;
let candidateBId: number;
let companyId: number;
let jobOne: { id: number; dedupe_key: string };
let jobTwo: { id: number; dedupe_key: string };
let hashCounter = 0;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-tailoring-exec-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-tailoring-exec-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-tailoring-exec-generated-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  const { getDb } = await import("@/db/index");
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ setMarkedForTailoring } = await import("@/db/queries/candidateJobState"));
  ({ getTailoringRun, listTailoringRuns } = await import("@/db/queries/tailoringRuns"));
  ({ executeTailoringRun, startTailoringRun, TailoringRunAuthorizationError } = await import("@/lib/tailoringExecution"));
  ({ RENDERER_VERSION } = await import("../../../tools/tailoring-engine/constants"));
  getDb();

  candidateAId = createCandidate({ firstName: "Candidate", lastName: "A" }).id;
  candidateBId = createCandidate({ firstName: "Candidate", lastName: "B" }).id;

  companyId = createCompany({ name: "ExecTestCo", source_type: "greenhouse", ats_board_token: "exectestco" }).id;

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
        url: `https://boards.greenhouse.io/exectestco/${externalId}`,
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

/** Approves a candidate/job pair for tailoring — real Phase 2 match result + real approval context,
 *  exactly the state Stage 3's POST route (and this stage's startTailoringRun) requires. */
function approve(candidateId: number, job: { id: number; dedupe_key: string }) {
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
}

const VALID_RESUME = {
  name: "Fixture Candidate",
  tagline: "Senior Data Engineer",
  location: "Austin, TX",
  phone: "+1 (555) 010-0100",
  email: "fixture@example.com",
  linkedin: "linkedin.com/in/fixture",
  summary: ["A summary paragraph."],
  skillGroups: [{ label: "Core", items: ["SQL", "Python"] }],
  experience: [{ title: "Data Engineer", company: "Acme", dates: "2020 – Present", bullets: ["Did a thing."] }],
  education: ["B.S. Computer Science, State University"],
};

const VALID_COVER_LETTER = {
  name: "Fixture Candidate",
  location: "Austin, TX",
  phone: "+1 (555) 010-0100",
  email: "fixture@example.com",
  linkedin: "linkedin.com/in/fixture",
  salutation: "Dear Hiring Team,",
  paragraphs: ["A cover letter paragraph."],
  closing: "Best,",
};

test("1/7. successful execution: run is marked completed with a real output", async () => {
  approve(candidateAId, jobOne);
  const result = await executeTailoringRun({
    candidateId: candidateAId,
    jobId: jobOne.id,
    resume: VALID_RESUME,
    coverLetter: VALID_COVER_LETTER,
  });
  assert.equal(result.run.status, "completed");
  assert.ok(fs.existsSync(result.resumePath));
  assert.ok(fs.existsSync(result.coverLetterPath));
});

test("2. run receives the correct candidate_id", async () => {
  approve(candidateAId, jobOne);
  const result = await executeTailoringRun({ candidateId: candidateAId, jobId: jobOne.id, resume: VALID_RESUME, coverLetter: VALID_COVER_LETTER });
  assert.equal(result.run.candidate_id, candidateAId);
});

test("3. run receives the correct job identity (dedupe_key, not title/company/URL)", async () => {
  approve(candidateAId, jobOne);
  const result = await executeTailoringRun({ candidateId: candidateAId, jobId: jobOne.id, resume: VALID_RESUME, coverLetter: VALID_COVER_LETTER });
  assert.equal(result.run.dedupe_key, jobOne.dedupe_key);
});

test("4. artifact directory follows the candidate/jobHash/run hierarchy from Stage 4", async () => {
  approve(candidateAId, jobOne);
  const result = await executeTailoringRun({ candidateId: candidateAId, jobId: jobOne.id, resume: VALID_RESUME, coverLetter: VALID_COVER_LETTER });
  const expectedPattern = new RegExp(`candidates/${candidateAId}/jobs/[0-9a-f]{16}/runs/${result.run.id}/Resume\\.docx$`);
  assert.match(result.resumePath, expectedPattern);
});

test("5. RENDERER_VERSION is persisted on the executed run", async () => {
  approve(candidateAId, jobOne);
  const result = await executeTailoringRun({ candidateId: candidateAId, jobId: jobOne.id, resume: VALID_RESUME, coverLetter: VALID_COVER_LETTER });
  assert.equal(result.run.renderer_version, RENDERER_VERSION);
  assert.equal(RENDERER_VERSION, 2, "sanity check on the constant this test asserts against — bumped by Stage 31's layout change");
});

test("6/13. output_files contains only safe relative filenames, never absolute paths", async () => {
  approve(candidateAId, jobOne);
  const result = await executeTailoringRun({ candidateId: candidateAId, jobId: jobOne.id, resume: VALID_RESUME, coverLetter: VALID_COVER_LETTER });
  const outputFiles = JSON.parse(result.run.output_files!) as string[];
  assert.deepEqual(outputFiles, ["Resume.docx", "CoverLetter.docx"]);
  for (const f of outputFiles) {
    assert.equal(path.isAbsolute(f), false, `${f} must not be an absolute path`);
    assert.ok(!f.includes("/"), `${f} must not contain any directory component`);
  }
});

test("7. a successfully completed run has output_files, renderer_version, and the correct candidate/job relationship all set together", async () => {
  approve(candidateAId, jobOne);
  const result = await executeTailoringRun({ candidateId: candidateAId, jobId: jobOne.id, resume: VALID_RESUME, coverLetter: VALID_COVER_LETTER });
  assert.equal(result.run.status, "completed");
  assert.ok(result.run.output_files);
  assert.ok(result.run.renderer_version);
  assert.equal(result.run.candidate_id, candidateAId);
  assert.equal(result.run.dedupe_key, jobOne.dedupe_key);
});

test("8. generator failure (invalid content) marks the run failed, not stuck at started or falsely completed", async () => {
  approve(candidateAId, jobOne);
  const invalidResume = { ...VALID_RESUME, name: "" };
  await assert.rejects(
    () => executeTailoringRun({ candidateId: candidateAId, jobId: jobOne.id, resume: invalidResume, coverLetter: VALID_COVER_LETTER }),
    /resume\.name is required/
  );
  // The run WAS created (authorization succeeded) before the generator failed — find it and confirm
  // its terminal state is 'failed', with a useful failure_reason, never 'started' or 'completed'.
  const runs = listTailoringRuns(candidateAId, jobOne.dedupe_key);
  const failedRun = runs.find((r) => r.status === "failed" && r.failure_reason?.includes("resume.name is required"));
  assert.ok(failedRun, "expected a failed run recording the validation error");
  assert.notEqual(failedRun!.status, "started");
  assert.notEqual(failedRun!.status, "completed");
});

test("9. a failed new run does not corrupt or overwrite an earlier successful run's artifacts", async () => {
  approve(candidateAId, jobTwo);
  const successResult = await executeTailoringRun({ candidateId: candidateAId, jobId: jobTwo.id, resume: VALID_RESUME, coverLetter: VALID_COVER_LETTER });
  assert.equal(successResult.run.status, "completed");
  const successBytesBefore = fs.statSync(successResult.resumePath).size;

  approve(candidateAId, jobTwo); // re-approve for a second, independent run attempt
  const invalidResume = { ...VALID_RESUME, name: "" };
  await assert.rejects(() => executeTailoringRun({ candidateId: candidateAId, jobId: jobTwo.id, resume: invalidResume, coverLetter: VALID_COVER_LETTER }));

  assert.ok(fs.existsSync(successResult.resumePath), "the earlier successful run's Resume.docx must still exist");
  assert.equal(fs.statSync(successResult.resumePath).size, successBytesBefore, "the earlier successful run's file must be byte-for-byte unchanged");
  const stillCompleted = getTailoringRun(candidateAId, successResult.run.id)!;
  assert.equal(stillCompleted.status, "completed", "the earlier run's DB row must remain completed, untouched by the later failure");
});

test("10. different run IDs (repeated execution for the same candidate/job) use different directories", async () => {
  approve(candidateAId, jobOne);
  const run1 = await executeTailoringRun({ candidateId: candidateAId, jobId: jobOne.id, resume: VALID_RESUME, coverLetter: VALID_COVER_LETTER });
  approve(candidateAId, jobOne);
  const run2 = await executeTailoringRun({ candidateId: candidateAId, jobId: jobOne.id, resume: VALID_RESUME, coverLetter: VALID_COVER_LETTER });

  assert.notEqual(run1.run.id, run2.run.id);
  assert.notEqual(run1.resumePath, run2.resumePath);
  assert.ok(fs.existsSync(run1.resumePath), "run 1's artifact must still exist after run 2 executes");
  assert.ok(fs.existsSync(run2.resumePath));
});

test("11. candidate isolation: candidate A and candidate B executing the same job produce isolated runs/directories", async () => {
  approve(candidateAId, jobOne);
  approve(candidateBId, jobOne);
  const resultA = await executeTailoringRun({ candidateId: candidateAId, jobId: jobOne.id, resume: VALID_RESUME, coverLetter: VALID_COVER_LETTER });
  const resultB = await executeTailoringRun({ candidateId: candidateBId, jobId: jobOne.id, resume: VALID_RESUME, coverLetter: VALID_COVER_LETTER });

  assert.notEqual(resultA.resumePath, resultB.resumePath);
  assert.equal(resultA.run.candidate_id, candidateAId);
  assert.equal(resultB.run.candidate_id, candidateBId);
  // Candidate A cannot see Candidate B's run via the candidate-scoped query layer.
  assert.equal(getTailoringRun(candidateAId, resultB.run.id), undefined);
});

test("12. job isolation: the same candidate executing two different jobs produces isolated runs/directories", async () => {
  approve(candidateAId, jobOne);
  approve(candidateAId, jobTwo);
  const resultX = await executeTailoringRun({ candidateId: candidateAId, jobId: jobOne.id, resume: VALID_RESUME, coverLetter: VALID_COVER_LETTER });
  const resultY = await executeTailoringRun({ candidateId: candidateAId, jobId: jobTwo.id, resume: VALID_RESUME, coverLetter: VALID_COVER_LETTER });

  assert.notEqual(resultX.resumePath, resultY.resumePath);
  assert.notEqual(resultX.run.dedupe_key, resultY.run.dedupe_key);
});

test("14. no path traversal is possible through the execution flow — candidateId/jobId are always numeric, dedupe_key is server-derived, never client path input", async () => {
  approve(candidateAId, jobOne);
  const result = await executeTailoringRun({ candidateId: candidateAId, jobId: jobOne.id, resume: VALID_RESUME, coverLetter: VALID_COVER_LETTER });
  const resolvedGeneratedRoot = path.resolve(tmpGeneratedDir) + path.sep;
  assert.ok(
    path.resolve(result.resumePath).startsWith(resolvedGeneratedRoot),
    "the executed run's artifact must resolve inside the generated-artifact root, never escape it"
  );
});

test("15. a candidate whose Master Resume has an embedded certification badge gets that exact image preserved in the real, fully-executed output", async () => {
  approve(candidateAId, jobOne);
  // approve()'s writeProfile() already created data/candidates/<id>/master/ — this adds the one
  // thing it doesn't: a real resume.docx with an embedded image, exactly what a real candidate's
  // upload through /api/master-files would leave on disk.
  const masterResumePath = path.join(tmpCandidatesDir, String(candidateAId), "master", "resume.docx");
  const badge = makePng(120, 60, [12, 76, 138]);
  await writeMasterResumeDocxFixture(masterResumePath, [{ bytes: badge, width: 40, height: 20 }]);

  const result = await executeTailoringRun({
    candidateId: candidateAId,
    jobId: jobOne.id,
    resume: { ...VALID_RESUME, certifications: ["Microsoft Certified: Azure Data Engineer Associate (DP-203)"] },
    coverLetter: VALID_COVER_LETTER,
  });
  assert.equal(result.run.status, "completed");

  const zip = await JSZip.loadAsync(fs.readFileSync(result.resumePath));
  const mediaFiles = Object.keys(zip.files).filter((f) => /^word\/media\//.test(f) && !f.endsWith("/"));
  assert.equal(mediaFiles.length, 1, "the executed run's real output must contain exactly the one preserved badge image");
  const embedded = await zip.file(mediaFiles[0])!.async("nodebuffer");
  assert.ok(embedded.equals(badge), "the badge preserved through the full executeTailoringRun path must be byte-identical to the Master Resume's own embedded image");
});

test("startTailoringRun: rejects a nonexistent/inactive candidate before creating any run row", () => {
  assert.throws(
    () => startTailoringRun({ candidateId: 999999, jobId: jobOne.id }),
    (err: unknown) => err instanceof TailoringRunAuthorizationError && err.code === "NOT_ACTIVE_CANDIDATE"
  );
});

test("startTailoringRun: rejects a nonexistent job before creating any run row", () => {
  assert.throws(
    () => startTailoringRun({ candidateId: candidateAId, jobId: 999999 }),
    (err: unknown) => err instanceof TailoringRunAuthorizationError && err.code === "JOB_NOT_FOUND"
  );
});

test("startTailoringRun: rejects when the job is not marked for tailoring", () => {
  assert.throws(
    () => startTailoringRun({ candidateId: candidateBId, jobId: jobTwo.id }),
    (err: unknown) => err instanceof TailoringRunAuthorizationError && err.code === "NOT_MARKED_FOR_TAILORING"
  );
});

test("startTailoringRun: rejects a stale approval (Phase 2 decision changed since approval) and never creates a run", () => {
  writeProfile(candidateBId, "resume-b-stale", "skills-b-stale");
  insertJobMatchResult(
    fakeResult({ candidateId: candidateBId, jobId: jobTwo.id, dedupeKey: jobTwo.dedupe_key, candidateProfileHash: "resume-b-stale:skills-b-stale", decision: "NEEDS_REVIEW" })
  );
  setMarkedForTailoring(candidateBId, jobTwo.dedupe_key, true, { approvalType: "NEEDS_REVIEW_OVERRIDE", decision: "NEEDS_REVIEW" });
  // Phase 2 re-evaluates to a different decision.
  insertJobMatchResult(
    fakeResult({ candidateId: candidateBId, jobId: jobTwo.id, dedupeKey: jobTwo.dedupe_key, candidateProfileHash: "resume-b-stale:skills-b-stale", decision: "BLOCKED" })
  );

  const before = listTailoringRuns(candidateBId, jobTwo.dedupe_key).length;
  assert.throws(
    () => startTailoringRun({ candidateId: candidateBId, jobId: jobTwo.id }),
    (err: unknown) => err instanceof TailoringRunAuthorizationError && err.code === "STALE_APPROVAL"
  );
  const after = listTailoringRuns(candidateBId, jobTwo.dedupe_key).length;
  assert.equal(after, before, "a stale approval must never create a new run row");

  setMarkedForTailoring(candidateBId, jobTwo.dedupe_key, false);
});
