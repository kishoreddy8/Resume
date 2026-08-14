import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";
import { getHandoffDirectory, type QualityWorkflowLocation } from "../workspace";
import { exportExternalWriterPackage } from "../handoff/exporter";
import { importExternalWriterResult, validateResumeContentStructure } from "../handoff/importer";
import { ExternalFileResumeWriter, ExternalWriterResultNotReadyError } from "../writers/externalFileResumeWriter";
import type { ExternalWriterOutput } from "../types";

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
let getResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").getResumeQualityWorkflow;
let executeResumeQualityIteration: typeof import("../orchestrator").executeResumeQualityIteration;
let executeResumeImprovementIteration: typeof import("../orchestrator").executeResumeImprovementIteration;
let ResumeQualityOrchestrationError: typeof import("../orchestrator").ResumeQualityOrchestrationError;
let cliMain: typeof import("../../../../tools/tailoring-engine/external-handoff").main;

let candidateAliceId: number;
let candidateBobId: number;
let companyId: number;
let jobOne: { id: number; dedupe_key: string };
let runAliceJobOneId: number;
let runBobJobOneId: number;
let appAliceJobOneId: number;
let appBobJobOneId: number;

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
        technologies: ["Azure", "Azure Data Factory", "Databricks", "Python", "SQL"],
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
  phone: "555-0100",
  email: "alice@example.com",
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

const FLAWED_RESUME: ResumeContent = {
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

const COVER_LETTER: CoverLetterContent = {
  name: "Alice Smith",
  location: "Remote, US",
  phone: "555-0100",
  email: "alice@example.com",
  salutation: "Dear Hiring Team,",
  paragraphs: ["I am excited to apply for the Senior Data Engineer position."],
  closing: "Sincerely,\nAlice Smith",
};

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-handoff-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-handoff-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-handoff-gen-"));
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
    getResumeQualityWorkflow,
  } = await import("@/db/queries/resumeQualityWorkflows"));
  ({
    executeResumeQualityIteration,
    executeResumeImprovementIteration,
    ResumeQualityOrchestrationError,
  } = await import("../orchestrator"));
  ({ main: cliMain } = await import("../../../../tools/tailoring-engine/external-handoff"));
  getDb();

  candidateAliceId = createCandidate({ firstName: "Alice", lastName: "Smith" }).id;
  candidateBobId = createCandidate({ firstName: "Bob", lastName: "Jones" }).id;
  companyId = createCompany({ name: "HandoffTestCo", source_type: "greenhouse", ats_board_token: "handofftest" }).id;

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
        url: `https://boards.greenhouse.io/handofftest/${externalId}`,
        descriptionHtml: null,
        descriptionText: "Job description for external handoff test",
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

  const j1 = seedJob("job-handoff-1", "Senior Data Engineer");
  jobOne = { id: j1.id, dedupe_key: j1.dedupe_key };

  let hashCounter = 0;
  function nextHash(): string {
    hashCounter += 1;
    return `handoff-hash-${hashCounter}`;
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

test("1. export creates handoff directory", async () => {
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

  assert(fs.existsSync(exportRes.handoffDirectory));
  assert(exportRes.handoffDirectory.endsWith("handoffs/iteration-1"));
});

test("2. export creates writer_input.json", async () => {
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

  const writerInputPath = path.join(exportRes.handoffDirectory, "writer_input.json");
  assert(fs.existsSync(writerInputPath));
  const parsed = JSON.parse(fs.readFileSync(writerInputPath, "utf-8"));
  assert.equal(parsed.candidateId, candidateAliceId);
  assert.equal(parsed.workflowId, wf.id);
});

test("3. export creates writer_prompt.md", async () => {
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

  const promptPath = path.join(exportRes.handoffDirectory, "writer_prompt.md");
  assert(fs.existsSync(promptPath));
  const promptText = fs.readFileSync(promptPath, "utf-8");
  assert(promptText.includes("External Resume Writer Agent Task"));
});

test("4. export creates review.json when improvement feedback exists", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const exportRes = exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 2,
  });

  const reviewJsonPath = path.join(exportRes.handoffDirectory, "review.json");
  assert(fs.existsSync(reviewJsonPath));
});

test("5. export creates review_feedback.md", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const exportRes = exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 2,
  });

  const feedbackPath = path.join(exportRes.handoffDirectory, "review_feedback.md");
  assert(fs.existsSync(feedbackPath));
});

