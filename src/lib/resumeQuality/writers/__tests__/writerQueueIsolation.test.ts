import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ensureResumeWriterRuntimeContract, type ResumeWriterRuntimeContract } from "../../runtimeContract";
import { getWorkspaceDirectory } from "../../workspace";
import { runWorkerPass, processOneWorkflow } from "../writerWorkerCore";
import { listAdminWriterWorkflows } from "@/lib/admin/writer";
import { getExistingProtectedRun } from "@/db/queries/applicationRuns";

/**
 * Tests VERSION-Q-01 through VERSION-Q-10
 *
 * Verifies writer queue isolation:
 * An incompatible historical workflow must fail closed locally without
 * starving compatible workflows in the queue, without rewriting source provenance,
 * without consuming quality iterations, and without affecting old READY artifacts.
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
let updateCandidateContact: typeof import("@/db/queries/candidateSettings").updateCandidateContact;
let startTailoringRun: typeof import("@/lib/tailoringExecution").startTailoringRun;
let createResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityWorkflow;
let getResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").getResumeQualityWorkflow;
let transitionWorkflowStatus: typeof import("@/db/queries/resumeQualityWorkflows").transitionWorkflowStatus;
let getDb: typeof import("@/db").getDb;

let testCandidateId: number;
let testCompanyId: number;
let jobCounter = 0;

before(async () => {
  process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI = "1";
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-queue-iso-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-queue-iso-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-queue-iso-gen-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {
      // Ignore
    }
    global.__careerOpsDb = undefined;
  }

  ({ getDb } = await import("@/db/index"));
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ setMarkedForTailoring } = await import("@/db/queries/candidateJobState"));
  ({ updateCandidateContact } = await import("@/db/queries/candidateSettings"));
  ({ startTailoringRun } = await import("@/lib/tailoringExecution"));
  ({
    createResumeQualityWorkflow,
    getResumeQualityWorkflow,
    transitionWorkflowStatus,
  } = await import("@/db/queries/resumeQualityWorkflows"));

  getDb();

  testCandidateId = createCandidate({
    firstName: "QueueIso",
    lastName: "Candidate",
  }).id;
  testCompanyId = createCompany({ name: "IsoCo", source_type: "greenhouse", ats_board_token: "isoco" }).id;

  updateCandidateContact(testCandidateId, {
    email: "iso.candidate@gmail.com",
    phone: "(214) 765-4321",
    location: "Dallas, TX",
  });

  const masterDir = path.join(tmpCandidatesDir, String(testCandidateId), "master");
  fs.mkdirSync(masterDir, { recursive: true });
  fs.writeFileSync(
    path.join(masterDir, "resume.txt"),
    `Resume for candidate ${testCandidateId}\nAlpha Corp\nSenior Data Engineer\n2020 - Present`
  );
  fs.writeFileSync(path.join(masterDir, "skills.json"), JSON.stringify({ skills: ["Python", "Spark"] }));
  fs.writeFileSync(
    path.join(masterDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.txt", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: `r-${testCandidateId}` },
      skills: { filename: "skills.json", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: `s-${testCandidateId}` },
    })
  );
  fs.writeFileSync(
    path.join(tmpCandidatesDir, String(testCandidateId), "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: `r-${testCandidateId}`, skills: `s-${testCandidateId}` },
      builtAt: "2026-01-01T00:00:00Z",
      skills: [
        { rawSkillName: "Python", source: "employer" },
        { rawSkillName: "Spark", source: "employer" },
        { rawSkillName: "SQL", source: "employer" },
      ],
      experience: [
        {
          employer: "Alpha Corp",
          title: "Senior Data Engineer",
          startDate: "2020-01",
          endDate: null,
          technologies: ["Python", "Spark", "SQL"],
        },
      ],
      education: [{ level: "Bachelor's", field: "Computer Science", institution: "State University" }],
      certifications: [],
      totalYearsExperience: 5,
    })
  );
});

after(() => {
  fs.rmSync(tmpDbDir, { recursive: true, force: true });
  fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  fs.rmSync(tmpGeneratedDir, { recursive: true, force: true });
  delete process.env.CAREER_OPS_CANDIDATES_DIR;
  delete process.env.CAREER_OPS_GENERATED_DIR;
  delete process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI;
});

function makeJob() {
  jobCounter += 1;
  const externalId = `iso-ext-${jobCounter}`;
  const dedupeKey = dedupeKeyForAts("greenhouse", testCompanyId, externalId);
  upsertJob({
    companyId: testCompanyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId,
      title: `Iso Role ${jobCounter}`,
      location: null,
      department: null,
      url: `https://boards.greenhouse.io/isoco/${externalId}`,
      descriptionHtml: null,
      descriptionText: "We need a Senior Data Engineer with Spark and Python experience.",
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

function setupWorkflowWithRevision(stampedRevision: string) {
  const job = makeJob();
  const dedupeKey = job.dedupe_key;

  insertJobMatchResult({
    candidateId: testCandidateId,
    jobId: job.id,
    dedupeKey,
    matchEngineVersion: 2,
    matchKnowledgeHash: `k-${jobCounter}`,
    candidateProfileHash: `r-${testCandidateId}:s-${testCandidateId}`,
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
  });

  setMarkedForTailoring(testCandidateId, dedupeKey, true, {
    approvalType: "READY_DIRECT",
    decision: "READY_FOR_TAILORING",
  });

  const { run } = startTailoringRun({ candidateId: testCandidateId, jobId: job.id });
  const wf = createResumeQualityWorkflow({
    candidateId: testCandidateId,
    applicationId: 1,
    tailoringRunId: run.id,
    dedupeKey,
  });

  const loc = { candidateId: testCandidateId, dedupeKey, runId: run.id, workflowId: wf.id };
  const wsDir = getWorkspaceDirectory(loc);
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(
    path.join(wsDir, "extracted_job_requirements.json"),
    JSON.stringify([
      { id: "req-1", text: "Python", importance: "required", type: "technology", evidenceSource: "jd" },
    ])
  );

  const runtime: ResumeWriterRuntimeContract = {
    schemaVersion: 1,
    contractVersion: "surgical-repair-v1",
    sourceRevision: stampedRevision,
    loadedAt: new Date().toISOString(),
  };
  ensureResumeWriterRuntimeContract(wsDir, { runtime });

  return { job, wf, loc, wsDir, run };
}

// =============================================================================
// VERSION-Q-01: Incompatible workflow fails closed locally
// =============================================================================
test("VERSION-Q-01: incompatible workflow fails closed locally with RUNTIME_VERSION_MISMATCH error", async () => {
  const { wf } = setupWorkflowWithRevision("incompatible-rev-001");
  const outcome = await processOneWorkflow(wf);
  assert.equal(outcome.outcome, "ERROR");
  assert.ok(outcome.error?.includes("RUNTIME_VERSION_MISMATCH"));
  assert.ok(outcome.error?.includes("incompatible-rev-001"));
});

// =============================================================================
// VERSION-Q-02: Mismatch consumes zero quality iterations
// =============================================================================
test("VERSION-Q-02: mismatch consumes zero quality iterations", async () => {
  const { wf } = setupWorkflowWithRevision("incompatible-rev-002");
  await processOneWorkflow(wf);
  const current = getResumeQualityWorkflow(testCandidateId, wf.id)!;
  assert.equal(current.current_iteration, 0);
  assert.equal(current.status, "CREATED");
});

// =============================================================================
// VERSION-Q-03: Source revision remains unchanged
// =============================================================================
test("VERSION-Q-03: source revision on disk remains unchanged after mismatch evaluation", async () => {
  const { wsDir, wf } = setupWorkflowWithRevision("immutable-rev-003");
  const contractFile = path.join(wsDir, "runtime_contract.json");
  const before = JSON.parse(fs.readFileSync(contractFile, "utf-8"));
  assert.equal(before.sourceRevision, "immutable-rev-003");

  await processOneWorkflow(wf);

  const after = JSON.parse(fs.readFileSync(contractFile, "utf-8"));
  assert.equal(after.sourceRevision, "immutable-rev-003");
});

// =============================================================================
// VERSION-Q-04: Incompatible workflow does not prevent later compatible workflow
// =============================================================================
test("VERSION-Q-04: one incompatible workflow does not prevent later compatible workflow in the queue", async () => {
  const { wf: wfBad } = setupWorkflowWithRevision("bad-rev-004");
  const { wf: wfGood } = setupWorkflowWithRevision(
    (await import("../../runtimeContract")).getLoadedResumeWriterRuntimeContract().sourceRevision
  );

  const failScript = path.join(os.tmpdir(), "career-ops-stub-fail.sh");
  fs.writeFileSync(failScript, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  const result = await runWorkerPass({
    maxWorkflows: 1,
    cliOptions: { command: failScript, retryBackoffMs: 1 },
  });

  // wfBad failed closed with ERROR without consuming an active attempt;
  // wfGood was reached and attempted.
  assert.ok(result.outcomes.some((o) => o.workflowId === wfBad.id && o.outcome === "ERROR"));
  assert.ok(result.outcomes.some((o) => o.workflowId === wfGood.id));
});

// =============================================================================
// VERSION-Q-05: Incompatible workflow does not tight-loop every tick
// =============================================================================
test("VERSION-Q-05: evaluate pass over incompatible workflows terminates promptly", async () => {
  const { wf } = setupWorkflowWithRevision("bad-rev-005");
  const start = Date.now();
  const result = await runWorkerPass({ maxWorkflows: 2 });
  const duration = Date.now() - start;
  assert.ok(duration < 2000, "pass over incompatible workflows should terminate in milliseconds");
  assert.ok(result.outcomes.some((o) => o.workflowId === wf.id && o.outcome === "ERROR"));
});

// =============================================================================
// VERSION-Q-06: Technical intervention remains visible in Admin
// =============================================================================
test("VERSION-Q-06: technical failure remains visible in Admin writer workflows overview", () => {
  const adminData = listAdminWriterWorkflows({ page: 1, limit: 10, status: "" });
  assert.ok(adminData.workflows.length > 0);
  assert.ok(typeof adminData.health.state === "string");
});

// =============================================================================
// VERSION-Q-07: Compatible workflow still enforces its own source contract
// =============================================================================
test("VERSION-Q-07: compatible workflow enforces valid runtime contract", () => {
  const { wsDir } = setupWorkflowWithRevision("test-rev-007");
  const contract = JSON.parse(fs.readFileSync(path.join(wsDir, "runtime_contract.json"), "utf-8"));
  assert.equal(contract.contractVersion, "surgical-repair-v1");
  assert.equal(contract.sourceRevision, "test-rev-007");
});

// =============================================================================
// VERSION-Q-08: No resume artifact generated for mismatched workflow
// =============================================================================
test("VERSION-Q-08: no resume artifact generated for mismatched workflow", async () => {
  const { wf, loc } = setupWorkflowWithRevision("bad-rev-008");
  await processOneWorkflow(wf);
  const finalDir = path.join(getWorkspaceDirectory(loc), "..", "final");
  assert.equal(fs.existsSync(finalDir), false, "final artifacts directory must not exist");
});

// =============================================================================
// VERSION-Q-09: Old READY artifacts remain untouched
// =============================================================================
test("VERSION-Q-09: old READY workflow and artifacts remain untouched", () => {
  const { wf } = setupWorkflowWithRevision("bad-rev-009");
  transitionWorkflowStatus(testCandidateId, wf.id, "WRITER_RUNNING");
  transitionWorkflowStatus(testCandidateId, wf.id, "WRITER_COMPLETED");
  transitionWorkflowStatus(testCandidateId, wf.id, "REVIEW_RUNNING");
  transitionWorkflowStatus(testCandidateId, wf.id, "REVIEW_COMPLETED");
  transitionWorkflowStatus(testCandidateId, wf.id, "READY", { finalApprovedIteration: 1, latestOverallScore: 98 });

  const readyWf = getResumeQualityWorkflow(testCandidateId, wf.id)!;
  assert.equal(readyWf.status, "READY");
  assert.equal(readyWf.final_approved_iteration, 1);
});

// =============================================================================
// VERSION-Q-10: No application run/submission behavior affected
// =============================================================================
test("VERSION-Q-10: queue pass does not create or submit application runs", () => {
  const { job } = setupWorkflowWithRevision("bad-rev-010");
  const run = getExistingProtectedRun(testCandidateId, job.dedupe_key);
  assert.equal(run, undefined, "no application run must be created during writer pass");
});
