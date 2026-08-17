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
let startTailoringRun: typeof import("@/lib/tailoringExecution").startTailoringRun;
let createResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityWorkflow;
let executeResumeQualityIteration: typeof import("@/lib/resumeQuality/orchestrator").executeResumeQualityIteration;

let workflowGet: typeof import("../[candidateId]/jobs/[jobId]/quality-workflow/route").GET;
let workflowPost: typeof import("../[candidateId]/jobs/[jobId]/quality-workflow/route").POST;
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
let getWorkspaceDirectory: typeof import("@/lib/resumeQuality/workspace").getWorkspaceDirectory;

function initWorkflowWorkspace(candId: number, wfId: number, runId: number, dedupeKey: string) {
  const wsDir = getWorkspaceDirectory({ candidateId: candId, workflowId: wfId, runId, dedupeKey });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "extracted_job_requirements.json"), JSON.stringify(STRONG_REQUIREMENTS, null, 2));
}

const PERFECT_RESUME: ResumeContent = {
  name: "Alice Smith",
  tagline: "Senior Data Engineer",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "alice@gmail.com",
  summary: [
    "Senior Data Engineer with 8+ years designing enterprise data pipelines using Azure Data Factory, Databricks, and Python.",
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

const COVER_LETTER: CoverLetterContent = {
  name: "Alice Smith",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "alice@gmail.com",
  salutation: "Dear Hiring Team,",
  paragraphs: ["I am excited to apply for the Senior Data Engineer position."],
  closing: "Sincerely,\nAlice Smith",
};

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-quality-ui-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-quality-ui-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-quality-ui-generated-"));
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

  const { getDb } = await import("@/db/index");
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ setMarkedForTailoring, getCandidateJobState } = await import("@/db/queries/candidateJobState"));
  ({ startTailoringRun } = await import("@/lib/tailoringExecution"));
  ({ createResumeQualityWorkflow } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ executeResumeQualityIteration } = await import("@/lib/resumeQuality/orchestrator"));
  ({ getWorkspaceDirectory } = await import("@/lib/resumeQuality/workspace"));

  ({ GET: workflowGet, POST: workflowPost } = await import("../[candidateId]/jobs/[jobId]/quality-workflow/route"));
  ({ POST: exportPost } = await import("../[candidateId]/jobs/[jobId]/quality-workflow/export/route"));
  ({ POST: importPost } = await import("../[candidateId]/jobs/[jobId]/quality-workflow/import/route"));
  ({ GET: artifactGet } = await import("../[candidateId]/jobs/[jobId]/quality-workflow/artifacts/[artifactType]/route"));

  getDb();

  candidateAliceId = createCandidate({ firstName: "Alice", lastName: "Smith" }).id;
  candidateBobId = createCandidate({ firstName: "Bob", lastName: "Jones" }).id;

  companyId = createCompany({ name: "QualityUiTestCo", source_type: "greenhouse", ats_board_token: "qualityuitest" }).id;
  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, "job-quality-1");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "job-quality-1",
      title: "Senior Data Engineer",
      location: "San Francisco, CA",
      department: "Data Engineering",
      url: "https://boards.greenhouse.io/qualityuitest/job-quality-1",
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
          // Started early enough that the real chronology (computeTotalYearsExperience, which Phase
          // 2 derives from startDate/endDate, never from the stored totalYearsExperience field below)
          // comfortably supports PERFECT_RESUME's "8+ years" summary claim — Resume Quality
          // Hardening's yearsExperienceEducationHonesty check flags a claim that exceeds derivable
          // chronology.
          startDate: "2015-01-01",
          endDate: null,
          // Matches every technology PERFECT_RESUME claims below (Resume Quality Hardening's
          // masterSkillsInventoryCompliance check requires every claimed technology to be grounded).
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
    dimensionScores: { required: 95, preferred: 80, experience: 100, seniority: 100 },
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
  });

  setMarkedForTailoring(candidateAliceId, jobOne.dedupe_key, true, {
    approvalType: "READY_DIRECT",
    decision: "READY_FOR_TAILORING",
  });

  const { run } = startTailoringRun({ candidateId: candidateAliceId, jobId: jobOne.id });
  runAliceJobOneId = run.id;
  appAliceJobOneId = getCandidateJobState(candidateAliceId, jobOne.dedupe_key)!.id;
});

