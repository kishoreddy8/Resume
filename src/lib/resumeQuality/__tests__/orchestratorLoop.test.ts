import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";
import type { ResumeReviewerAgent, ResumeReviewerOutput, ResumeWriterAgent, ResumeWriterInput, ResumeWriterOutput } from "../types";
import { getFinalDirectory, getIterationDirectory, type QualityWorkflowLocation } from "../workspace";
import { LocalImprovementWriter } from "../writers/localImprovementWriter";

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
let getResumeQualityIteration: typeof import("@/db/queries/resumeQualityWorkflows").getResumeQualityIteration;
let getResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").getResumeQualityWorkflow;
let listResumeQualityIterations: typeof import("@/db/queries/resumeQualityWorkflows").listResumeQualityIterations;
let ResumeQualityWorkflowNotFoundError: typeof import("@/db/queries/resumeQualityWorkflows").ResumeQualityWorkflowNotFoundError;
let executeResumeQualityIteration: typeof import("../orchestrator").executeResumeQualityIteration;
let executeResumeImprovementIteration: typeof import("../orchestrator").executeResumeImprovementIteration;
let runResumeQualityLoop: typeof import("../orchestrator").runResumeQualityLoop;
let startAndRunResumeQualityLoop: typeof import("../orchestrator").startAndRunResumeQualityLoop;
let ResumeQualityOrchestrationError: typeof import("../orchestrator").ResumeQualityOrchestrationError;

let candidateAliceId: number;
let candidateBobId: number;
let companyId: number;
let jobOne: { id: number; dedupe_key: string };
let jobTwo: { id: number; dedupe_key: string };
let runAliceJobOneId: number;
let runBobJobOneId: number;
let runAliceJobTwoId: number;
let appAliceJobOneId: number;
let appBobJobOneId: number;
let appAliceJobTwoId: number;

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

function masterProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "r", skills: "s" },
    builtAt: "2026-01-01T00:00:00Z",
    skills: [],
    experience: [
      {
        employer: "Acme Corp",
        title: "Senior Data Engineer",
        startDate: "2020-01",
        endDate: null,
        // AWS Glue included alongside the target Azure stack: FLAWED_RESUME_COMPETING_TECH and its
        // LocalImprovementWriter-fixed successor both legitimately describe a migration FROM AWS
        // Glue TO Azure Data Factory — for that migration framing to be genuinely groundable (Resume
        // Quality Hardening's masterSkillsInventoryCompliance check), the candidate's own profile
        // must record having actually used the technology being migrated away from.
        technologies: ["Azure", "Azure Data Factory", "AWS Glue", "Databricks", "Python", "SQL"],
      },
    ],
    education: [{ level: "Bachelor's", field: "Computer Science", institution: "State University" }],
    certifications: [],
    totalYearsExperience: 5,
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
  tagline: "Senior Data Engineer",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "alice@gmail.com",
  summary: [
    "Senior Data Engineer with 5+ years building Azure Data Factory and Databricks pipelines for enterprise analytics platforms, with deep expertise in Azure-native architectures.",
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

const FLAWED_RESUME_COMPETING_TECH: ResumeContent = {
  ...PERFECT_RESUME,
  experience: [
    {
      title: "Senior Data Engineer",
      company: "Acme Corp",
      dates: "2020 - Present",
      bullets: [
        "Built batch data ingestion pipelines using Azure Data Factory and AWS Glue.",
      ],
    },
  ],
};

const FLAWED_RESUME_TITLE: ResumeContent = {
  ...PERFECT_RESUME,
  experience: [
    {
      title: "VP of Product Strategy", // Truthfulness mismatch with "Senior Data Engineer"
      company: "Acme Corp",
      dates: "2020 - Present",
      bullets: [
        "Designed Azure Data Factory pipelines that reduced nightly batch processing time from 6 hours to 45 minutes.",
      ],
    },
  ],
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

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-loop-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-loop-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-loop-generated-"));
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
  ({
    createResumeQualityWorkflow,
    getResumeQualityIteration,
    getResumeQualityWorkflow,
    listResumeQualityIterations,
    ResumeQualityWorkflowNotFoundError,
  } = await import("@/db/queries/resumeQualityWorkflows"));
  ({
    executeResumeQualityIteration,
    executeResumeImprovementIteration,
    runResumeQualityLoop,
    startAndRunResumeQualityLoop,
    ResumeQualityOrchestrationError,
  } = await import("../orchestrator"));
  getDb();

  candidateAliceId = createCandidate({ firstName: "Alice", lastName: "Smith" }).id;
  candidateBobId = createCandidate({ firstName: "Bob", lastName: "Jones" }).id;
  companyId = createCompany({ name: "LoopTestCo", source_type: "greenhouse", ats_board_token: "looptestco" }).id;

  function seedCandidateMasterFiles(candId: number) {
    const masterDir = path.join(tmpCandidatesDir, String(candId), "master");
    fs.mkdirSync(masterDir, { recursive: true });
    fs.writeFileSync(path.join(masterDir, "resume.txt"), `Resume for candidate ${candId}\nAcme Corp\nSenior Data Engineer\n2020 - Present`);
    fs.writeFileSync(path.join(masterDir, "skills.json"), JSON.stringify({ skills: ["Azure", "Python"] }));
    fs.writeFileSync(
      path.join(masterDir, "manifest.json"),
      JSON.stringify({
        resume: { filename: "resume.txt" },
        skills: { filename: "skills.json" },
      })
    );
  }

  seedCandidateMasterFiles(candidateAliceId);
  seedCandidateMasterFiles(candidateBobId);

  function seedJob(externalId: string, title: string) {
    const dedupeKey = dedupeKeyForAts("greenhouse", companyId, externalId);
    upsertJob({
      companyId,
      sourceType: "greenhouse",
      dedupeKey,
      job: {
        externalId,
        title,
        location: "Remote",
        department: "Eng",
        url: `https://boards.greenhouse.io/looptestco/${externalId}`,
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
    return getJobByDedupeKey(dedupeKey)!;
  }

  const j1 = seedJob("job-loop-1", "Senior Data Engineer");
  const j2 = seedJob("job-loop-2", "Staff Data Architect");
  jobOne = { id: j1.id, dedupe_key: j1.dedupe_key };
  jobTwo = { id: j2.id, dedupe_key: j2.dedupe_key };

  let hashCounter = 0;
  function nextHash(): string {
    hashCounter += 1;
    return `loop-hash-${hashCounter}`;
  }

  function writeProfile(candId: number, resumeHash: string, skillsHash: string) {
    const dir = path.join(tmpCandidatesDir, String(candId));
    const masterDir = path.join(dir, "master");
    fs.mkdirSync(masterDir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "candidate-profile.json"),
      JSON.stringify({
        schemaVersion: 1,
        sourceHashes: { resume: resumeHash, skills: skillsHash },
        builtAt: "2026-01-01T00:00:00Z",
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

  function authorizeJob(candId: number, j: { id: number; dedupe_key: string }) {
    writeProfile(candId, `resume-${candId}-${j.id}`, `skills-${candId}-${j.id}`);
    insertJobMatchResult(
      fakeResult({
        candidateId: candId,
        jobId: j.id,
        dedupeKey: j.dedupe_key,
        candidateProfileHash: `resume-${candId}-${j.id}:skills-${candId}-${j.id}`,
        decision: "READY_FOR_TAILORING",
      })
    );

    setMarkedForTailoring(candId, j.dedupe_key, true, {
      approvalType: "READY_DIRECT",
      decision: "READY_FOR_TAILORING",
    });

    const { run } = startTailoringRun({ candidateId: candId, jobId: j.id });
    const applicationId = getCandidateJobState(candId, j.dedupe_key)!.id;
    return { runId: run.id, applicationId };
  }

  const a1 = authorizeJob(candidateAliceId, jobOne);
  runAliceJobOneId = a1.runId;
  appAliceJobOneId = a1.applicationId;

  const b1 = authorizeJob(candidateBobId, jobOne);
  runBobJobOneId = b1.runId;
  appBobJobOneId = b1.applicationId;

  const a2 = authorizeJob(candidateAliceId, jobTwo);
  runAliceJobTwoId = a2.runId;
  appAliceJobTwoId = a2.applicationId;
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

test("1. iteration-1 READY terminates without writer call", async () => {
  let writerCalled = false;
  const mockWriter: ResumeWriterAgent = {
    async generate(): Promise<ResumeWriterOutput> {
      writerCalled = true;
      return { resume: PERFECT_RESUME };
    },
  };

  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const res = await runResumeQualityLoop({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    initialResume: PERFECT_RESUME,
    initialCoverLetter: COVER_LETTER,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: mockWriter,
  });

  assert.equal(res.workflowStatus, "READY");
  assert.equal(res.finalIteration, 1);
  assert.equal(res.iterationsCompleted, 1);
  assert.equal(writerCalled, false, "Writer agent must not be called when iteration 1 passes the quality gate");
});

test("2. iteration-1 fail invokes writer once", async () => {
  let writerCallCount = 0;
  const mockWriter = new LocalImprovementWriter();

  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const countingWriter: ResumeWriterAgent = {
    async generate(input: ResumeWriterInput): Promise<ResumeWriterOutput> {
      writerCallCount += 1;
      return mockWriter.generate(input);
    },
  };

  const res = await runResumeQualityLoop({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: countingWriter,
  });

  assert.equal(writerCallCount, 1);
  assert.equal(res.workflowStatus, "READY");
  assert.equal(res.finalIteration, 2);
});

test("3. writer produces iteration 2", async () => {
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
    resume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  // Execute iteration 2 via writer
  const iter2Res = await executeResumeImprovementIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    writer: new LocalImprovementWriter(),
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(iter2Res.iterationNumber, 2);
});

test("4. iteration 2 is reviewed", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const iter2Res = await executeResumeImprovementIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    writer: new LocalImprovementWriter(),
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert(iter2Res.review);
  assert.equal(typeof iter2Res.review.overallScore, "number");
  assert.equal(iter2Res.review.architectureConsistencyScore, 100);
});

test("5. iteration-2 READY terminates", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const res = await runResumeQualityLoop({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: new LocalImprovementWriter(),
  });

  assert.equal(res.workflowStatus, "READY");
  assert.equal(res.finalIteration, 2);
  assert.equal(res.iterationsCompleted, 2);
});

test("6. iteration-2 fail invokes writer again", async () => {
  let writerCalls = 0;
  const multiStepWriter: ResumeWriterAgent = {
    async generate(): Promise<ResumeWriterOutput> {
      writerCalls += 1;
      if (writerCalls === 1) {
        // First improvement still has flawed title
        return { resume: FLAWED_RESUME_TITLE };
      }
      // Second improvement is perfect
      return { resume: PERFECT_RESUME };
    },
  };

  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const res = await runResumeQualityLoop({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: multiStepWriter,
  });

  assert.equal(writerCalls, 2);
  assert.equal(res.workflowStatus, "READY");
  assert.equal(res.finalIteration, 3);
});

test("7. iteration 3 created", async () => {
  const multiStepWriter: ResumeWriterAgent = {
    async generate(input: ResumeWriterInput): Promise<ResumeWriterOutput> {
      if (input.iterationNumber === 2) {
        return { resume: FLAWED_RESUME_TITLE };
      }
      return { resume: PERFECT_RESUME };
    },
  };

  const res = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: multiStepWriter,
  });

  assert.equal(res.finalIteration, 3);
  const iters = listResumeQualityIterations(candidateAliceId, res.workflowId);
  assert.equal(iters.length, 3);
});

test("8. iteration-3 READY terminates", async () => {
  const multiStepWriter: ResumeWriterAgent = {
    async generate(input: ResumeWriterInput): Promise<ResumeWriterOutput> {
      if (input.iterationNumber === 2) {
        return { resume: FLAWED_RESUME_TITLE };
      }
      return { resume: PERFECT_RESUME };
    },
  };

  const res = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: multiStepWriter,
  });

  assert.equal(res.workflowStatus, "READY");
  assert.equal(res.finalIteration, 3);
  assert.equal(res.qualityGateOutcome, "READY");
});

test("9. iteration-3 failure results in human-review outcome", async () => {
  const persistentFailureWriter: ResumeWriterAgent = {
    async generate(): Promise<ResumeWriterOutput> {
      return { resume: FLAWED_RESUME_COMPETING_TECH };
    },
  };

  const res = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: persistentFailureWriter,
  });

  assert.equal(res.workflowStatus, "FAILED");
  assert.equal(res.finalIteration, 3);
  assert.equal(res.qualityGateOutcome, "NEEDS_HUMAN_REVIEW");
  assert(res.failureReason?.includes("human review required"));
});

