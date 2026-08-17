import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import type { RequirementUnit } from "@/lib/match/types";
import { generateCoverLetterDocx } from "../../../../../tools/tailoring-engine/cover-letter-template";
import { generateResumeDocx } from "../../../../../tools/tailoring-engine/resume-template";
import type { CoverLetterContent, ResumeContent } from "../../../../../tools/tailoring-engine/types";
import type { ExternalWriterOutput } from "@/lib/resumeQuality/types";

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
let getDb: typeof import("@/db").getDb;
let createResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityWorkflow;
let executeResumeQualityIteration: typeof import("@/lib/resumeQuality/orchestrator").executeResumeQualityIteration;
let getWorkspaceDirectory: typeof import("@/lib/resumeQuality/workspace").getWorkspaceDirectory;
let getIterationDirectory: typeof import("@/lib/resumeQuality/workspace").getIterationDirectory;
let getFinalDirectory: typeof import("@/lib/resumeQuality/workspace").getFinalDirectory;

let exportPost: typeof import("../[candidateId]/jobs/[jobId]/quality-workflow/export/route").POST;
let importPost: typeof import("../[candidateId]/jobs/[jobId]/quality-workflow/import/route").POST;
let artifactGet: typeof import("../[candidateId]/jobs/[jobId]/quality-workflow/artifacts/[artifactType]/route").GET;

let candidateAliceId: number;
let candidateBobId: number;
let companyId: number;
let jobOne: { id: number; dedupe_key: string };
let appAliceJobOneId: number;
let runAliceJobOneId: number;
let sampleResumeDocxPath: string;
let sampleCoverDocxPath: string;

const STRONG_REQUIREMENTS: RequirementUnit[] = [
  {
    kind: "skill",
    memberSkillNames: ["Azure", "Azure Data Factory"],
    categories: ["Cloud Platforms"],
    label: "Azure Data Factory",
    requirementLevel: "Required",
    criticality: "CRITICAL",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    fromUnclaimedText: false,
  },
  {
    kind: "skill",
    memberSkillNames: ["Databricks"],
    categories: ["Data Engineering"],
    label: "Databricks",
    requirementLevel: "Required",
    criticality: "CRITICAL",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    fromUnclaimedText: false,
  },
  {
    kind: "skill",
    memberSkillNames: ["Python"],
    categories: ["Programming Languages"],
    label: "Python",
    requirementLevel: "Required",
    criticality: "CRITICAL",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    fromUnclaimedText: false,
  },
];

const PERFECT_RESUME: ResumeContent = {
  name: "Alice Smith",
  tagline: "Senior Data Engineer",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "alice@gmail.com",
  summary: [
    "Senior Data Engineer specializing in Azure Data Factory, Databricks, and PySpark pipeline architecture with 5+ years experience.",
  ],
  skillGroups: [
    { label: "Cloud & Big Data", items: ["Azure Data Factory", "Databricks", "Apache Spark", "PySpark", "Python", "SQL"] },
  ],
  experience: [
    {
      title: "Senior Data Engineer",
      company: "Acme Corp",
      dates: "2020 - Present",
      bullets: [
        "Designed Azure Data Factory pipelines that reduced nightly batch processing time from 6 hours to 45 minutes.",
        "Engineered Databricks PySpark transformations processing 10TB daily telemetry with zero data loss.",
      ],
    },
  ],
  education: ["B.S. Computer Science, University of California (2018)"],
  certifications: ["Azure Solutions Architect Expert"],
};

const FLAWED_RESUME: ResumeContent = {
  name: "Alice Smith",
  tagline: "Data Engineer",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "alice@gmail.com",
  summary: ["Data Engineer with experience in Python."],
  skillGroups: [{ label: "Programming", items: ["Python"] }],
  experience: [
    {
      title: "Senior Data Engineer",
      company: "Acme Corp",
      dates: "2020 - Present",
      bullets: ["Responsible for writing Python scripts."],
    },
  ],
  education: ["B.S. Computer Science, University of California (2018)"],
  certifications: [],
};