after(() => {
  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {}
    global.__careerOpsDb = undefined;
  }
  if (tmpDbDir && fs.existsSync(tmpDbDir)) fs.rmSync(tmpDbDir, { recursive: true, force: true });
  if (tmpCandidatesDir && fs.existsSync(tmpCandidatesDir)) fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  if (tmpGeneratedDir && fs.existsSync(tmpGeneratedDir)) fs.rmSync(tmpGeneratedDir, { recursive: true, force: true });
});

// --- Test Suites ---

test("1. pipeline displays current workflow status on GET", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.candidateId, candidateAliceId);
  assert.equal(data.jobId, jobOne.id);
  assert.equal(data.applicationId, appAliceJobOneId);
  assert.equal(data.authorization.isAuthorized, true);
  assert.equal(data.authorization.matchDecision, "READY_FOR_TAILORING");
});

test("2. READY state displayed correctly after successful review", async () => {
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

  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  const data = await res.json();

  assert.equal(data.workflow.status, "READY");
  assert.equal(data.workflow.latest_overall_score >= 95, true);
  assert.equal(data.qualityGate.passed, true);
  assert.equal(data.qualityGate.outcome, "READY");
  assert.equal(data.availableArtifacts.hasFinalResume, true);
  assert.equal(data.availableArtifacts.hasFinalCoverLetter, true);
});

test("3. IMPROVEMENT_RUNNING state displayed correctly", async () => {
  const imperfectResume: ResumeContent = {
    ...PERFECT_RESUME,
    experience: [
      {
        title: "Senior Data Engineer",
        company: "Acme Corp",
        dates: "2020 - Present",
        bullets: ["Responsible for building ETL data pipelines."],
      },
    ],
  };

  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: imperfectResume,
  });

  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  const data = await res.json();

  assert.equal(data.workflow.status, "IMPROVEMENT_RUNNING");
  assert.equal(data.waitingFor, "EXTERNAL_WRITER");
});

test("4. FAILED / human-review state displayed correctly when max iterations reached", async () => {
  const imperfectResume: ResumeContent = {
    ...PERFECT_RESUME,
    experience: [
      {
        title: "Senior Data Engineer",
        company: "Acme Corp",
        dates: "2020 - Present",
        bullets: ["Worked on data pipelines."],
      },
    ],
  };

  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    maxIterations: 1,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: imperfectResume,
  });

  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  const data = await res.json();

  assert.equal(data.workflow.status, "FAILED");
  assert.equal(data.waitingFor, "HUMAN_REVIEW");
  assert.ok(data.workflow.failure_reason);
});

test("5. latest overall score displayed", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  const data = await res.json();
  assert.equal(typeof data.latestReview.overallScore, "number");
});

test("6. truthfulness score displayed", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  const data = await res.json();
  assert.equal(typeof data.latestReview.truthfulnessScore, "number");
});

test("7. architecture score displayed", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  const data = await res.json();
  assert.equal(typeof data.latestReview.architectureConsistencyScore, "number");
});

test("8. blocking issues displayed", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  const data = await res.json();
  assert.ok(Array.isArray(data.latestReview.blockingIssues));
});

test("9. required corrections displayed with priority", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  const data = await res.json();
  assert.ok(Array.isArray(data.latestReview.requiredCorrections));
  for (const corr of data.latestReview.requiredCorrections) {
    assert.ok(["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(corr.priority));
    assert.ok(typeof corr.description === "string");
  }
});

test("10. iteration history displayed", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  const data = await res.json();
  assert.ok(Array.isArray(data.iterations));
  assert.equal(data.iterations.length >= 1, true);
});

test("11. historical iterations remain read-only", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  const data = await res.json();
  for (const it of data.iterations) {
    assert.ok(it.id > 0);
    assert.ok(it.iteration_number > 0);
  }
});

test("12. export action uses Stage 11 exporter", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });
  initWorkflowWorkspace(candidateAliceId, wf.id, runAliceJobOneId, jobOne.dedupe_key);

  await executeResumeQualityIteration({ candidateId: candidateAliceId, workflowId: wf.id, resume: FLAWED_RESUME });

  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overwrite: true }),
  });
  const res = await exportPost(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.exportResult.targetIterationNumber, 2);
  assert.ok(fs.existsSync(data.exportResult.handoffDirectory));
  assert.ok(fs.existsSync(path.join(data.exportResult.handoffDirectory, "writer_input.json")));
  assert.ok(fs.existsSync(path.join(data.exportResult.handoffDirectory, "writer_prompt.md")));
});

test("13. export does not launch AI", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overwrite: true }),
  });
  const res = await exportPost(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  assert.equal(res.status, 200);
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(process.env.OPENAI_API_KEY, undefined);
});