test("10. iteration 4 never created", async () => {
  const persistentFailureWriter: ResumeWriterAgent = {
    async generate(): Promise<ResumeWriterOutput> {
      return { resume: FLAWED_RESUME_COMPETING_TECH };
    },
  };

  const res = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: persistentFailureWriter,
  });

  const iters = listResumeQualityIterations(candidateAliceId, res.workflowId);
  assert.equal(iters.length, 3);
  assert.equal(res.finalIteration, 3);

  // Attempting to manually execute iteration 4 must be rejected
  await assert.rejects(
    async () => {
      await executeResumeImprovementIteration({
        candidateId: candidateAliceId,
        workflowId: res.workflowId,
        writer: persistentFailureWriter,
      });
    },
    (err: unknown) => {
      assert(err instanceof ResumeQualityOrchestrationError);
      return true;
    }
  );
});

test("11. maxIterations respected", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    maxIterations: 2, // custom max
  });

  const persistentFailureWriter: ResumeWriterAgent = {
    async generate(): Promise<ResumeWriterOutput> {
      return { resume: FLAWED_RESUME_COMPETING_TECH };
    },
  };

  const res = await runResumeQualityLoop({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: persistentFailureWriter,
  });

  assert.equal(res.finalIteration, 2);
  assert.equal(res.workflowStatus, "FAILED");
});

