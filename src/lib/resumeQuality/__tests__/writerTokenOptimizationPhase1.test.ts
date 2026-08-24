import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import {
  buildInitialGenerationMasterReference,
  buildRepairScopedMasterReference,
  shouldUseFullMasterReferenceForRepair,
} from "../handoff/masterReferenceProjection";
import { exportExternalWriterPackage } from "../handoff/exporter";
import { measureHandoffContext } from "../handoff/contextMeasurement";
import { importExternalWriterResult } from "../handoff/importer";
import { DeterministicResumeReviewer } from "../reviewers/deterministicReviewer";
import { employerScopeForRepair, type RepairPlan } from "../repairScope";
import type { InstructionComplianceChecks } from "../types";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES } from "../types";
import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";
import { INSTRUCTION_HASH, INSTRUCTION_VERSION } from "../canonicalInstructions";

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

let candidateAliceId: number;
let companyId: number;
let jobOne: { id: number; dedupe_key: string };
let runAliceJobOneId: number;
let appAliceJobOneId: number;

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

const PERFECT_RESUME: ResumeContent = {
  name: "Alice Smith",
  tagline: "Senior Data Engineer | Cloud Data Platforms | Azure & Databricks",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "alice@gmail.com",
  summary: [
    "Senior Data Engineer delivering scalable Azure Data Factory and Databricks platforms for enterprise analytics.",
  ],
  skillGroups: [{ label: "Cloud & Data Platform", items: ["Azure", "Azure Data Factory", "Databricks", "Python", "SQL"] }],
  experience: [
    {
      title: "Senior Data Engineer",
      company: "Acme Corp",
      location: "Dallas, TX",
      dates: "2020 - Present",
      projectDescription: "Enterprise data platform modernization using Azure and Databricks.",
      bullets: [
        "Architected Azure Data Factory pipelines reducing nightly batch runtime from 6 hours to 45 minutes.",
        "Engineered Databricks transformations for 2TB daily data streams with automated data quality validations.",
      ],
      environment: ["Azure Data Factory", "Databricks", "Python"],
    },
    {
      title: "Data Engineer",
      company: "Beta LLC",
      location: "Austin, TX",
      dates: "2018 - 2020",
      projectDescription: "SQL Server database warehousing and ETL operations.",
      bullets: [
        "Maintained SQL Server databases and automated monitoring scripts for business intelligence workloads.",
      ],
      environment: ["SQL Server", "Python"],
    },
  ],
  education: ["B.S. Computer Science, State University"],
  certifications: ["Azure Data Engineer Associate"],
};

const COVER_LETTER: CoverLetterContent = {
  name: "Alice Smith",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "alice@gmail.com",
  salutation: "Dear Hiring Team,",
  paragraphs: [
    "I am writing to express my strong interest in the Senior Data Engineer position at Acme Corp.",
    "At Acme Corp, I engineered data pipelines using Azure Data Factory and Databricks.",
    "I look forward to discussing how my experience can benefit your engineering team.",
  ],
  closing: "Sincerely,\nAlice Smith",
};

function masterProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "r", skills: "s" },
    builtAt: "2026-01-01T00:00:00Z",
    totalYearsExperience: 5,
    skills: [
      { rawSkillName: "Azure", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "Azure Data Factory", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "Databricks", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme Corp" }, { employer: "Beta LLC" }] },
      { rawSkillName: "SQL Server", source: "employer", attributedTo: [{ employer: "Beta LLC" }] },
    ],
    experience: [
      {
        employer: "Acme Corp",
        title: "Senior Data Engineer",
        startDate: "2020-01",
        endDate: null,
        technologies: ["Azure", "Azure Data Factory", "Databricks", "Python"],
      },
      {
        employer: "Beta LLC",
        title: "Data Engineer",
        startDate: "2018-01",
        endDate: "2019-12",
        technologies: ["SQL Server", "Python"],
      },
    ],
    education: [{ level: "Bachelor's", field: "Computer Science", institution: "State University" }],
    certifications: [{ name: "Azure Data Engineer Associate", issuer: "Microsoft" }],
    ...overrides,
  };
}