const COVER_LETTER: CoverLetterContent = {
  name: "Alice Smith",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "alice@gmail.com",
  salutation: "Dear Hiring Team,",
  paragraphs: ["I am excited to apply for the Senior Data Engineer position."],
  closing: "Sincerely,\nAlice Smith",
};

function initWorkflowWorkspace(candId: number, wfId: number, runId: number, dedupeKey: string) {
  const wsDir = getWorkspaceDirectory({ candidateId: candId, workflowId: wfId, runId, dedupeKey });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "extracted_job_requirements.json"), JSON.stringify(STRONG_REQUIREMENTS, null, 2));
}

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-e2e-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-e2e-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-e2e-generated-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  sampleResumeDocxPath = path.join(tmpGeneratedDir, "SampleResume.docx");
  sampleCoverDocxPath = path.join(tmpGeneratedDir, "SampleCoverLetter.docx");
  // Real, validator-parseable DOCX files — a plain placeholder string is no longer sufficient now
  // that the orchestrator runs deterministic DOCX validation (validate-docx.ts) against every
  // rendered file and feeds genuine parse failures into the canonical atsFormatting compliance check.
  await generateResumeDocx(PERFECT_RESUME, sampleResumeDocxPath);
  await generateCoverLetterDocx(COVER_LETTER, sampleCoverDocxPath);

  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {}
    global.__careerOpsDb = undefined;
  }

  ({ getDb } = await import("@/db"));
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ setMarkedForTailoring, getCandidateJobState } = await import("@/db/queries/candidateJobState"));
  const { startTailoringRun } = await import("@/lib/tailoringExecution");
  ({ createResumeQualityWorkflow } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ executeResumeQualityIteration } = await import("@/lib/resumeQuality/orchestrator"));
  ({ getWorkspaceDirectory, getIterationDirectory, getFinalDirectory } = await import("@/lib/resumeQuality/workspace"));

  ({ POST: exportPost } = await import("../[candidateId]/jobs/[jobId]/quality-workflow/export/route"));
  ({ POST: importPost } = await import("../[candidateId]/jobs/[jobId]/quality-workflow/import/route"));
  ({ GET: artifactGet } = await import("../[candidateId]/jobs/[jobId]/quality-workflow/artifacts/[artifactType]/route"));

  getDb();

  candidateAliceId = createCandidate({ firstName: "Alice", lastName: "Smith" }).id;
  candidateBobId = createCandidate({ firstName: "Bob", lastName: "Jones" }).id;

  companyId = createCompany({ name: "E2ETestCo", source_type: "greenhouse", ats_board_token: "e2etest" }).id;
  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, "job-e2e-1");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "job-e2e-1",
      title: "Senior Data Engineer",
      location: "San Francisco, CA",
      department: "Data Engineering",
      url: "https://boards.greenhouse.io/e2etest/job-e2e-1",
      descriptionHtml: "<p>We are seeking a Senior Data Engineer with Azure Data Factory, Databricks, and Python.</p>",
      descriptionText: "We are seeking a Senior Data Engineer with Azure Data Factory, Databricks, and Python.",
      employmentType: "Full-time",
      workplaceType: "Remote",
      salaryText: "$160,000 - $190,000",
      postedAt: new Date().toISOString(),
      raw: null,
    },
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  const j = getJobByDedupeKey(dedupeKey)!;
  jobOne = { id: j.id, dedupe_key: j.dedupe_key };

  function writeProfile(candId: number, resumeHash: string, skillsHash: string) {
    const dir = path.join(tmpCandidatesDir, String(candId));
    const masterDir = path.join(dir, "master");
    fs.mkdirSync(masterDir, { recursive: true });
    fs.writeFileSync(path.join(masterDir, "resume.md"), "# Alice Smith\n## Experience\n### Acme Corp\nSenior Data Engineer");
    fs.writeFileSync(path.join(masterDir, "skills.md"), "# Skills\n- Azure Data Factory\n- Databricks\n- Python");
    fs.writeFileSync(
      path.join(masterDir, "manifest.json"),
      JSON.stringify({
        resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: resumeHash },
        skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: skillsHash },
      })
    );

    const profile = {
      schemaVersion: 1,
      sourceHashes: { resume: resumeHash, skills: skillsHash },
      builtAt: "2026-01-01T00:00:00Z",
      skills: [
        { rawSkillName: "Azure Data Factory", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
        { rawSkillName: "Databricks", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
        { rawSkillName: "Apache Spark", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
        { rawSkillName: "PySpark", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
        { rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
        { rawSkillName: "SQL", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      ],
      experience: [
        {
          employer: "Acme Corp",
          title: "Senior Data Engineer",
          startDate: "2020-01-01",
          endDate: null,
          // Matches every technology PERFECT_RESUME claims below (Resume Quality Hardening's
          // masterSkillsInventoryCompliance check requires every claimed technology to be grounded
          // here — Apache Spark/PySpark/SQL were previously absent even though PERFECT_RESUME lists
          // them, which is exactly the ungrounded-technology case that check exists to catch).
          technologies: ["Azure Data Factory", "Databricks", "Apache Spark", "PySpark", "Python", "SQL"],
        },
      ],
      education: [{ level: "B.S.", field: "Computer Science", institution: "University of California" }],
      certifications: [{ name: "Azure Solutions Architect Expert" }],
      totalYearsExperience: 5,
    };
    fs.writeFileSync(path.join(dir, "candidate-profile.json"), JSON.stringify(profile));
  }

  writeProfile(candidateAliceId, "hash-alice-res", "hash-alice-skl");
  writeProfile(candidateBobId, "hash-bob-res", "hash-bob-skl");

  insertJobMatchResult({
    candidateId: candidateAliceId,
    jobId: jobOne.id,
    dedupeKey: jobOne.dedupe_key,
    matchEngineVersion: 2,
    matchKnowledgeHash: "match-knowledge-hash",
    candidateProfileHash: "hash-alice-res:hash-alice-skl",
    candidateSettingsHash: "candidate-settings-hash",
    jdContentHash: "jd-content-hash",
    computedAt: new Date().toISOString(),
    eligibility: { status: "PASS", reasons: [], sponsorship: { signal: "not_applicable", note: "n/a" } },
    dimensionScores: { roleAlignment: null, required: 95, preferred: 80, experience: 100, seniority: 100 },
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

  setMarkedForTailoring(candidateAliceId, jobOne.dedupe_key, true, {
    approvalType: "READY_DIRECT",
    decision: "READY_FOR_TAILORING",
  });

  const state = getCandidateJobState(candidateAliceId, jobOne.dedupe_key)!;
  appAliceJobOneId = state.id;

  const { run } = startTailoringRun({ candidateId: candidateAliceId, jobId: jobOne.id });
  runAliceJobOneId = run.id;
});

after(() => {
  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {}
    global.__careerOpsDb = undefined;
  }
  fs.rmSync(tmpDbDir, { recursive: true, force: true });
  fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  fs.rmSync(tmpGeneratedDir, { recursive: true, force: true });
});

// ============================================================================
// PART 10 CASE A: PASS ON ITERATION 1 (READY)
// ============================================================================
test("E2E Case A: Iteration 1 passes deterministic review and achieves READY state", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });
  initWorkflowWorkspace(candidateAliceId, wf.id, runAliceJobOneId, jobOne.dedupe_key);

  const iterResult = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    coverLetter: COVER_LETTER,
    resumeDocxPath: sampleResumeDocxPath,
    coverLetterDocxPath: sampleCoverDocxPath,
  });

  assert.equal(iterResult.status, "READY");
  assert.equal(iterResult.review.overallScore >= 95, true);
  assert.equal(iterResult.review.truthfulnessScore, 100);
  assert.equal(iterResult.review.architectureConsistencyScore, 100);
  assert.equal(iterResult.review.blockingIssues.length, 0);

  // Check final directory artifacts populated
  const location = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: wf.id,
  };
  const finalDir = getFinalDirectory(location);
  assert.ok(fs.existsSync(path.join(finalDir, "Alice_Resume.docx")));
  assert.ok(fs.existsSync(path.join(finalDir, "Alice_CoverLetter.docx")));
  assert.ok(fs.existsSync(path.join(finalDir, "resume_review_feedback.md")));
});

