import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { CoverLetterContent, ResumeContent } from "../../../../../tools/tailoring-engine/types";
import type { PatchWriterOutput } from "../../types";

let tmpDbDir: string;
let tmpCandidatesDir: string;
let tmpGeneratedDir: string;
let tmpFixturesDir: string;

let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let insertJobMatchResult: typeof import("@/db/queries/jobMatches").insertJobMatchResult;
let setMarkedForTailoring: typeof import("@/db/queries/candidateJobState").setMarkedForTailoring;
let createTailoringRun: typeof import("@/db/queries/tailoringRuns").createTailoringRun;
let createResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityWorkflow;
let executeResumeQualityIteration: typeof import("../../orchestrator").executeResumeQualityIteration;
let getWorkspaceDirectory: typeof import("../../workspace").getWorkspaceDirectory;
let getHandoffDirectory: typeof import("../../workspace").getHandoffDirectory;
let exportExternalWriterPackage: typeof import("../../handoff/exporter").exportExternalWriterPackage;
let importExternalWriterResult: typeof import("../../handoff/importer").importExternalWriterResult;
let buildPatchContext: typeof import("../../handoff/importer").buildPatchContext;
let loadPatchContextFromHandoff: typeof import("../../handoff/importer").loadPatchContextFromHandoff;
let listRuns: typeof import("@/db/queries/applicationRuns").listRuns;

let testCandidateId: number;
let companyId: number;
let job: { id: number; dedupe_key: string };
let testApplicationId: number;
let testTailoringRunId: number;

function unit(overrides: Partial<RequirementUnit>): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: [],
    categories: [],
    label: "requirement",
    requirementLevel: "Required",
    criticality: "REQUIRED",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    requestedYears: null,
    fromUnclaimedText: false,
    ...overrides,
  };
}

const STRONG_REQUIREMENTS: RequirementUnit[] = [
  unit({ memberSkillNames: ["Azure"], label: "Azure" }),
  unit({ memberSkillNames: ["Azure Data Factory"], label: "Azure Data Factory" }),
  unit({ memberSkillNames: ["Databricks"], label: "Databricks" }),
];

function sampleResume(name: string): ResumeContent {
  return {
    name,
    tagline: "Senior Data Engineer",
    location: "San Francisco, CA",
    phone: "415-555-0199",
    email: "test.candidate@gmail.com",
    summary: ["Experienced Senior Data Engineer specializing in Azure Data Factory and Databricks pipelines."],
    skillGroups: [{ label: "Data Engineering", items: ["Azure Data Factory", "Databricks", "Python", "SQL"] }],
    experience: [
      {
        title: "Senior Data Engineer",
        company: "Tech Corp",
        dates: "2021 - Present",
        location: "San Francisco, CA",
        bullets: [
          "Engineered ETL pipelines in Azure Data Factory.",
          "Implemented transformation logic in Databricks.",
        ],
      },
    ],
    education: [
      "B.S. in Computer Science, University of California, 2018",
    ],
  };
}

function sampleCoverLetter(): CoverLetterContent {
  return {
    name: "Alex Taylor",
    location: "San Francisco, CA",
    phone: "415-555-0199",
    email: "test.candidate@gmail.com",
    salutation: "Dear Hiring Team,",
    paragraphs: [
      "I am writing to express my strong interest in the Senior Data Engineer role.",
      "My background in Azure Data Factory and Databricks aligns well with your team's needs.",
    ],
    closing: "Sincerely,\nAlex Taylor",
  };
}

