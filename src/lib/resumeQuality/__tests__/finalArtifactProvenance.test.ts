import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import { INSTRUCTION_HASH, INSTRUCTION_VERSION } from "../canonicalInstructions";
import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";
import type { ResumeWriterAgent, ResumeWriterOutput, WorkflowStatusFile } from "../types";
import { getFinalDirectory, type QualityWorkflowLocation } from "../workspace";

/**
 * Resume Quality Hardening — final artifact provenance (spec §10): when a workflow reaches READY,
 * final/ must additionally contain careerops_review.json, instruction_snapshot.md,
 * workflow_status.json, cold_follow_up_email.md, and writer_validation.json (only when the external
 * writer supplied one). None of these existed before this hardening pass — orchestrator.ts's READY
 * branch previously stopped at resume/cover-letter docx + resume_review_feedback.md + JSON content.
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
let getCandidateJobState: typeof import("@/db/queries/candidateJobState").getCandidateJobState;
let startTailoringRun: typeof import("@/lib/tailoringExecution").startTailoringRun;
let createResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityWorkflow;
let executeResumeQualityIteration: typeof import("../orchestrator").executeResumeQualityIteration;
let executeResumeImprovementIteration: typeof import("../orchestrator").executeResumeImprovementIteration;

let candidateId: number;
let companyId: number;
let job: { id: number; dedupe_key: string };
let runId: number;
let applicationId: number;

function unit(overrides: Partial<RequirementUnit>): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: [],
    categories: [],
    label: "requirement",
    requirementLevel: "Required",
    criticality: "CRITICAL",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    fromUnclaimedText: false,
    ...overrides,
  };
}

const STRONG_REQUIREMENTS: RequirementUnit[] = [
  unit({ memberSkillNames: ["Azure"], label: "Azure" }),
  unit({ memberSkillNames: ["Azure Data Factory"], label: "Azure Data Factory" }),
  unit({ memberSkillNames: ["Databricks"], label: "Databricks" }),
];

const PERFECT_RESUME: ResumeContent = {
  name: "Priya Nair",
  tagline: "Senior Data Engineer",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "priya@gmail.com",
  summary: [
    "Senior Data Engineer with 5+ years building Azure Data Factory and Databricks pipelines for enterprise analytics platforms.",
  ],
  skillGroups: [{ label: "Cloud & Data Platform", items: ["Azure", "Azure Data Factory", "Databricks", "Python", "SQL"] }],
  experience: [
    {
      title: "Senior Data Engineer",
      company: "Acme Corp",
      dates: "2020 - Present",
      bullets: [
        "Designed Azure Data Factory pipelines that reduced nightly batch processing time from 6 hours to 45 minutes.",
        "Built Databricks notebooks to transform 2TB of daily transaction data into curated analytics tables.",
      ],
    },
  ],
  education: ["B.S. Computer Science, State University"],
};

const COVER_LETTER: CoverLetterContent = {
  name: "Priya Nair",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "priya@gmail.com",
  salutation: "Dear Hiring Team,",
  paragraphs: ["I am excited to apply for the Senior Data Engineer position."],
  closing: "Sincerely,\nPriya Nair",
};

function masterProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "r", skills: "s" },
    builtAt: "2020-01-01T00:00:00Z",
    skills: [],
    experience: [
      {
        employer: "Acme Corp",
        title: "Senior Data Engineer",
        startDate: "2020-01",
        endDate: null,
        technologies: ["Azure", "Azure Data Factory", "Databricks", "Python", "SQL"],
      },
    ],
    education: [{ level: "Bachelor's", field: "Computer Science", institution: "State University" }],
    certifications: [],
    totalYearsExperience: 5,
    ...overrides,
  };
}

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-provenance-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-provenance-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-provenance-generated-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

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
  ({ executeResumeQualityIteration, executeResumeImprovementIteration } = await import("../orchestrator"));
  getDb();

  candidateId = createCandidate({ firstName: "Priya", lastName: "Nair" }).id;
  companyId = createCompany({ name: "ProvenanceTestCo", source_type: "greenhouse", ats_board_token: "provenancetestco" }).id;

  const masterDir = path.join(tmpCandidatesDir, String(candidateId), "master");
  fs.mkdirSync(masterDir, { recursive: true });
  fs.writeFileSync(path.join(masterDir, "resume.txt"), "Resume for Priya Nair\nAcme Corp\nSenior Data Engineer\n2020 - Present");
  fs.writeFileSync(path.join(masterDir, "skills.json"), JSON.stringify({ skills: ["Azure", "Python"] }));
  fs.writeFileSync(
    path.join(masterDir, "manifest.json"),
    JSON.stringify({ resume: { filename: "resume.txt" }, skills: { filename: "skills.json" } })
  );

  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, "job-provenance-1");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "job-provenance-1",
      title: "Senior Data Engineer",
      location: "Remote",
      department: "Eng",
      url: "https://boards.greenhouse.io/provenancetestco/job-provenance-1",
      descriptionHtml: null,
      descriptionText: "Job description for test",
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

  const resumeHash = `resume-${candidateId}-${job.id}`;
  const skillsHash = `skills-${candidateId}-${job.id}`;
  fs.writeFileSync(
    path.join(tmpCandidatesDir, String(candidateId), "candidate-profile.json"),
    JSON.stringify(masterProfile({ sourceHashes: { resume: resumeHash, skills: skillsHash } }))
  );
  fs.writeFileSync(
    path.join(masterDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: resumeHash },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: skillsHash },
    })
  );

  insertJobMatchResult({
    candidateId,
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    matchEngineVersion: 2,
    matchKnowledgeHash: "provenance-hash-1",
    candidateProfileHash: `${resumeHash}:${skillsHash}`,
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

  setMarkedForTailoring(candidateId, job.dedupe_key, true, { approvalType: "READY_DIRECT", decision: "READY_FOR_TAILORING" });
  const { run } = startTailoringRun({ candidateId, jobId: job.id });
  runId = run.id;
  applicationId = getCandidateJobState(candidateId, job.dedupe_key)!.id;
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

test("READY writes careerops_review.json, instruction_snapshot.md, workflow_status.json, and cold_follow_up_email.md to final/", async () => {
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: job.dedupe_key });

  const res = await executeResumeQualityIteration({
    candidateId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    coverLetter: COVER_LETTER,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(res.status, "READY");
  assert.ok(res.finalDirectory);
  const finalDir = res.finalDirectory!;

  for (const file of ["careerops_review.json", "instruction_snapshot.md", "workflow_status.json", "cold_follow_up_email.md"]) {
    assert.ok(fs.existsSync(path.join(finalDir, file)), `expected ${file} to exist in ${finalDir}`);
  }

  // writer_validation.json must NOT exist when no writer supplied one.
  assert.ok(!fs.existsSync(path.join(finalDir, "writer_validation.json")));

  const careeropsReview = JSON.parse(fs.readFileSync(path.join(finalDir, "careerops_review.json"), "utf-8"));
  assert.deepEqual(careeropsReview, res.review);

  const snapshot = fs.readFileSync(path.join(finalDir, "instruction_snapshot.md"), "utf-8");
  assert.ok(snapshot.includes(INSTRUCTION_VERSION));
  assert.ok(snapshot.includes(INSTRUCTION_HASH));
  assert.ok(snapshot.includes("PRIMARY OBJECTIVE")); // spot-check the canonical text itself is embedded, not just referenced

  const status = JSON.parse(fs.readFileSync(path.join(finalDir, "workflow_status.json"), "utf-8")) as WorkflowStatusFile;
  assert.equal(status.workflowStatus, "READY");
  assert.equal(status.waitingFor, "COMPLETED");
  assert.equal(status.candidateId, candidateId);
  assert.equal(status.applicationId, applicationId);

  const coldEmail = fs.readFileSync(path.join(finalDir, "cold_follow_up_email.md"), "utf-8");
  assert.ok(coldEmail.includes("Priya Nair"));
  assert.ok(coldEmail.includes("ProvenanceTestCo"));
});

test("writer_validation.json is written only when the external writer supplied a writerValidation, and it is never consulted for the gate outcome", async () => {
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: job.dedupe_key });

  // Iteration 1: deliberately flawed so the workflow moves to IMPROVEMENT_RUNNING.
  const flawedResume: ResumeContent = {
    ...PERFECT_RESUME,
    summary: ["Data Engineer with some experience."],
    skillGroups: [{ label: "Programming", items: ["Python"] }],
    experience: [{ ...PERFECT_RESUME.experience[0], bullets: ["Responsible for writing scripts."] }],
  };
  const iter1 = await executeResumeQualityIteration({
    candidateId,
    workflowId: wf.id,
    resume: flawedResume,
    coverLetter: COVER_LETTER,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });
  assert.equal(iter1.status, "IMPROVEMENT_RUNNING");

  const dishonestWriter: ResumeWriterAgent = {
    generate: async (): Promise<ResumeWriterOutput> => ({
      resume: {
        ...flawedResume,
        summary: PERFECT_RESUME.summary,
        skillGroups: PERFECT_RESUME.skillGroups,
        experience: [
          {
            ...flawedResume.experience[0],
            bullets: [PERFECT_RESUME.experience[0].bullets[0]],
          },
        ],
      },
      coverLetter: COVER_LETTER,
      // A writer that self-reports full PASS — CareerOps must independently verify this rather than
      // trusting it, and must still persist it as provenance-only data when the workflow reaches READY.
      writerValidation: {
        instructionVersion: INSTRUCTION_VERSION,
        instructionHash: INSTRUCTION_HASH,
        checks: { hardCareerFacts: "PASS", deepRewrite: "PASS" },
        notes: ["Self-check complete."],
      },
    }),
  };

  const iter2 = await executeResumeImprovementIteration({
    candidateId,
    workflowId: wf.id,
    writer: dishonestWriter,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(iter2.status, "READY");
  assert.ok(iter2.finalDirectory);
  const finalDir = iter2.finalDirectory!;
  assert.ok(fs.existsSync(path.join(finalDir, "writer_validation.json")));
  const writerValidation = JSON.parse(fs.readFileSync(path.join(finalDir, "writer_validation.json"), "utf-8"));
  assert.equal(writerValidation.instructionVersion, INSTRUCTION_VERSION);
  assert.equal(writerValidation.checks.hardCareerFacts, "PASS");

  // The gate outcome came from CareerOps's own instructionCompliance, not from writerValidation.
  assert.ok(iter2.review.instructionCompliance);
  assert.notDeepEqual(iter2.review.instructionCompliance!.checks, writerValidation.checks);
});

test("IMPROVEMENT_RUNNING and FAILED outcomes never create a final/ directory or any of its provenance files", async () => {
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: job.dedupe_key });
  const flawedResume: ResumeContent = {
    ...PERFECT_RESUME,
    experience: [{ ...PERFECT_RESUME.experience[0], company: "TotallyFabricatedCorp" }],
  };
  const res = await executeResumeQualityIteration({
    candidateId,
    workflowId: wf.id,
    resume: flawedResume,
    coverLetter: COVER_LETTER,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });
  assert.notEqual(res.status, "READY");
  assert.equal(res.finalDirectory, undefined);

  const location: QualityWorkflowLocation = { candidateId, dedupeKey: job.dedupe_key, runId, workflowId: wf.id };
  assert.ok(!fs.existsSync(getFinalDirectory(location)));
});