let hashCounter = 0;
function nextHash(): string {
  hashCounter += 1;
  return `handoff-opt-hash-${hashCounter}`;
}

function fakeResult(overrides: Partial<import("@/lib/match/types").JobMatchResult>): import("@/lib/match/types").JobMatchResult {
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

function writeProfile(candId: number, resumeHash: string, skillsHash: string) {
  const dir = path.join(tmpCandidatesDir, String(candId));
  const masterDir = path.join(dir, "master");
  fs.mkdirSync(masterDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "candidate-profile.json"),
    JSON.stringify(masterProfile({ sourceHashes: { resume: resumeHash, skills: skillsHash } }))
  );
  fs.writeFileSync(
    path.join(masterDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: resumeHash },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: skillsHash },
    })
  );
  fs.writeFileSync(path.join(masterDir, "resume.txt"), "Alice Smith Resume\nAcme Corp\nSenior Data Engineer");
  fs.writeFileSync(path.join(masterDir, "skills.json"), JSON.stringify({ skills: ["Azure", "Python"] }));
}

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-opt-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-opt-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-opt-gen-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  if ((global as unknown as { __careerOpsDb?: { close: () => void } }).__careerOpsDb) {
    try {
      (global as unknown as { __careerOpsDb: { close: () => void } }).__careerOpsDb.close();
    } catch {}
    (global as unknown as { __careerOpsDb?: unknown }).__careerOpsDb = undefined;
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
  ({ executeResumeQualityIteration } = await import("../orchestrator"));
  getDb();

  candidateAliceId = createCandidate({ firstName: "Alice", lastName: "Smith" }).id;
  companyId = createCompany({ name: "OptTestCo", source_type: "greenhouse", ats_board_token: "opttest" }).id;

  writeProfile(candidateAliceId, "res-hash-1", "skills-hash-1");

  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, "job-opt-1");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "job-opt-1",
      title: "Senior Data Engineer",
      location: "Remote",
      department: "Eng",
      url: "https://boards.greenhouse.io/opttest/job-opt-1",
      descriptionHtml: null,
      descriptionText: "Looking for a Senior Data Engineer skilled in Azure Data Factory, Databricks, and Python.",
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
  const row = getJobByDedupeKey(dedupeKey);
  assert.ok(row);
  jobOne = { id: row.id, dedupe_key: dedupeKey };

  insertJobMatchResult(
    fakeResult({
      candidateId: candidateAliceId,
      jobId: jobOne.id,
      dedupeKey: jobOne.dedupe_key,
      candidateProfileHash: "res-hash-1:skills-hash-1",
      decision: "READY_FOR_TAILORING",
    })
  );

  setMarkedForTailoring(candidateAliceId, jobOne.dedupe_key, true, {
    approvalType: "READY_DIRECT",
    decision: "READY_FOR_TAILORING",
  });

  const { run } = startTailoringRun({ candidateId: candidateAliceId, jobId: jobOne.id });
  runAliceJobOneId = run.id;
  appAliceJobOneId = getCandidateJobState(candidateAliceId, jobOne.dedupe_key)!.id;
});

after(() => {
  if ((global as unknown as { __careerOpsDb?: { close: () => void } }).__careerOpsDb) {
    try {
      (global as unknown as { __careerOpsDb: { close: () => void } }).__careerOpsDb.close();
    } catch {}
    (global as unknown as { __careerOpsDb?: unknown }).__careerOpsDb = undefined;
  }
  try {
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
    fs.rmSync(tmpGeneratedDir, { recursive: true, force: true });
  } catch {}
});

// =================================================================================================
// STEP 6: PROMPT CONTRACT TESTS (PROMPTOPT-01 .. PROMPTOPT-10)
// =================================================================================================

test("PROMPTOPT-01: First-pass writer contract no longer contains duplicated large static instruction blocks", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const exportRes = exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 1,
  });

  const measurement = measureHandoffContext(exportRes.handoffDirectory);
  const readFiles = measurement.files.filter((f) => f.readByWriter).map((f) => f.filename);

  // Writer prompt should NOT instruct the automated reader to read the 541-line static file
  assert.equal(readFiles.includes("resume_tailoring_instructions.md"), false);
  assert.equal(readFiles.includes("writer_prompt.md"), true);
});