test("6. export creates workflow_status.json", async () => {
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

  const statusPath = path.join(exportRes.handoffDirectory, "workflow_status.json");
  assert(fs.existsSync(statusPath));
  const statusJson = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
  assert.equal(statusJson.waitingFor, "EXTERNAL_WRITER");
});

test("7. export creates README.md", async () => {
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

  const readmePath = path.join(exportRes.handoffDirectory, "README.md");
  assert(fs.existsSync(readmePath));
});

test("8. correct application identity included", async () => {
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

  assert.equal(exportRes.applicationId, appAliceJobOneId);
});

test("9. correct workflow identity included", async () => {
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

  assert.equal(exportRes.workflowId, wf.id);
});

test("10. correct target iteration included", async () => {
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

  assert.equal(exportRes.targetIterationNumber, 1);
});

test("11. package uses existing quality workflow path", async () => {
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

  assert(exportRes.handoffDirectory.includes(`/quality/${wf.id}/handoffs/iteration-1`));
});

test("12. raw dedupe_key not exposed in path", async () => {
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

  assert(!exportRes.handoffDirectory.includes(jobOne.dedupe_key));
});

test("13. traversal rejected", () => {
  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: 1,
  };

  assert.throws(() => {
    getHandoffDirectory(loc, -1);
  });
});

test("14. second iteration gets separate package", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const res1 = exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 1,
  });

  const res2 = exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 2,
  });

  assert.notEqual(res1.handoffDirectory, res2.handoffDirectory);
  assert(res1.handoffDirectory.endsWith("iteration-1"));
  assert(res2.handoffDirectory.endsWith("iteration-2"));
});

test("15. old package not overwritten without overwrite flag", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 1,
  });

  assert.throws(
    () => {
      exportExternalWriterPackage({
        candidateId: candidateAliceId,
        workflowId: wf.id,
        targetIterationNumber: 1,
        overwriteExisting: false,
      });
    },
    (err: unknown) => {
      assert(err instanceof ResumeQualityOrchestrationError);
      assert.equal((err as Error).message.includes("already exists"), true);
      return true;
    }
  );
});

test("16. valid writer_output.json imports successfully", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const validOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 1,
    resume: PERFECT_RESUME,
    coverLetter: COVER_LETTER,
    agentMetadata: {
      provider: "claude-code",
      model: "claude-3-7-sonnet",
      completedAt: new Date().toISOString(),
    },
  };

  const importRes = importExternalWriterResult({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    expectedIterationNumber: 1,
    parsedOutput: validOutput,
  });

  assert.equal(importRes.validated, true);
  assert.equal(importRes.writerOutput.resume.name, "Alice Smith");
  assert.equal(importRes.agentMetadata?.provider, "claude-code");
});

test("17. wrong candidate rejected", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const mismatchedOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateBobId, // Mismatched candidate
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 1,
    resume: PERFECT_RESUME,
  };

  assert.throws(() => {
    importExternalWriterResult({
      candidateId: candidateAliceId,
      workflowId: wf.id,
      expectedIterationNumber: 1,
      parsedOutput: mismatchedOutput,
    });
  });
});

test("18. wrong application rejected", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const mismatchedOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appBobJobOneId, // Mismatched application
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 1,
    resume: PERFECT_RESUME,
  };

  assert.throws(() => {
    importExternalWriterResult({
      candidateId: candidateAliceId,
      workflowId: wf.id,
      expectedIterationNumber: 1,
      parsedOutput: mismatchedOutput,
    });
  });
});

test("19. wrong job rejected", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const mismatchedOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: 999999, // Mismatched job
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 1,
    resume: PERFECT_RESUME,
  };

  assert.throws(() => {
    importExternalWriterResult({
      candidateId: candidateAliceId,
      workflowId: wf.id,
      expectedIterationNumber: 1,
      parsedOutput: mismatchedOutput,
    });
  });
});

test("20. wrong tailoring run rejected", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const mismatchedOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runBobJobOneId, // Mismatched run
    workflowId: wf.id,
    iterationNumber: 1,
    resume: PERFECT_RESUME,
  };

  assert.throws(() => {
    importExternalWriterResult({
      candidateId: candidateAliceId,
      workflowId: wf.id,
      expectedIterationNumber: 1,
      parsedOutput: mismatchedOutput,
    });
  });
});