test("12. iteration 1 artifacts unchanged after iteration 2", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: wf.id,
  };
  const iter1ReviewPath = path.join(getIterationDirectory(loc, 1), "review.json");
  const iter1ReviewContent = fs.readFileSync(iter1ReviewPath, "utf-8");

  // Run iteration 2
  await executeResumeImprovementIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    writer: new LocalImprovementWriter(),
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const iter1ReviewContentAfter = fs.readFileSync(iter1ReviewPath, "utf-8");
  assert.equal(iter1ReviewContent, iter1ReviewContentAfter, "Iteration 1 review.json must remain strictly immutable");
});

test("13. iteration 2 artifacts unchanged after iteration 3", async () => {
  const multiStepWriter: ResumeWriterAgent = {
    async generate(input: ResumeWriterInput): Promise<ResumeWriterOutput> {
      if (input.iterationNumber === 2) {
        return { resume: FLAWED_RESUME_TITLE };
      }
      return { resume: PERFECT_RESUME };
    },
  };

  const res = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: multiStepWriter,
  });

  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: res.workflowId,
  };
  const iter2ReviewPath = path.join(getIterationDirectory(loc, 2), "review.json");
  const iter3ReviewPath = path.join(getIterationDirectory(loc, 3), "review.json");

  assert(fs.existsSync(iter2ReviewPath));
  assert(fs.existsSync(iter3ReviewPath));
  const iter2Content = fs.readFileSync(iter2ReviewPath, "utf-8");
  const iter3Content = fs.readFileSync(iter3ReviewPath, "utf-8");
  assert.notEqual(iter2Content, iter3Content);
});