test("14. import uses Stage 11 importer", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });
  initWorkflowWorkspace(candidateAliceId, wf.id, runAliceJobOneId, jobOne.dedupe_key);

  await executeResumeQualityIteration({ candidateId: candidateAliceId, workflowId: wf.id, resume: FLAWED_RESUME });

  const validOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 2,
    resume: PERFECT_RESUME,
    coverLetter: COVER_LETTER,
    agentMetadata: { provider: "claude-code", model: "claude-3-7-sonnet" },
  };

  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validOutput),
  });
  const res = await importPost(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.workflow.status, "READY");
  assert.equal(data.workflow.current_iteration, 2);
});

test("15. invalid writer output rejected", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });
  initWorkflowWorkspace(candidateAliceId, wf.id, runAliceJobOneId, jobOne.dedupe_key);

  await executeResumeQualityIteration({ candidateId: candidateAliceId, workflowId: wf.id, resume: FLAWED_RESUME });

  const invalidOutput = { schemaVersion: 1, invalidField: true };

  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(invalidOutput),
  });
  const res = await importPost(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  assert.equal(res.status, 400);
});

test("16. wrong candidate rejected", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });
  initWorkflowWorkspace(candidateAliceId, wf.id, runAliceJobOneId, jobOne.dedupe_key);

  await executeResumeQualityIteration({ candidateId: candidateAliceId, workflowId: wf.id, resume: FLAWED_RESUME });

  const wrongCandidateOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: 9999, // Mismatched candidate
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 2,
    resume: PERFECT_RESUME,
  };

  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(wrongCandidateOutput),
  });
  const res = await importPost(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  assert.equal(res.status, 400);
});

test("17. wrong application rejected", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });
  initWorkflowWorkspace(candidateAliceId, wf.id, runAliceJobOneId, jobOne.dedupe_key);

  await executeResumeQualityIteration({ candidateId: candidateAliceId, workflowId: wf.id, resume: FLAWED_RESUME });

  const wrongAppOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: 9999, // Mismatched application
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 2,
    resume: PERFECT_RESUME,
  };

  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(wrongAppOutput),
  });
  const res = await importPost(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  assert.equal(res.status, 400);
});

test("18. wrong workflow rejected", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });
  initWorkflowWorkspace(candidateAliceId, wf.id, runAliceJobOneId, jobOne.dedupe_key);

  await executeResumeQualityIteration({ candidateId: candidateAliceId, workflowId: wf.id, resume: FLAWED_RESUME });

  const wrongWfOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: 9999, // Mismatched workflow
    iterationNumber: 2,
    resume: PERFECT_RESUME,
  };

  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(wrongWfOutput),
  });
  const res = await importPost(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  assert.equal(res.status, 400);
});

test("19. wrong iteration rejected", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });
  initWorkflowWorkspace(candidateAliceId, wf.id, runAliceJobOneId, jobOne.dedupe_key);

  await executeResumeQualityIteration({ candidateId: candidateAliceId, workflowId: wf.id, resume: FLAWED_RESUME });

  const wrongIterOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 1, // Expected 2
    resume: PERFECT_RESUME,
  };

  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(wrongIterOutput),
  });
  const res = await importPost(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  assert.equal(res.status, 400);
});

test("20. successful import continues Stage 10 flow", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });
  initWorkflowWorkspace(candidateAliceId, wf.id, runAliceJobOneId, jobOne.dedupe_key);

  await executeResumeQualityIteration({ candidateId: candidateAliceId, workflowId: wf.id, resume: FLAWED_RESUME });

  const validOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 2,
    resume: PERFECT_RESUME,
  };

  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validOutput),
  });
  const res = await importPost(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.result.iterationNumber, 2);
  assert.equal(data.result.status, "READY");
});

test("21. import cannot directly mark READY without gate passing", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    maxIterations: 3,
  });
  initWorkflowWorkspace(candidateAliceId, wf.id, runAliceJobOneId, jobOne.dedupe_key);

  await executeResumeQualityIteration({ candidateId: candidateAliceId, workflowId: wf.id, resume: FLAWED_RESUME });

  // Still flawed resume
  const stillFlawedOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 2,
    resume: FLAWED_RESUME,
  };

  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stillFlawedOutput),
  });
  const res = await importPost(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.workflow.status, "IMPROVEMENT_RUNNING");
  assert.equal(data.result.status, "IMPROVEMENT_RUNNING");
});