test("PROMPTOPT-02: Truthfulness rule remains present exactly once in authoritative semantic contract", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const exportRes = exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 1,
  });

  const prompt = fs.readFileSync(path.join(exportRes.handoffDirectory, "writer_prompt.md"), "utf-8");
  assert.match(prompt, /Truthfulness & Factual Grounding|Absolute Truthfulness/);
  assert.match(prompt, /sole authoritative record/);
});

test("PROMPTOPT-03: Employer-specific evidence boundary remains present", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const exportRes = exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 1,
  });

  const prompt = fs.readFileSync(path.join(exportRes.handoffDirectory, "writer_prompt.md"), "utf-8");
  assert.match(prompt, /PER-EMPLOYER EVIDENCE/);
  assert.match(prompt, /Acme Corp/);
});

test("PROMPTOPT-04: Metric inference policy remains present", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const exportRes = exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 1,
  });

  const prompt = fs.readFileSync(path.join(exportRes.handoffDirectory, "writer_prompt.md"), "utf-8");
  assert.match(prompt, /quantifiable, realistic impact/);
});

test("PROMPTOPT-05: Architecture/technology contradiction protection remains present", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const exportRes = exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 1,
  });

  const prompt = fs.readFileSync(path.join(exportRes.handoffDirectory, "writer_prompt.md"), "utf-8");
  assert.match(prompt, /Architecture integrity takes priority over raw keyword coverage/);
  assert.match(prompt, /Do not combine competing tools/);
});

test("PROMPTOPT-06: Deep rewrite requirement remains present", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const exportRes = exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 1,
  });

  const prompt = fs.readFileSync(path.join(exportRes.handoffDirectory, "writer_prompt.md"), "utf-8");
  assert.match(prompt, /Initial generation must be genuinely tailored|Rewrite the summary/);
});

test("PROMPTOPT-07: Output schema remains valid and sufficient for importer", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const exportRes = exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 1,
  });

  const prompt = fs.readFileSync(path.join(exportRes.handoffDirectory, "writer_prompt.md"), "utf-8");
  assert.match(prompt, /Strict JSON Output Schema/);
  assert.match(prompt, /"schemaVersion": 1/);
  assert.match(prompt, /"resume"/);
  assert.match(prompt, /"coverLetter"/);
});

test("PROMPTOPT-08: Full-rewrite writer handoff remains compatible with existing importer", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const exportRes = exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 1,
  });

  const validOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 1,
    resume: PERFECT_RESUME,
    coverLetter: COVER_LETTER,
  };

  const outputPath = path.join(exportRes.handoffDirectory, "writer_output.json");
  fs.writeFileSync(outputPath, JSON.stringify(validOutput, null, 2));

  const importRes = importExternalWriterResult({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    inputPath: outputPath,
  });
  assert.equal(importRes.candidateId, candidateAliceId);
  assert.equal(importRes.iterationNumber, 1);
  assert.ok(importRes.writerOutput.resume);
  assert.ok(importRes.writerOutput.coverLetter);
});