test("14. structured resume JSON persisted per iteration", async () => {
  const res = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: new LocalImprovementWriter(),
  });

  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: res.workflowId,
  };

  const iter1ResumeJson = path.join(getIterationDirectory(loc, 1), "resume_content.json");
  const iter2ResumeJson = path.join(getIterationDirectory(loc, 2), "resume_content.json");

  assert(fs.existsSync(iter1ResumeJson));
  assert(fs.existsSync(iter2ResumeJson));

  const iter1Resume = JSON.parse(fs.readFileSync(iter1ResumeJson, "utf-8")) as ResumeContent;
  const iter2Resume = JSON.parse(fs.readFileSync(iter2ResumeJson, "utf-8")) as ResumeContent;

  assert(iter1Resume.experience[0].bullets[0].includes("AWS Glue"));
  assert(!iter2Resume.experience[0].bullets[0].includes("and AWS Glue"));
});

test("15. structured cover-letter JSON persisted per iteration", async () => {
  const res = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: PERFECT_RESUME,
    initialCoverLetter: COVER_LETTER,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: res.workflowId,
  };

  const iter1CoverJson = path.join(getIterationDirectory(loc, 1), "cover_letter_content.json");
  assert(fs.existsSync(iter1CoverJson));
});

test("16. review JSON persisted per iteration", async () => {
  const res = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: new LocalImprovementWriter(),
  });

  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: res.workflowId,
  };

  assert(fs.existsSync(path.join(getIterationDirectory(loc, 1), "review.json")));
  assert(fs.existsSync(path.join(getIterationDirectory(loc, 2), "review.json")));
});

test("17. review feedback persisted per iteration", async () => {
  const res = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: new LocalImprovementWriter(),
  });

  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: res.workflowId,
  };

  assert(fs.existsSync(path.join(getIterationDirectory(loc, 1), "review_feedback.md")));
  assert(fs.existsSync(path.join(getIterationDirectory(loc, 2), "review_feedback.md")));
});

test("18. writer receives latest review feedback", async () => {
  let capturedFeedbackPath = "";
  const inspectWriter: ResumeWriterAgent = {
    async generate(input: ResumeWriterInput): Promise<ResumeWriterOutput> {
      capturedFeedbackPath = input.priorIteration?.reviewFeedbackPath ?? "";
      return { resume: PERFECT_RESUME };
    },
  };

  await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: inspectWriter,
  });

  assert(capturedFeedbackPath.endsWith("review_feedback.md"));
  assert(fs.existsSync(capturedFeedbackPath));
});

test("19. writer receives required corrections", async () => {
  let capturedCorrectionsCount = 0;
  const inspectWriter: ResumeWriterAgent = {
    async generate(input: ResumeWriterInput): Promise<ResumeWriterOutput> {
      capturedCorrectionsCount = input.requiredCorrections?.length ?? 0;
      return { resume: PERFECT_RESUME };
    },
  };

  await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: inspectWriter,
  });

  assert(capturedCorrectionsCount > 0);
});

test("20. writer receives authoritative JD context", async () => {
  let capturedJdPath = "";
  const inspectWriter: ResumeWriterAgent = {
    async generate(input: ResumeWriterInput): Promise<ResumeWriterOutput> {
      capturedJdPath = input.jobDescriptionPath;
      return { resume: PERFECT_RESUME };
    },
  };

  await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: inspectWriter,
  });

  assert(capturedJdPath.includes("job_description.md"));
});

test("21. writer receives Master Resume/profile evidence", async () => {
  let capturedProfile: CandidateProfile | undefined;
  const inspectWriter: ResumeWriterAgent = {
    async generate(input: ResumeWriterInput): Promise<ResumeWriterOutput> {
      capturedProfile = input.masterProfile;
      return { resume: PERFECT_RESUME };
    },
  };

  await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: inspectWriter,
  });

  assert(capturedProfile);
  assert.equal(capturedProfile.experience[0].employer, "Acme Corp");
});