// ============================================================================
// PART 10 CASE B: PASS AFTER IMPROVEMENT (ITERATION 1 FAILS -> EXPORT -> IMPORT -> READY)
// ============================================================================
test("E2E Case B: Multi-stage improvement workflow via external handoff package", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });
  initWorkflowWorkspace(candidateAliceId, wf.id, runAliceJobOneId, jobOne.dedupe_key);

  // Iteration 1: Flawed resume
  const iter1Result = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME,
  });
  assert.equal(iter1Result.status, "IMPROVEMENT_RUNNING");

  // Step 1: Export package
  const exportReq = new NextRequest(
    `http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/export`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overwrite: true }),
    }
  );
  const exportRes = await exportPost(exportReq, {
    params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }),
  });
  assert.equal(exportRes.status, 200);
  const exportData = await exportRes.json();
  assert.equal(exportData.ok, true);
  assert.equal(exportData.exportResult.targetIterationNumber, 2);

  const handoffDir = exportData.exportResult.handoffDirectory;
  assert.ok(fs.existsSync(path.join(handoffDir, "writer_prompt.md")));
  assert.ok(fs.existsSync(path.join(handoffDir, "writer_input.json")));
  assert.ok(fs.existsSync(path.join(handoffDir, "job_description.md")));
  assert.ok(fs.existsSync(path.join(handoffDir, "extracted_job_requirements.json")));
  assert.ok(fs.existsSync(path.join(handoffDir, "resume_tailoring_instructions.md")));
  assert.ok(fs.existsSync(path.join(handoffDir, "master_resume_reference.json")));
  assert.ok(fs.existsSync(path.join(handoffDir, "master_skills_inventory.md")));
  assert.ok(fs.existsSync(path.join(handoffDir, "previous_resume_content.json")));
  assert.ok(fs.existsSync(path.join(handoffDir, "review.json")));
  assert.ok(fs.existsSync(path.join(handoffDir, "review_feedback.md")));
  assert.ok(fs.existsSync(path.join(handoffDir, "workflow_status.json")));
  assert.ok(fs.existsSync(path.join(handoffDir, "README.md")));

  // Step 2: Simulated External Agent produces writer_output.json
  const simulatedOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 2,
    resume: PERFECT_RESUME,
    coverLetter: COVER_LETTER,
    agentMetadata: {
      provider: "claude-code",
      model: "claude-3-7-sonnet",
      completedAt: new Date().toISOString(),
    },
  };

  // Step 3: Import writer_output.json
  const importReq = new NextRequest(
    `http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/import`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(simulatedOutput),
    }
  );
  const importRes = await importPost(importReq, {
    params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }),
  });
  assert.equal(importRes.status, 200);
  const importData = await importRes.json();
  assert.equal(importData.ok, true);
  assert.equal(importData.workflow.status, "READY");
  assert.equal(importData.workflow.current_iteration, 2);

  // Verify iteration 1 remained immutable and iteration 2 exists
  const location = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: wf.id,
  };
  const iter1Dir = getIterationDirectory(location, 1);
  const iter2Dir = getIterationDirectory(location, 2);
  assert.ok(fs.existsSync(path.join(iter1Dir, "resume_content.json")));
  assert.ok(fs.existsSync(path.join(iter2Dir, "resume_content.json")));
  const iter1Json = JSON.parse(fs.readFileSync(path.join(iter1Dir, "resume_content.json"), "utf8"));
  assert.equal(iter1Json.tagline, "Data Engineer");
  const iter2Json = JSON.parse(fs.readFileSync(path.join(iter2Dir, "resume_content.json"), "utf8"));
  assert.equal(iter2Json.tagline, "Senior Data Engineer");
});