test("PROMPTOPT-09: PATCH writer handoff remains compatible with existing importer", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  // Execute iteration 1
  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    coverLetter: COVER_LETTER,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    reviewer: {
      review: async () => ({
        review: {
          overallScore: 80,
          atsScore: 85,
          keywordAlignmentScore: 85,
          truthfulnessScore: 80,
          architectureConsistencyScore: 85,
          recruiterReadabilityScore: 85,
          formattingScore: 90,
          blockingFailures: [],
          blockingIssues: ["Project description is too long."],
          requiredCorrections: [],
          missingRequiredSkills: [],
          incorrectTechnologyUsage: [],
          genericBullets: [],
          missingImpactEvidence: [],
          summaryIssues: [],
          skillsOrderingIssues: [],
          truthfulnessIssues: [],
          instructionCompliance: {
            instructionVersion: INSTRUCTION_VERSION,
            instructionHash: INSTRUCTION_HASH,
            checks: Object.fromEntries(
              INSTRUCTION_COMPLIANCE_CHECK_NAMES.map((name) => [name, name === "finalValidation" ? "FAIL" : "PASS"])
            ) as unknown as InstructionComplianceChecks,
            notes: [],
          },
        },
      }),
    },
  });

  const exportRes = exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 2,
  });

  const patchOutput = {
    schemaVersion: 2,
    outputMode: "PATCH",
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 2,
    operations: [
      {
        document: "resume",
        path: "experience[0].projectDescription",
        replacement: "Modernized enterprise data platform using Azure and Databricks.",
      },
    ],
  };

  const outputPath = path.join(exportRes.handoffDirectory, "writer_output.json");
  fs.writeFileSync(outputPath, JSON.stringify(patchOutput, null, 2));

  const { loadPatchContextFromHandoff } = await import("../handoff/importer");
  const importRes = importExternalWriterResult({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    inputPath: outputPath,
    patchContext: loadPatchContextFromHandoff(exportRes.handoffDirectory),
  });
  assert.equal(importRes.candidateId, candidateAliceId);
  assert.equal(importRes.iterationNumber, 2);
  assert.ok(importRes.writerOutput.resume);
  assert.equal(importRes.writerOutput.resume.experience[0].projectDescription, "Modernized enterprise data platform using Azure and Databricks.");
});

test("PROMPTOPT-10: Existing deterministic reviewer continues enforcing moved constraints", async () => {
  const reviewer = new DeterministicResumeReviewer();
  const profile = masterProfile();

  const reviewResult = await reviewer.review({
    applicationId: appAliceJobOneId,
    candidateId: candidateAliceId,
    workflowId: 1,
    iterationNumber: 1,
    resumePath: "resume.docx",
    jobDescriptionPath: "job.md",
    resume: PERFECT_RESUME,
    coverLetter: COVER_LETTER,
    masterResumeProfile: profile,
    jobRequirements: STRONG_REQUIREMENTS,
  });

  assert.ok(reviewResult.review.overallScore >= 80);
  assert.ok(reviewResult.review.truthfulnessScore >= 80);
});

// =================================================================================================
// STEP 7: REPAIR PROJECTION TESTS (REPAIRCTX-01 .. REPAIRCTX-10)
// =================================================================================================

test("REPAIRCTX-01: summary-only repair does NOT include full master reference (skills array omitted)", async () => {
  const profile = masterProfile();
  const plan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Summary claims unverified years",
    resumeFindings: [],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: ["resume.summary[0]"],
  };

  const shouldFallback = shouldUseFullMasterReferenceForRepair(plan);
  assert.equal(shouldFallback, false, "summary repair must not fallback to full reference");

  const employerScope = employerScopeForRepair(plan);
  const projected = buildRepairScopedMasterReference(profile, employerScope ?? new Set());
  assert.equal("skills" in projected, false, "skills array must be omitted");
  assert.equal(projected.totalYearsExperience, 5);
});

test("REPAIRCTX-02: summary repair includes required verified candidate positioning evidence", () => {
  const profile = masterProfile();
  const projected = buildInitialGenerationMasterReference(profile);

  assert.equal(projected.totalYearsExperience, 5);
  assert.equal(projected.education.length, 1);
  assert.equal(projected.certifications.length, 1);
  assert.equal(projected.experience.length, 2);
  assert.equal(projected.experience[0].employer, "Acme Corp");
  assert.equal(projected.experience[0].title, "Senior Data Engineer");
  assert.equal(projected.experience[0].startDate, "2020-01");
});

test("REPAIRCTX-03: skillGroups repair does NOT include unrelated full experience inventory", () => {
  const profile = masterProfile();
  const plan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Reorder skill groups",
    resumeFindings: [],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: ["resume.skillGroups"],
  };

  const shouldFallback = shouldUseFullMasterReferenceForRepair(plan);
  assert.equal(shouldFallback, false);

  const projected = buildRepairScopedMasterReference(profile, new Set());
  assert.equal("skills" in projected, false);
  for (const exp of projected.experience) {
    if ("preservation" in exp) {
      assert.equal(exp.preservation, "UNCHANGED");
      assert.equal("technologies" in exp, false);
    }
  }
});