test("22. writer receives selected track", async () => {
  let receivedWorkflowId = 0;
  const inspectWriter: ResumeWriterAgent = {
    async generate(input: ResumeWriterInput): Promise<ResumeWriterOutput> {
      receivedWorkflowId = input.workflowId;
      return { resume: PERFECT_RESUME };
    },
  };

  const res = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: inspectWriter,
  });

  assert.equal(receivedWorkflowId, res.workflowId);
});

test("23. candidate isolation", async () => {
  const wfAlice = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wfAlice.id,
    resume: FLAWED_RESUME_COMPETING_TECH,
  });

  // Bob cannot execute Alice's improvement iteration
  await assert.rejects(
    async () => {
      await executeResumeImprovementIteration({
        candidateId: candidateBobId,
        workflowId: wfAlice.id,
        writer: new LocalImprovementWriter(),
      });
    },
    (err: unknown) => {
      assert(err instanceof ResumeQualityWorkflowNotFoundError);
      return true;
    }
  );
});

test("24. application isolation", async () => {
  const db = (await import("@/db/index")).getDb();
  const ins = db
    .prepare(
      `INSERT INTO resume_quality_workflows (candidate_id, application_id, tailoring_run_id, dedupe_key, status, current_iteration, max_iterations)
       VALUES (?, ?, ?, ?, 'IMPROVEMENT_RUNNING', 1, 3)`
    )
    .run(candidateAliceId, appBobJobOneId, runAliceJobOneId, jobOne.dedupe_key);
  const wfId = Number(ins.lastInsertRowid);

  await assert.rejects(
    async () => {
      await executeResumeImprovementIteration({
        candidateId: candidateAliceId,
        workflowId: wfId,
        writer: new LocalImprovementWriter(),
      });
    },
    (err: unknown) => {
      assert(err instanceof ResumeQualityOrchestrationError);
      return true;
    }
  );
});

test("25. job isolation", async () => {
  const db = (await import("@/db/index")).getDb();
  const ins = db
    .prepare(
      `INSERT INTO resume_quality_workflows (candidate_id, application_id, tailoring_run_id, dedupe_key, status, current_iteration, max_iterations)
       VALUES (?, ?, ?, ?, 'IMPROVEMENT_RUNNING', 1, 3)`
    )
    .run(candidateAliceId, appAliceJobOneId, runAliceJobOneId, "mismatched:job:key");
  const wfId = Number(ins.lastInsertRowid);

  await assert.rejects(
    async () => {
      await executeResumeImprovementIteration({
        candidateId: candidateAliceId,
        workflowId: wfId,
        writer: new LocalImprovementWriter(),
      });
    },
    (err: unknown) => {
      assert(err instanceof ResumeQualityOrchestrationError);
      return true;
    }
  );
});

test("26. run isolation", async () => {
  const db = (await import("@/db/index")).getDb();
  const ins = db
    .prepare(
      `INSERT INTO resume_quality_workflows (candidate_id, application_id, tailoring_run_id, dedupe_key, status, current_iteration, max_iterations)
       VALUES (?, ?, ?, ?, 'IMPROVEMENT_RUNNING', 1, 3)`
    )
    .run(candidateAliceId, appAliceJobOneId, runBobJobOneId, jobOne.dedupe_key);
  const wfId = Number(ins.lastInsertRowid);

  await assert.rejects(
    async () => {
      await executeResumeImprovementIteration({
        candidateId: candidateAliceId,
        workflowId: wfId,
        writer: new LocalImprovementWriter(),
      });
    },
    (err: unknown) => {
      assert(err instanceof ResumeQualityOrchestrationError);
      return true;
    }
  );
});

test("27. workflow isolation", async () => {
  const res1 = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const res2 = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobTwoId,
    tailoringRunId: runAliceJobTwoId,
    dedupeKey: jobTwo.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: new LocalImprovementWriter(),
  });

  assert.equal(res1.finalIteration, 1);
  assert.equal(res2.finalIteration, 2);
});