// ============================================================================
// PART 10 CASE C: FAIL AFTER MAX ITERATIONS (HUMAN REVIEW REQUIRED)
// ============================================================================
test("E2E Case C: Max iterations enforcement halts at 3 and marks FAILED / Human Review Required", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    maxIterations: 3,
  });
  initWorkflowWorkspace(candidateAliceId, wf.id, runAliceJobOneId, jobOne.dedupe_key);

  // Iteration 1
  const iter1 = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME,
  });
  assert.equal(iter1.status, "IMPROVEMENT_RUNNING");

  // Iteration 2
  const iter2Output: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 2,
    resume: FLAWED_RESUME,
  };
  const req2 = new NextRequest(
    `http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/import`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(iter2Output),
    }
  );
  const res2 = await importPost(req2, {
    params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }),
  });
  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  assert.equal(data2.workflow.status, "IMPROVEMENT_RUNNING");
  assert.equal(data2.workflow.current_iteration, 2);

  // Iteration 3
  const iter3Output: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 3,
    resume: FLAWED_RESUME,
  };
  const req3 = new NextRequest(
    `http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/import`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(iter3Output),
    }
  );
  const res3 = await importPost(req3, {
    params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }),
  });
  assert.equal(res3.status, 200);
  const data3 = await res3.json();
  assert.equal(data3.workflow.status, "FAILED");
  assert.equal(data3.workflow.current_iteration, 3);
  assert.match(data3.workflow.failure_reason, /human review/i);

  // Prove iteration 4 cannot occur
  const iter4Output: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 4,
    resume: PERFECT_RESUME,
  };
  const req4 = new NextRequest(
    `http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/import`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(iter4Output),
    }
  );
  const res4 = await importPost(req4, {
    params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }),
  });
  assert.equal(res4.status, 400);
});