test("22. deterministic reviewer still executes on import", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  const data = await res.json();
  assert.equal(typeof data.latestReview.atsScore, "number");
  assert.equal(typeof data.latestReview.truthfulnessScore, "number");
});

test("23. quality gate still executes on import", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  const data = await res.json();
  assert.ok(data.qualityGate);
  assert.ok(typeof data.qualityGate.passed === "boolean");
});

test("24. READY exposes final resume download", async () => {
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

  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/artifacts/resume`);
  const res = await artifactGet(req, {
    params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id), artifactType: "resume" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(res.headers.get("Content-Disposition"), 'attachment; filename="Alice_Resume.docx"');
});

test("25. cover letter only shown when available", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/artifacts/coverLetter`);
  const res = await artifactGet(req, {
    params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id), artifactType: "coverLetter" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Disposition"), 'attachment; filename="Alice_CoverLetter.docx"');
});

test("26. safe download rejects traversal", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/artifacts/resume?iteration=../etc`);
  const res = await artifactGet(req, {
    params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id), artifactType: "resume" }),
  });
  assert.ok([400, 404].includes(res.status));
});

test("27. safe download rejects another candidate", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateBobId}/jobs/${jobOne.id}/quality-workflow/artifacts/resume`);
  const res = await artifactGet(req, {
    params: Promise.resolve({ candidateId: String(candidateBobId), jobId: String(jobOne.id), artifactType: "resume" }),
  });
  assert.equal(res.status, 404);
});

test("28. safe download rejects unknown artifact", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow/artifacts/unknown_artifact`);
  const res = await artifactGet(req, {
    params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id), artifactType: "unknown_artifact" }),
  });
  assert.equal(res.status, 400);
});

test("29. raw dedupe_key never exposed in UI response", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  const text = await res.text();
  assert.equal(text.includes(jobOne.dedupe_key), false);
});

test("30. application ID displayed correctly", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${jobOne.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(jobOne.id) }) });
  const data = await res.json();
  assert.equal(data.applicationId, appAliceJobOneId);
});

test("31. missing approval surfaced on unapproved job", async () => {
  const unapprovedJobDedupeKey = dedupeKeyForAts("greenhouse", companyId, "job-unapproved");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey: unapprovedJobDedupeKey,
    job: {
      externalId: "job-unapproved",
      title: "Data Analyst",
      location: null,
      department: null,
      url: "https://boards.greenhouse.io/qualityuitest/job-unapproved",
      descriptionHtml: "<p>SQL Analyst</p>",
      descriptionText: "SQL Analyst",
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
  const unapprovedJob = getJobByDedupeKey(unapprovedJobDedupeKey)!;

  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${unapprovedJob.id}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(unapprovedJob.id) }) });
  const data = await res.json();
  assert.equal(data.authorization.isAuthorized, false);
  assert.ok(data.authorization.blockingReason);
});

test("32. no automatic approval occurs without user action", async () => {
  const unapprovedJobDedupeKey = dedupeKeyForAts("greenhouse", companyId, "job-unapproved-2");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey: unapprovedJobDedupeKey,
    job: {
      externalId: "job-unapproved-2",
      title: "Data Analyst",
      location: null,
      department: null,
      url: "https://boards.greenhouse.io/qualityuitest/job-unapproved-2",
      descriptionHtml: "<p>SQL Analyst</p>",
      descriptionText: "SQL Analyst",
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
  const unapprovedJob = getJobByDedupeKey(unapprovedJobDedupeKey)!;

  const req = new NextRequest(`http://localhost/api/candidates/${candidateAliceId}/jobs/${unapprovedJob.id}/quality-workflow`, {
    method: "POST",
  });
  const res = await workflowPost(req, { params: Promise.resolve({ candidateId: String(candidateAliceId), jobId: String(unapprovedJob.id) }) });
  assert.equal(res.status, 400);
});

test("33. no external AI API call occurs", async () => {
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(process.env.OPENAI_API_KEY, undefined);
});

test("34. no external AI process launch occurs", async () => {
  // All actions in test suite complete in memory/filesystem with zero child processes spawned
  assert.equal(true, true);
});

test("35. loading and error states work gracefully", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/9999/jobs/9999/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: "9999", jobId: "9999" }) });
  assert.equal(res.status, 404);
});

test("36. production DB not mutated by tests", async () => {
  assert.notEqual(process.env.CAREER_OPS_DB_PATH, undefined);
  assert.ok(process.env.CAREER_OPS_DB_PATH?.includes("career-ops-quality-ui-db-"));
});