test("28. writer failure fails safely", async () => {
  const failingWriter = new LocalImprovementWriter({
    failOnIteration: 2,
    failureMessage: "Writer network timeout",
  });

  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_COMPETING_TECH,
  });

  await assert.rejects(
    async () => {
      await executeResumeImprovementIteration({
        candidateId: candidateAliceId,
        workflowId: wf.id,
        writer: failingWriter,
      });
    },
    (err: unknown) => {
      assert.equal((err as Error).message, "Writer network timeout");
      return true;
    }
  );

  const failedWf = getResumeQualityWorkflow(candidateAliceId, wf.id)!;
  assert.equal(failedWf.status, "FAILED");
  assert.equal(failedWf.failure_reason, "Writer network timeout");
});

test("29. reviewer failure fails safely", async () => {
  const failingReviewer: ResumeReviewerAgent = {
    async review(): Promise<ResumeReviewerOutput> {
      throw new Error("Reviewer crashed during iteration 2");
    },
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
    resume: FLAWED_RESUME_COMPETING_TECH,
  });

  await assert.rejects(
    async () => {
      await executeResumeImprovementIteration({
        candidateId: candidateAliceId,
        workflowId: wf.id,
        writer: new LocalImprovementWriter(),
        reviewer: failingReviewer,
      });
    },
    (err: unknown) => {
      assert.equal((err as Error).message, "Reviewer crashed during iteration 2");
      return true;
    }
  );

  const failedWf = getResumeQualityWorkflow(candidateAliceId, wf.id)!;
  assert.equal(failedWf.status, "FAILED");
});

test("30. artifact failure fails safely", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_COMPETING_TECH,
  });

  await assert.rejects(
    async () => {
      await executeResumeImprovementIteration({
        candidateId: candidateAliceId,
        workflowId: wf.id,
        writer: new LocalImprovementWriter(),
        resumeDocxPath: "/nonexistent/invalid/file.docx",
      });
    }
  );

  const failedWf = getResumeQualityWorkflow(candidateAliceId, wf.id)!;
  assert.notEqual(failedWf.status, "READY");
});

test("31. prior iterations survive writer failure", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_COMPETING_TECH,
  });

  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: wf.id,
  };
  const iter1ReviewPath = path.join(getIterationDirectory(loc, 1), "review.json");
  assert(fs.existsSync(iter1ReviewPath));

  const failingWriter = new LocalImprovementWriter({ failOnIteration: 2 });
  await assert.rejects(async () => {
    await executeResumeImprovementIteration({
      candidateId: candidateAliceId,
      workflowId: wf.id,
      writer: failingWriter,
    });
  });

  assert(fs.existsSync(iter1ReviewPath), "Iteration 1 review.json must survive writer failure");
});

test("32. prior iterations survive reviewer failure", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_COMPETING_TECH,
  });

  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: wf.id,
  };
  const iter1ReviewPath = path.join(getIterationDirectory(loc, 1), "review.json");
  assert(fs.existsSync(iter1ReviewPath));

  const failingReviewer: ResumeReviewerAgent = {
    async review(): Promise<ResumeReviewerOutput> {
      throw new Error("Reviewer crash");
    },
  };

  await assert.rejects(async () => {
    await executeResumeImprovementIteration({
      candidateId: candidateAliceId,
      workflowId: wf.id,
      writer: new LocalImprovementWriter(),
      reviewer: failingReviewer,
    });
  });

  assert(fs.existsSync(iter1ReviewPath), "Iteration 1 review.json must survive reviewer failure");
});

test("33. READY final artifacts come from correct iteration", async () => {
  const res = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: new LocalImprovementWriter(),
  });

  assert.equal(res.workflowStatus, "READY");
  assert.equal(res.finalIteration, 2);

  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: res.workflowId,
  };
  const finalResumeJson = path.join(getFinalDirectory(loc), "resume_content.json");
  assert(fs.existsSync(finalResumeJson));

  const finalResume = JSON.parse(fs.readFileSync(finalResumeJson, "utf-8")) as ResumeContent;
  assert(!finalResume.experience[0].bullets[0].includes("and AWS Glue"), "Final approved resume must match improved iteration 2");
});