function masterProfile(): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "r-hash", skills: "s-hash" },
    builtAt: "2026-01-01T00:00:00Z",
    skills: [],
    experience: [
      {
        employer: "Tech Corp",
        title: "Senior Data Engineer",
        startDate: "2021-01",
        endDate: null,
        technologies: ["Azure Data Factory", "Databricks", "Python", "SQL"],
      },
    ],
    education: [{ level: "Bachelor's", field: "Computer Science", institution: "University of California" }],
    certifications: [],
    totalYearsExperience: 5,
  };
}

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-patchctx-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-patchctx-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-patchctx-gen-"));
  tmpFixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-patchctx-fix-"));

  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {
      /* ignore */
    }
    global.__careerOpsDb = undefined;
  }

  const { getDb } = await import("@/db/index");
  getDb();

  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ setMarkedForTailoring } = await import("@/db/queries/candidateJobState"));
  ({ createTailoringRun } = await import("@/db/queries/tailoringRuns"));
  ({ createResumeQualityWorkflow } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ executeResumeQualityIteration } = await import("../../orchestrator"));
  ({ getWorkspaceDirectory, getHandoffDirectory } = await import("../../workspace"));
  ({ exportExternalWriterPackage } = await import("../../handoff/exporter"));
  ({
    importExternalWriterResult,
    buildPatchContext,
    loadPatchContextFromHandoff,
  } = await import("../../handoff/importer"));
  ({ listRuns } = await import("@/db/queries/applicationRuns"));

  const cand = createCandidate({
    firstName: "Alex",
    lastName: "Taylor",
  });
  testCandidateId = cand.id;

  const comp = createCompany({ name: "Target Tech Inc", source_type: "greenhouse" });
  companyId = comp.id;

  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, "9901");
  upsertJob({
    companyId: companyId,
    sourceType: "greenhouse",
    dedupeKey: dedupeKey,
    job: {
      externalId: "9901",
      title: "Senior Data Engineer",
      location: "Remote",
      department: null,
      url: "https://example.com/jobs/9901",
      descriptionHtml: null,
      descriptionText: "Looking for a Senior Data Engineer with strong Azure Data Factory and Databricks experience.",
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
  const fetchedJob = getJobByDedupeKey(dedupeKey)!;
  job = { id: fetchedJob.id, dedupe_key: dedupeKey };

  // Set candidate profile with master resume
  const candDir = path.join(tmpCandidatesDir, String(testCandidateId));
  fs.mkdirSync(candDir, { recursive: true });
  fs.writeFileSync(
    path.join(candDir, "candidate-profile.json"),
    JSON.stringify(masterProfile())
  );

  insertJobMatchResult({
    candidateId: testCandidateId,
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    matchEngineVersion: 2,
    matchKnowledgeHash: "k-patchctx",
    candidateProfileHash: "p-patchctx",
    candidateSettingsHash: "settings-hash",
    jdContentHash: "jd-hash",
    computedAt: "2026-01-01T00:00:00Z",
    eligibility: { status: "PASS", reasons: [], sponsorship: { signal: "not_applicable", note: "n/a" } },
    dimensionScores: { roleAlignment: null, required: 95, preferred: 95, experience: 95, seniority: 95 },
    overallScore: 95,
    requirementCoverage: 0.95,
    employerEvidencedShare: 0.95,
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

  const state = setMarkedForTailoring(testCandidateId, job.dedupe_key, true, {
    approvalType: "READY_DIRECT",
    decision: "READY_FOR_TAILORING",
  });
  testApplicationId = state.id;

  const run = createTailoringRun({
    candidateId: testCandidateId,
    dedupeKey: job.dedupe_key,
    jobId: job.id,
    approvalType: "READY_DIRECT",
    decisionAtApproval: "READY_FOR_TAILORING",
    approvedAt: new Date().toISOString(),
    matchEngineVersion: 2,
    recommendedTrack: "Data Engineer",
    selectedTrack: "Data Engineer",
    methodologyVersion: 2,
    rendererVersion: 2,
    executedBy: "test",
  });
  testTailoringRunId = run.id;
});

after(() => {
  fs.rmSync(tmpDbDir, { recursive: true, force: true });
  fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  fs.rmSync(tmpGeneratedDir, { recursive: true, force: true });
  fs.rmSync(tmpFixturesDir, { recursive: true, force: true });
});

test("PATCHCTX-01 writerWorkerCore PATCH output receives valid patchContext from handoff", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: testCandidateId,
    applicationId: testApplicationId,
    tailoringRunId: testTailoringRunId,
    dedupeKey: job.dedupe_key,
    maxIterations: 3,
  });

  const loc = { candidateId: testCandidateId, dedupeKey: job.dedupe_key, runId: testTailoringRunId, workflowId: wf.id };

  // Seed extracted_job_requirements in workspace
  const wsDir = getWorkspaceDirectory(loc);
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "extracted_job_requirements.json"), JSON.stringify(STRONG_REQUIREMENTS, null, 2));

  // Run iteration 1 through orchestrator to generate real review with corrections
  const resume1 = sampleResume("Alex Taylor");
  resume1.summary = ["Summary needing refinement."]; // will trigger corrections
  await executeResumeQualityIteration({
    candidateId: testCandidateId,
    workflowId: wf.id,
    resume: resume1,
    coverLetter: sampleCoverLetter(),
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  // Export iteration 2 handoff
  const exportRes = exportExternalWriterPackage({
    candidateId: testCandidateId,
    workflowId: wf.id,
    targetIterationNumber: 2,
  });

  const loadedCtx = loadPatchContextFromHandoff(exportRes.handoffDirectory);
  assert.ok(loadedCtx, "Expected patchContext to be loaded from handoffDir");
  assert.equal(loadedCtx.baselineResume.name, "Alex Taylor");
  assert.ok(loadedCtx.editablePaths.length > 0);
});

test("PATCHCTX-02 baseline resume is the correct previous iteration content", () => {
  const resume = sampleResume("Alex Taylor");
  const ctx = buildPatchContext({
    currentResume: resume,
    repairPlan: { editablePaths: ["resume.summary[0]"] },
  });
  assert.ok(ctx);
  assert.deepEqual(ctx.baselineResume, resume);
});

test("PATCHCTX-03 baseline cover letter is correctly populated when present", () => {
  const resume = sampleResume("Alex Taylor");
  const cover = sampleCoverLetter();
  const ctx = buildPatchContext({
    currentResume: resume,
    currentCoverLetter: cover,
    repairPlan: { editablePaths: ["resume.summary[0]"] },
  });
  assert.ok(ctx);
  assert.deepEqual(ctx.baselineCoverLetter, cover);
});