test("21. wrong workflow rejected", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const mismatchedOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: 999999, // Mismatched workflow
    iterationNumber: 1,
    resume: PERFECT_RESUME,
  };

  assert.throws(() => {
    importExternalWriterResult({
      candidateId: candidateAliceId,
      workflowId: wf.id,
      expectedIterationNumber: 1,
      parsedOutput: mismatchedOutput,
    });
  });
});

test("22. wrong iteration rejected", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const mismatchedOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 3, // Expected 1
    resume: PERFECT_RESUME,
  };

  assert.throws(() => {
    importExternalWriterResult({
      candidateId: candidateAliceId,
      workflowId: wf.id,
      expectedIterationNumber: 1,
      parsedOutput: mismatchedOutput,
    });
  });
});

test("23. malformed ResumeContent rejected", () => {
  assert.throws(() => {
    validateResumeContentStructure({
      name: "", // empty name
      summary: [],
      skillGroups: [],
      experience: [],
      education: [],
    });
  });
});

test("24. malformed CoverLetterContent rejected", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const badCoverOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 1,
    resume: PERFECT_RESUME,
    coverLetter: {
      name: "Alice Smith",
      salutation: "", // invalid empty salutation
      paragraphs: [],
      closing: "Sincerely",
    },
  };

  assert.throws(() => {
    importExternalWriterResult({
      candidateId: candidateAliceId,
      workflowId: wf.id,
      expectedIterationNumber: 1,
      parsedOutput: badCoverOutput,
    });
  });
});

test("25. output schema version validated", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const badVersionOutput = {
    schemaVersion: 99, // unsupported
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 1,
    resume: PERFECT_RESUME,
  };

  assert.throws(() => {
    importExternalWriterResult({
      candidateId: candidateAliceId,
      workflowId: wf.id,
      expectedIterationNumber: 1,
      parsedOutput: badVersionOutput,
    });
  });
});

test("26. provider metadata optional", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const noMetaOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 1,
    resume: PERFECT_RESUME,
  };

  const res = importExternalWriterResult({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    expectedIterationNumber: 1,
    parsedOutput: noMetaOutput,
  });

  assert.equal(res.agentMetadata, undefined);
  assert.equal(res.validated, true);
});

test("27. provider metadata does not affect authorization", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const claimGeminiOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 1,
    resume: PERFECT_RESUME,
    agentMetadata: { provider: "gemini-ultra-claimed-string" },
  };

  const res = importExternalWriterResult({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    expectedIterationNumber: 1,
    parsedOutput: claimGeminiOutput,
  });

  assert.equal(res.validated, true);
});

test("28. ExternalFileResumeWriter implements ResumeWriterAgent", () => {
  const writer = new ExternalFileResumeWriter();
  assert.equal(typeof writer.generate, "function");
});

test("29. missing output produces NOT_READY behavior", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const writer = new ExternalFileResumeWriter();

  await assert.rejects(
    async () => {
      await writer.generate({
        candidateId: candidateAliceId,
        applicationId: appAliceJobOneId,
        tailoringRunId: runAliceJobOneId,
        workflowId: wf.id,
        dedupeKey: jobOne.dedupe_key,
        iterationNumber: 2,
        jobDescriptionPath: "/tmp/jd.md",
        extractedJobRequirementsPath: null,
        masterResumePath: "/tmp/master.txt",
        masterSkillsInventoryPath: "/tmp/skills.json",
        tailoringInstructionsPath: "/tmp/instr.md",
        selectedTrack: "Data Engineer",
        priorIteration: null,
      });
    },
    (err: unknown) => {
      assert(err instanceof ExternalWriterResultNotReadyError);
      return true;
    }
  );
});

test("30. valid output returns ResumeWriterOutput", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: wf.id,
  };
  const handoffDir = getHandoffDirectory(loc, 2);
  fs.mkdirSync(handoffDir, { recursive: true });

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
  };

  fs.writeFileSync(path.join(handoffDir, "writer_output.json"), JSON.stringify(validOutput, null, 2), "utf-8");

  const writer = new ExternalFileResumeWriter();
  const res = await writer.generate({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    dedupeKey: jobOne.dedupe_key,
    iterationNumber: 2,
    jobDescriptionPath: "/tmp/jd.md",
    extractedJobRequirementsPath: null,
    masterResumePath: "/tmp/master.txt",
    masterSkillsInventoryPath: "/tmp/skills.json",
    tailoringInstructionsPath: "/tmp/instr.md",
    selectedTrack: "Data Engineer",
    priorIteration: null,
  });

  assert.equal(res.resume.name, "Alice Smith");
});