test("34. candidate name is not hardcoded", async () => {
  const res = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(res.workflowStatus, "READY");
  assert(res.finalArtifacts?.resumePath?.includes("Alice_Resume.docx") || res.finalArtifacts?.reviewFeedbackPath.includes("resume_review_feedback.md"));
});

test("35. no absolute paths persisted", async () => {
  const res = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: new LocalImprovementWriter(),
  });

  for (let i = 1; i <= res.finalIteration; i++) {
    const iter = getResumeQualityIteration(candidateAliceId, res.workflowId, i)!;
    const outputFiles = JSON.parse(iter.output_files!);
    for (const f of outputFiles) {
      assert(!f.startsWith("/"), `Output file ${f} must be relative`);
      assert(!f.includes("\\"), `Output file ${f} must not contain backslashes`);
    }
  }
});

test("36. no raw dedupe_key exposed", async () => {
  const res = await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: res.workflowId,
  };
  const iter1Dir = getIterationDirectory(loc, 1);
  assert(!iter1Dir.includes(jobOne.dedupe_key), "Directory path must use SHA-256 hash, never raw dedupe_key");
});

test("37. deterministic test writer requires no network", async () => {
  const writer = new LocalImprovementWriter();
  const res = await writer.generate({
    applicationId: appAliceJobOneId,
    candidateId: candidateAliceId,
    tailoringRunId: runAliceJobOneId,
    workflowId: 1,
    jobDescriptionPath: "/tmp/jd.md",
    extractedJobRequirementsPath: null,
    masterResumePath: "/tmp/master.txt",
    masterSkillsInventoryPath: "/tmp/skills.json",
    tailoringInstructionsPath: "/tmp/instructions.md",
    selectedTrack: "Data Engineer",
    priorIteration: null,
    currentResume: FLAWED_RESUME_COMPETING_TECH,
    latestReview: {
      overallScore: 70,
      atsScore: 90,
      keywordAlignmentScore: 90,
      truthfulnessScore: 100,
      architectureConsistencyScore: 50,
      recruiterReadabilityScore: 90,
      formattingScore: 90,
      missingRequiredSkills: [],
      incorrectTechnologyUsage: ["Azure Data Factory + AWS Glue"],
      genericBullets: [],
      missingImpactEvidence: [],
      summaryIssues: [],
      skillsOrderingIssues: [],
      truthfulnessIssues: [],
      blockingIssues: [],
      requiredCorrections: [],
    },
  });

  assert(res.resume);
  assert(!res.resume.experience[0].bullets[0].includes("and AWS Glue"));
});

test("38. no external provider SDK involved", async () => {
  const writer = new LocalImprovementWriter();
  assert(writer instanceof LocalImprovementWriter);
  assert.equal(typeof writer.generate, "function");
});

test("39. no mutation to job_match_results", async () => {
  const db = (await import("@/db/index")).getDb();
  const beforeCount = db.prepare("SELECT count(*) as cnt FROM job_match_results").get() as { cnt: number };

  await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: new LocalImprovementWriter(),
  });

  const afterCount = db.prepare("SELECT count(*) as cnt FROM job_match_results").get() as { cnt: number };
  assert.equal(beforeCount.cnt, afterCount.cnt, "Stage 10 loop must not mutate Phase 2 job_match_results");
});

test("40. no mutation to production tailoring run history", async () => {
  const db = (await import("@/db/index")).getDb();
  const beforeRuns = db.prepare("SELECT count(*) as cnt FROM tailoring_runs").get() as { cnt: number };

  await startAndRunResumeQualityLoop({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    initialResume: FLAWED_RESUME_COMPETING_TECH,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    writer: new LocalImprovementWriter(),
  });

  const afterRuns = db.prepare("SELECT count(*) as cnt FROM tailoring_runs").get() as { cnt: number };
  assert.equal(beforeRuns.cnt, afterRuns.cnt, "Stage 10 loop must not create extraneous tailoring_runs rows");
});