test("PATCHCTX-04 editablePaths are preserved in patchContext", () => {
  const resume = sampleResume("Alex Taylor");
  const paths = ["resume.summary[0]", "resume.skillGroups"];
  const ctx = buildPatchContext({
    currentResume: resume,
    repairPlan: { editablePaths: paths },
  });
  assert.ok(ctx);
  assert.deepEqual(ctx.editablePaths, paths);
});

test("PATCHCTX-05 PATCH import succeeds when context is valid", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: testCandidateId,
    applicationId: testApplicationId,
    tailoringRunId: testTailoringRunId,
    dedupeKey: job.dedupe_key,
    maxIterations: 3,
  });

  const resume = sampleResume("Alex Taylor");
  const cover = sampleCoverLetter();
  const patchPayload: PatchWriterOutput = {
    schemaVersion: 2,
    outputMode: "PATCH",
    candidateId: testCandidateId,
    workflowId: wf.id,
    applicationId: testApplicationId,
    jobId: job.id,
    tailoringRunId: testTailoringRunId,
    iterationNumber: 1,
    operations: [
      {
        document: "resume",
        path: "summary[0]",
        replacement: "Senior Data Engineer specializing in scalable Azure Data Factory and Databricks solutions.",
      },
    ],
  };

  const importRes = importExternalWriterResult({
    candidateId: testCandidateId,
    workflowId: wf.id,
    expectedIterationNumber: 1,
    parsedOutput: patchPayload,
    patchContext: {
      baselineResume: resume,
      baselineCoverLetter: cover,
      editablePaths: ["resume.summary[0]"],
    },
  });

  assert.ok(importRes.validated);
  assert.equal(
    importRes.writerOutput.resume.summary[0],
    "Senior Data Engineer specializing in scalable Azure Data Factory and Databricks solutions."
  );
});

test("PATCHCTX-06 missing baseline or patchContext still fails closed with PATCH_CONTEXT_MISSING", () => {
  const wf = createResumeQualityWorkflow({
    candidateId: testCandidateId,
    applicationId: testApplicationId,
    tailoringRunId: testTailoringRunId,
    dedupeKey: job.dedupe_key,
    maxIterations: 3,
  });

  const patchPayload: PatchWriterOutput = {
    schemaVersion: 2,
    outputMode: "PATCH",
    candidateId: testCandidateId,
    workflowId: wf.id,
    applicationId: testApplicationId,
    jobId: job.id,
    tailoringRunId: testTailoringRunId,
    iterationNumber: 1,
    operations: [],
  };

  assert.throws(
    () => {
      importExternalWriterResult({
        candidateId: testCandidateId,
        workflowId: wf.id,
        expectedIterationNumber: 1,
        parsedOutput: patchPayload,
      });
    },
    (err: any) => {
      return err.code === "PATCH_CONTEXT_MISSING";
    }
  );
});

test("PATCHCTX-07 full-rewrite mode remains unchanged and succeeds without patchContext", () => {
  const wf = createResumeQualityWorkflow({
    candidateId: testCandidateId,
    applicationId: testApplicationId,
    tailoringRunId: testTailoringRunId,
    dedupeKey: job.dedupe_key,
    maxIterations: 3,
  });

  const resume = sampleResume("Alex Taylor");
  const fullPayload = {
    schemaVersion: 1,
    candidateId: testCandidateId,
    workflowId: wf.id,
    applicationId: testApplicationId,
    jobId: job.id,
    tailoringRunId: testTailoringRunId,
    iterationNumber: 1,
    resume,
  };

  const importRes = importExternalWriterResult({
    candidateId: testCandidateId,
    workflowId: wf.id,
    expectedIterationNumber: 1,
    parsedOutput: fullPayload,
  });

  assert.ok(importRes.validated);
  assert.equal(importRes.writerOutput.resume.name, "Alex Taylor");
});

test("PATCHCTX-08 externalFileResumeWriter and writerWorkerCore use the same buildPatchContext contract", () => {
  const resume = sampleResume("Alex Taylor");
  const input = {
    candidateId: testCandidateId,
    workflowId: 99,
    tailoringRunId: 1,
    dedupeKey: job.dedupe_key,
    currentResume: resume,
    repairPlan: { editablePaths: ["resume.summary[0]"] },
  };

  const ctx = buildPatchContext(input);
  assert.ok(ctx);
  assert.equal(ctx.baselineResume, resume);
  assert.deepEqual(ctx.editablePaths, ["resume.summary[0]"]);
});

test("PATCHCTX-09 empty or missing editablePaths returns undefined patchContext", () => {
  const resume = sampleResume("Alex Taylor");
  assert.equal(buildPatchContext(null), undefined);
  assert.equal(buildPatchContext({ currentResume: resume }), undefined);
  assert.equal(buildPatchContext({ currentResume: resume, repairPlan: { editablePaths: [] } }), undefined);
});

test("PATCHCTX-10 no application runs are created or modified during patch context operations", () => {
  const runs = listRuns(testCandidateId);
  assert.equal(runs.length, 0, "Expected 0 application runs");
});