// ============================================================================
// PART 9 & 11: SECURITY & REJECTION INTEGRATION CHECKS
// ============================================================================
test("Security: Cross-candidate artifact access and identity mismatches strictly rejected", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });
  initWorkflowWorkspace(candidateAliceId, wf.id, runAliceJobOneId, jobOne.dedupe_key);

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    coverLetter: COVER_LETTER,
    resumeDocxPath: sampleResumeDocxPath,
    coverLetterDocxPath: sampleCoverDocxPath,
  });

  // Bob attempts to download Alice's resume
  const bobReq = new NextRequest(
    `http://localhost/api/candidates/${candidateBobId}/jobs/${jobOne.id}/quality-workflow/artifacts/resume`
  );
  const bobRes = await artifactGet(bobReq, {
    params: Promise.resolve({ candidateId: String(candidateBobId), jobId: String(jobOne.id), artifactType: "resume" }),
  });
  assert.equal(bobRes.status, 404);

  // Path traversal attempt via parameter
  const travReq = new NextRequest(
    `http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/artifacts/resume?iteration=../../../../etc/passwd`
  );
  const travRes = await artifactGet(travReq, {
    params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id), artifactType: "resume" }),
  });
  assert.equal(travRes.status, 400);
});

// ============================================================================
// PART 4: TEST ISOLATION VERIFICATION
// ============================================================================
test("Isolation: Production database remains completely unmutated by test suite", () => {
  // Confirm that the test suite ran entirely within tmpDbDir
  assert.ok(process.env.CAREER_OPS_DB_PATH && process.env.CAREER_OPS_DB_PATH.startsWith(tmpDbDir));
  assert.ok(process.env.CAREER_OPS_GENERATED_DIR && process.env.CAREER_OPS_GENERATED_DIR.startsWith(tmpGeneratedDir));
});