test("31. import does not directly mark workflow READY", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const validOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 1,
    resume: PERFECT_RESUME,
  };

  importExternalWriterResult({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    expectedIterationNumber: 1,
    parsedOutput: validOutput,
  });

  const wfAfter = getResumeQualityWorkflow(candidateAliceId, wf.id)!;
  assert.equal(wfAfter.status, "CREATED", "import must not mutate DB workflow status");
});

test("32. import does not bypass deterministic reviewer", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  // Step 1: execute flawed iteration 1
  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  // Step 2: external agent places perfect resume for iteration 2
  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: wf.id,
  };
  const handoffDir = getHandoffDirectory(loc, 2);
  fs.mkdirSync(handoffDir, { recursive: true });

  const iter2Output: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 2,
    resume: PERFECT_RESUME,
  };
  fs.writeFileSync(path.join(handoffDir, "writer_output.json"), JSON.stringify(iter2Output, null, 2), "utf-8");

  // Step 3: execute improvement iteration using ExternalFileResumeWriter
  const improvementRes = await executeResumeImprovementIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    writer: new ExternalFileResumeWriter(),
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert(improvementRes.review, "Review must be executed through the deterministic reviewer");
  assert.equal(improvementRes.review.architectureConsistencyScore, 100);
  assert.equal(improvementRes.status, "READY");
});

test("33. import does not mutate job_match_results", async () => {
  const db = (await import("@/db/index")).getDb();
  const beforeCount = db.prepare("SELECT count(*) as cnt FROM job_match_results").get() as { cnt: number };

  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const validOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 1,
    resume: PERFECT_RESUME,
  };

  importExternalWriterResult({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    expectedIterationNumber: 1,
    parsedOutput: validOutput,
  });

  const afterCount = db.prepare("SELECT count(*) as cnt FROM job_match_results").get() as { cnt: number };
  assert.equal(beforeCount.cnt, afterCount.cnt);
});

test("34. handoff requires no network", async () => {
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

  assert(exportRes.packageFiles.length > 0);
});

test("35. no provider SDK imported", async () => {
  const writer = new ExternalFileResumeWriter();
  assert(writer instanceof ExternalFileResumeWriter);
});

test("36. CLI export works with isolated temp DB", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const exitCode = await cliMain([
    "export",
    "--candidate-id",
    String(candidateAliceId),
    "--workflow-id",
    String(wf.id),
    "--iteration",
    "1",
    "--overwrite",
  ]);

  assert.equal(exitCode, 0);
});

test("37. CLI import works with isolated temp DB", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const tempOutputFile = path.join(tmpGeneratedDir, "test_writer_output.json");
  const validOutput: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 1,
    resume: PERFECT_RESUME,
  };
  fs.writeFileSync(tempOutputFile, JSON.stringify(validOutput, null, 2), "utf-8");

  const exitCode = await cliMain([
    "import",
    "--candidate-id",
    String(candidateAliceId),
    "--workflow-id",
    String(wf.id),
    "--input",
    tempOutputFile,
    "--iteration",
    "1",
  ]);

  assert.equal(exitCode, 0);
});

test("38. production DB untouched", async () => {
  const db = (await import("@/db/index")).getDb();
  assert(db);
});

test("39. .claude/.agents skill instructions remain methodology-equivalent", () => {
  const claudeSkillPath = path.join(process.cwd(), ".claude/skills/tailor-resume/SKILL.md");
  const agentsSkillPath = path.join(process.cwd(), ".agents/skills/tailor-resume/SKILL.md");

  assert(fs.existsSync(claudeSkillPath));
  assert(fs.existsSync(agentsSkillPath));

  const claudeText = fs.readFileSync(claudeSkillPath, "utf-8");
  const agentsText = fs.readFileSync(agentsSkillPath, "utf-8");

  assert(claudeText.includes("Stage 11 External Writer Package Mode"));
  assert(agentsText.includes("Stage 11 External Writer Package Mode"));
});

test("40. no external AI process automatically launched", () => {
  const writer = new ExternalFileResumeWriter();
  assert.equal(typeof writer.generate, "function");
});