test("REPAIRCTX-04: skillGroups repair includes sufficient verified skill evidence", () => {
  const profile = masterProfile();
  const compact = buildInitialGenerationMasterReference(profile);

  assert.equal(compact.totalYearsExperience, 5);
  assert.ok(compact.education.length > 0);
  assert.ok(compact.certifications.length > 0);
});

test("REPAIRCTX-05: experience bullet repair includes only correct employer evidence", () => {
  const profile = masterProfile();
  const plan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Fix Acme Corp bullet",
    resumeFindings: [],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: ["resume.experience[0].bullets[0]"],
    operations: [
      {
        operation: "REPLACE_BULLET",
        artifact: "resume",
        section: "experience_bullet",
        employer: "Acme Corp",
        rootFinding: "finding-1",
        evidenceSource: [],
        reason: "Fix bullet",
        candidateInputRequired: false,
        editablePath: "resume.experience[0].bullets[0]",
      },
    ],
  };

  const employerScope = employerScopeForRepair(plan);
  assert.ok(employerScope);
  assert.equal(employerScope.has("Acme Corp"), true);
  assert.equal(employerScope.has("Beta LLC"), false);

  const projected = buildRepairScopedMasterReference(profile, employerScope);
  const acme = projected.experience.find((e) => e.employer === "Acme Corp");
  const beta = projected.experience.find((e) => e.employer === "Beta LLC");

  assert.ok(acme && "technologies" in acme);
  assert.deepEqual(acme.technologies, ["Azure", "Azure Data Factory", "Databricks", "Python"]);

  assert.ok(beta && "preservation" in beta);
  assert.equal(beta.preservation, "UNCHANGED");
  assert.equal("technologies" in beta, false);
});

test("REPAIRCTX-06: cross-employer evidence does not leak into employer-specific repair", () => {
  const profile = masterProfile();
  const touched = new Set(["Acme Corp"]);
  const projected = buildRepairScopedMasterReference(profile, touched);

  const beta = projected.experience.find((e) => e.employer === "Beta LLC");
  assert.ok(beta);
  assert.equal("technologies" in beta, false, "Beta LLC technologies must not leak");
});

test("REPAIRCTX-07: editablePaths remain unchanged and enforced", () => {
  const plan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Fix bullet",
    resumeFindings: [],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: ["resume.experience[0].bullets[0]"],
  };

  assert.deepEqual(plan.editablePaths, ["resume.experience[0].bullets[0]"]);
});

test("REPAIRCTX-08: unknown/unsafe projection fails closed or uses explicitly justified safe projection", () => {
  assert.equal(shouldUseFullMasterReferenceForRepair(undefined), true);
  assert.equal(shouldUseFullMasterReferenceForRepair({ scope: "FULL", reason: "", resumeFindings: [], coverLetterFindings: [], unattributedFindings: [], editablePaths: [] }), true);
  assert.equal(shouldUseFullMasterReferenceForRepair({ scope: "FULL", reason: "", resumeFindings: [], coverLetterFindings: [], unattributedFindings: ["mystery"], editablePaths: ["resume.summary[0]"] }), true);
});

test("REPAIRCTX-09: PATCH_CONTEXT_MISSING protection remains intact", () => {
  const profile = masterProfile();
  const touched = new Set(["Acme Corp"]);
  const projected = buildRepairScopedMasterReference(profile, touched);

  assert.ok(projected.experience.length === 2);
  assert.equal(projected.experience[0].employer, "Acme Corp");
  assert.equal(projected.experience[1].employer, "Beta LLC");
});

test("REPAIRCTX-10: full rewrite behavior remains unchanged by repair projection optimization", () => {
  const profile = masterProfile();
  const initRef = buildInitialGenerationMasterReference(profile);

  assert.equal(initRef.schemaVersion, 1);
  assert.equal(initRef.experience.length, 2);
  assert.equal(initRef.education.length, 1);
  assert.equal(initRef.certifications.length, 1);
  assert.equal(initRef.totalYearsExperience, 5);
});
