import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { JobMatchResult } from "@/lib/match/types";

/**
 * Phase 3 Stage 6 — execution bridge tests. Isolated temp DB/candidates/generated directories, same
 * as Stage 5's own tests. No network access. runTailoringBridge() is exercised directly for most
 * cases (fast, in-process); one real CLI subprocess smoke test (see the bottom of this file) proves
 * the actual `npx tsx execute-run.ts ...` invocation works end-to-end.
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;
let tmpGeneratedDir: string;
let tmpContentDir: string;

let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let insertJobMatchResult: typeof import("@/db/queries/jobMatches").insertJobMatchResult;
let setMarkedForTailoring: typeof import("@/db/queries/candidateJobState").setMarkedForTailoring;
let getTailoringRun: typeof import("@/db/queries/tailoringRuns").getTailoringRun;
let listTailoringRuns: typeof import("@/db/queries/tailoringRuns").listTailoringRuns;
let runTailoringBridge: typeof import("../execute-run").runTailoringBridge;
let RENDERER_VERSION: number;

let candidateAId: number;
let candidateBId: number;
let companyId: number;
let jobOne: { id: number; dedupe_key: string };
let jobTwo: { id: number; dedupe_key: string };
let hashCounter = 0;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-bridge-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-bridge-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-bridge-generated-"));
  tmpContentDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-bridge-content-"));
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
  ({ runTailoringBridge } = await import("../execute-run"));
  ({ RENDERER_VERSION } = await import("../constants"));
  getDb();

  candidateAId = createCandidate({ firstName: "Candidate", lastName: "A" }).id;
  candidateBId = createCandidate({ firstName: "Candidate", lastName: "B" }).id;

  companyId = createCompany({ name: "BridgeTestCo", source_type: "greenhouse", ats_board_token: "bridgetestco" }).id;

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
        url: `https://boards.greenhouse.io/bridgetestco/${externalId}`,
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
  fs.rmSync(tmpContentDir, { recursive: true, force: true });
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

const VALID_CONTENT = {
  resume: {
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
  },
  coverLetter: {
    name: "Fixture Candidate",
    location: "Austin, TX",
    phone: "+1 (555) 010-0100",
    email: "fixture@example.com",
    linkedin: "linkedin.com/in/fixture",
    salutation: "Dear Hiring Team,",
    paragraphs: ["A cover letter paragraph."],
    closing: "Best,",
  },
};

let contentFileCounter = 0;
function writeContentFile(content: unknown): string {
  contentFileCounter += 1;
  const filePath = path.join(tmpContentDir, `content-${contentFileCounter}.json`);
  fs.writeFileSync(filePath, JSON.stringify(content));
  return filePath;
}

test("1/2/3. valid structured input: the bridge calls Stage 5 execution and produces a real tailoring run", async () => {
  approve(candidateAId, jobOne);
  const inputPath = writeContentFile(VALID_CONTENT);
  const result = await runTailoringBridge({ candidateId: candidateAId, jobId: jobOne.id, inputPath });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  const run = getTailoringRun(candidateAId, result.runId)!;
  assert.equal(run.status, "completed");
});

test("4. candidateId is propagated correctly onto the created run", async () => {
  approve(candidateAId, jobOne);
  const inputPath = writeContentFile(VALID_CONTENT);
  const result = await runTailoringBridge({ candidateId: candidateAId, jobId: jobOne.id, inputPath });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.candidateId, candidateAId);
  assert.equal(getTailoringRun(candidateAId, result.runId)!.candidate_id, candidateAId);
});

test("5. jobId is propagated correctly (run's dedupe_key matches the target job)", async () => {
  approve(candidateAId, jobOne);
  const inputPath = writeContentFile(VALID_CONTENT);
  const result = await runTailoringBridge({ candidateId: candidateAId, jobId: jobOne.id, inputPath });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(getTailoringRun(candidateAId, result.runId)!.dedupe_key, jobOne.dedupe_key);
});

test("6. runId is returned", async () => {
  approve(candidateAId, jobOne);
  const inputPath = writeContentFile(VALID_CONTENT);
  const result = await runTailoringBridge({ candidateId: candidateAId, jobId: jobOne.id, inputPath });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.ok(Number.isInteger(result.runId) && result.runId > 0);
});

test("7. RENDERER_VERSION is returned and persisted", async () => {
  approve(candidateAId, jobOne);
  const inputPath = writeContentFile(VALID_CONTENT);
  const result = await runTailoringBridge({ candidateId: candidateAId, jobId: jobOne.id, inputPath });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.rendererVersion, RENDERER_VERSION);
  assert.equal(getTailoringRun(candidateAId, result.runId)!.renderer_version, RENDERER_VERSION);
});

test("8/18. outputFiles remain relative — never absolute paths", async () => {
  approve(candidateAId, jobOne);
  const inputPath = writeContentFile(VALID_CONTENT);
  const result = await runTailoringBridge({ candidateId: candidateAId, jobId: jobOne.id, inputPath });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.deepEqual(result.outputFiles, ["Resume.docx", "CoverLetter.docx"]);
  for (const f of result.outputFiles) {
    assert.equal(path.isAbsolute(f), false);
    assert.ok(!f.includes(path.sep));
  }
  const dbRow = getTailoringRun(candidateAId, result.runId)!;
  const dbOutputFiles = JSON.parse(dbRow.output_files!) as string[];
  for (const f of dbOutputFiles) assert.equal(path.isAbsolute(f), false, "output_files persisted in the DB must never contain an absolute path");
});

test("9. candidate/job/run artifact isolation remains intact through the bridge", async () => {
  approve(candidateAId, jobOne);
  approve(candidateBId, jobOne);
  approve(candidateAId, jobTwo);

  const resultA1 = await runTailoringBridge({ candidateId: candidateAId, jobId: jobOne.id, inputPath: writeContentFile(VALID_CONTENT) });
  const resultB1 = await runTailoringBridge({ candidateId: candidateBId, jobId: jobOne.id, inputPath: writeContentFile(VALID_CONTENT) });
  const resultA2 = await runTailoringBridge({ candidateId: candidateAId, jobId: jobTwo.id, inputPath: writeContentFile(VALID_CONTENT) });
  assert.equal(resultA1.status, "completed");
  assert.equal(resultB1.status, "completed");
  assert.equal(resultA2.status, "completed");
  if (resultA1.status !== "completed" || resultB1.status !== "completed" || resultA2.status !== "completed") return;

  assert.notEqual(resultA1.artifactDirectory, resultB1.artifactDirectory, "candidate isolation");
  assert.notEqual(resultA1.artifactDirectory, resultA2.artifactDirectory, "job isolation");
  assert.match(resultA1.artifactDirectory, new RegExp(`candidates/${candidateAId}/jobs/[0-9a-f]{16}/runs/${resultA1.runId}$`));
});

test("10. malformed input (missing resume/coverLetter) is rejected before any execution", async () => {
  approve(candidateAId, jobOne);
  const inputPath = writeContentFile({ resume: VALID_CONTENT.resume }); // coverLetter missing entirely
  const before = listTailoringRuns(candidateAId, jobOne.dedupe_key).length;
  const result = await runTailoringBridge({ candidateId: candidateAId, jobId: jobOne.id, inputPath });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.errorType, "INVALID_INPUT");
  assert.equal(listTailoringRuns(candidateAId, jobOne.dedupe_key).length, before, "malformed input must never create a run");
});

test("10b. malformed input (unparseable JSON file) is rejected before any execution", async () => {
  const badPath = path.join(tmpContentDir, "bad.json");
  fs.writeFileSync(badPath, "{ this is not valid json");
  const result = await runTailoringBridge({ candidateId: candidateAId, jobId: jobOne.id, inputPath: badPath });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.errorType, "INVALID_INPUT");
});

test("11. an invalid/nonexistent candidate is rejected, no run created", async () => {
  const inputPath = writeContentFile(VALID_CONTENT);
  const result = await runTailoringBridge({ candidateId: 999999, jobId: jobOne.id, inputPath });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.errorType, "AUTHORIZATION_FAILURE");
  assert.equal(result.errorCode, "NOT_ACTIVE_CANDIDATE");
});

test("12. a job that is not marked for tailoring is rejected, no run created", async () => {
  const inputPath = writeContentFile(VALID_CONTENT);
  const before = listTailoringRuns(candidateBId, jobTwo.dedupe_key).length;
  const result = await runTailoringBridge({ candidateId: candidateBId, jobId: jobTwo.id, inputPath });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.errorType, "AUTHORIZATION_FAILURE");
  assert.equal(result.errorCode, "NOT_MARKED_FOR_TAILORING");
  assert.equal(listTailoringRuns(candidateBId, jobTwo.dedupe_key).length, before);
});

test("13. a stale Phase 2 approval is rejected, no run created", async () => {
  writeProfile(candidateBId, "resume-b-stale", "skills-b-stale");
  insertJobMatchResult(
    fakeResult({ candidateId: candidateBId, jobId: jobTwo.id, dedupeKey: jobTwo.dedupe_key, candidateProfileHash: "resume-b-stale:skills-b-stale", decision: "NEEDS_REVIEW" })
  );
  setMarkedForTailoring(candidateBId, jobTwo.dedupe_key, true, { approvalType: "NEEDS_REVIEW_OVERRIDE", decision: "NEEDS_REVIEW" });
  insertJobMatchResult(
    fakeResult({ candidateId: candidateBId, jobId: jobTwo.id, dedupeKey: jobTwo.dedupe_key, candidateProfileHash: "resume-b-stale:skills-b-stale", decision: "BLOCKED" })
  );

  const inputPath = writeContentFile(VALID_CONTENT);
  const before = listTailoringRuns(candidateBId, jobTwo.dedupe_key).length;
  const result = await runTailoringBridge({ candidateId: candidateBId, jobId: jobTwo.id, inputPath });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.errorCode, "STALE_APPROVAL");
  assert.equal(listTailoringRuns(candidateBId, jobTwo.dedupe_key).length, before);

  setMarkedForTailoring(candidateBId, jobTwo.dedupe_key, false);
});

test("14/15. generator failure (invalid content that passes the envelope check) marks the run failed, never stuck at started", async () => {
  approve(candidateAId, jobOne);
  const invalidContent = { resume: { ...VALID_CONTENT.resume, name: "" }, coverLetter: VALID_CONTENT.coverLetter };
  const inputPath = writeContentFile(invalidContent);
  const result = await runTailoringBridge({ candidateId: candidateAId, jobId: jobOne.id, inputPath });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.errorType, "EXECUTION_FAILURE");

  const runs = listTailoringRuns(candidateAId, jobOne.dedupe_key);
  const failedRun = runs.find((r) => r.status === "failed" && r.failure_reason?.includes("resume.name is required"));
  assert.ok(failedRun);
  assert.notEqual(failedRun!.status, "started");
});

test("16. a failed run through the bridge does not corrupt an earlier successful run's artifacts", async () => {
  approve(candidateAId, jobTwo);
  const successResult = await runTailoringBridge({ candidateId: candidateAId, jobId: jobTwo.id, inputPath: writeContentFile(VALID_CONTENT) });
  assert.equal(successResult.status, "completed");
  if (successResult.status !== "completed") return;
  const resumePath = path.join(successResult.artifactDirectory, "Resume.docx");
  const bytesBefore = fs.statSync(resumePath).size;

  approve(candidateAId, jobTwo);
  const invalidContent = { resume: { ...VALID_CONTENT.resume, name: "" }, coverLetter: VALID_CONTENT.coverLetter };
  const failResult = await runTailoringBridge({ candidateId: candidateAId, jobId: jobTwo.id, inputPath: writeContentFile(invalidContent) });
  assert.equal(failResult.status, "failed");

  assert.ok(fs.existsSync(resumePath));
  assert.equal(fs.statSync(resumePath).size, bytesBefore);
  assert.equal(getTailoringRun(candidateAId, successResult.runId)!.status, "completed");
});

test("17. the bridge never uses the legacy data/generated/<company>/<jobId>/ path", async () => {
  approve(candidateAId, jobOne);
  const result = await runTailoringBridge({ candidateId: candidateAId, jobId: jobOne.id, inputPath: writeContentFile(VALID_CONTENT) });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.ok(!result.artifactDirectory.includes("bridgetestco"), "must not resolve to the legacy company-slug directory");
  assert.match(result.artifactDirectory, /candidates\/\d+\/jobs\/[0-9a-f]{16}\/runs\/\d+$/);
});

// --- CLI subprocess smoke test (section 14) ------------------------------------------------------

test("CLI smoke test: npx tsx execute-run.ts end-to-end against isolated fixtures", () => {
  approve(candidateAId, jobOne);
  const inputPath = writeContentFile(VALID_CONTENT);
  const scriptPath = path.join(__dirname, "..", "execute-run.ts");

  const stdout = execFileSync(
    "npx",
    ["tsx", scriptPath, "--candidate-id", String(candidateAId), "--job-id", String(jobOne.id), "--input", inputPath, "--executed-by", "claude-code"],
    {
      cwd: path.join(__dirname, "..", "..", ".."),
      env: {
        ...process.env,
        CAREER_OPS_DB_PATH: process.env.CAREER_OPS_DB_PATH,
        CAREER_OPS_CANDIDATES_DIR: process.env.CAREER_OPS_CANDIDATES_DIR,
        CAREER_OPS_GENERATED_DIR: process.env.CAREER_OPS_GENERATED_DIR,
      },
      encoding: "utf-8",
    }
  );

  assert.match(stdout, /"status": "completed"/);
  assert.match(stdout, /"outputFiles"/);
  assert.match(stdout, /Artifact directory:/);

  const runIdMatch = stdout.match(/"runId": (\d+)/);
  assert.ok(runIdMatch, "CLI output must include a runId");
  const run = getTailoringRun(candidateAId, Number(runIdMatch![1]));
  assert.ok(run, "the run the CLI reported must actually exist in the DB");
  assert.equal(run!.status, "completed");
});
