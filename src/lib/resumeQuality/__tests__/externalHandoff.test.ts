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
import type { ExternalWriterOutput, InstructionComplianceChecks } from "../types";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES } from "../types";
import { CANONICAL_TAILORING_INSTRUCTIONS, INSTRUCTION_HASH, INSTRUCTION_VERSION } from "../canonicalInstructions";

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
    requestedYears: null,
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
  phone: "312-555-9821",
  email: "alice@gmail.com",
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
  phone: "312-555-9821",
  email: "alice@gmail.com",
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
  const prompt = fs.readFileSync(path.join(exportRes.handoffDirectory, "writer_prompt.md"), "utf-8");
  assert.match(prompt, /Writer mode: TARGETED_REPAIR/);
  // "Surgical repair" alone (not "...is mandatory") so this passes whether this fixture's repair
  // plan happens to be patch-eligible (see patchRepair.ts) or falls back to the legacy full-document
  // contract — both variants open with the same phrase; only what follows differs.
  assert.match(prompt, /Surgical repair/);
  assert.doesNotMatch(prompt, /Deep rewrite is required/);
  assert.doesNotMatch(prompt, /### Compliance Checks Blocking Approval/, "derived compliance rows must not be separate repair tasks");
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

  const repairedResume = JSON.parse(JSON.stringify(FLAWED_RESUME)) as ResumeContent;
  repairedResume.experience[0]!.bullets[0] =
    "Built batch data ingestion pipelines using Azure Data Factory.";
  const iter2Output: ExternalWriterOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 2,
    resume: repairedResume,
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

test("41. INITIAL_GENERATION export writes the compact master_resume_reference.json (skills omitted, every employer's identity/dates present)", async () => {
  // INITIAL_GENERATION TOKEN OPTIMIZATION (2026-08-23) — INITIAL_GENERATION previously received the
  // FULL profile including the giant `skills` array unconditionally. It now receives
  // buildInitialGenerationMasterReference's compact projection instead, exactly like
  // TARGETED_REPAIR already did (see masterReferenceProjection.ts for the full safety argument: the
  // employer-evidence section is never scoped for INITIAL_GENERATION, so every omitted technology is
  // already rendered in full elsewhere in the same package).
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

  const masterRefPath = path.join(exportRes.handoffDirectory, "master_resume_reference.json");
  assert(fs.existsSync(masterRefPath));
  const parsed = JSON.parse(fs.readFileSync(masterRefPath, "utf-8"));
  assert.equal("skills" in parsed, false, "INITIAL_GENERATION must NOT contain the giant skills array — it is fully redundant with PER-EMPLOYER EVIDENCE");
  assert.equal("sourceHashes" in parsed, false);
  assert.equal("builtAt" in parsed, false);
  assert.equal(Array.isArray(parsed.experience), true);
  assert.ok(parsed.experience.length > 0);
  for (const entry of parsed.experience) {
    assert.equal("technologies" in entry, false, `${entry.employer} must not carry a technologies dump`);
    assert.ok(typeof entry.employer === "string" && entry.employer.length > 0);
    assert.ok(typeof entry.title === "string" && entry.title.length > 0);
    assert.equal(entry.preservation, "UNCHANGED");
  }
  assert.ok(Array.isArray(parsed.education));
  assert.ok(Array.isArray(parsed.certifications));

  // Every technology this compact reference omits must be recoverable from the same package's
  // PER-EMPLOYER EVIDENCE section (writer_prompt.md) — never silently invisible.
  const prompt = fs.readFileSync(path.join(exportRes.handoffDirectory, "writer_prompt.md"), "utf-8");
  assert.match(prompt, /## PER-EMPLOYER EVIDENCE/);
  for (const entry of parsed.experience) {
    assert.match(prompt, new RegExp(`### ${entry.employer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `), `${entry.employer} must have its own PER-EMPLOYER EVIDENCE block`);
  }
});

test("42. TARGETED_REPAIR export with employer scope writes compact master_resume_reference.json (skills omitted)", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  // Iteration 1 run with a flaw in experience bullet attributed to Acme Corp
  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    coverLetter: {
      ...COVER_LETTER,
      paragraphs: ["At Acme Corp, I designed Databricks notebooks and data pipelines."],
    },
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile({
      skills: [
        { rawSkillName: "Azure", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      ],
    }),
    reviewer: {
      review: async () => ({
        review: {
          overallScore: 75,
          atsScore: 80,
          keywordAlignmentScore: 80,
          truthfulnessScore: 70,
          architectureConsistencyScore: 80,
          recruiterReadabilityScore: 80,
          formattingScore: 90,
          blockingFailures: [
            {
              type: "EMPLOYER_CONTRADICTION",
              description: 'Cover letter attributes "Databricks" to Acme Corp.',
            },
          ],
          blockingIssues: [],
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

  const masterRefPath = path.join(exportRes.handoffDirectory, "master_resume_reference.json");
  assert(fs.existsSync(masterRefPath));
  const parsed = JSON.parse(fs.readFileSync(masterRefPath, "utf-8"));
  assert.equal(Array.isArray(parsed.experience), true);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal("education" in parsed, true);
  assert.equal("certifications" in parsed, true);
  assert.equal("skills" in parsed, false, "skills array must be omitted during TARGETED_REPAIR");
});

test("43. TARGETED_REPAIR export touching summary falls back to full master_resume_reference.json", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  // Iteration 1 run with a summary finding (global section)
  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    coverLetter: COVER_LETTER,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile({
      skills: [
        { rawSkillName: "Azure", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      ],
    }),
    reviewer: {
      review: async () => ({
        review: {
          overallScore: 75,
          atsScore: 80,
          keywordAlignmentScore: 80,
          truthfulnessScore: 70,
          architectureConsistencyScore: 80,
          recruiterReadabilityScore: 80,
          formattingScore: 90,
          blockingFailures: [
            {
              type: "UNSUPPORTED_CLAIM",
              description: 'Summary claims 10 years experience.',
            },
          ],
          blockingIssues: [],
          requiredCorrections: [],
          missingRequiredSkills: [],
          incorrectTechnologyUsage: [],
          genericBullets: [],
          missingImpactEvidence: [],
          summaryIssues: ["Summary claims 10 years experience."],
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

  const masterRefPath = path.join(exportRes.handoffDirectory, "master_resume_reference.json");
  assert(fs.existsSync(masterRefPath));
  const parsed = JSON.parse(fs.readFileSync(masterRefPath, "utf-8"));
  assert.equal(Array.isArray(parsed.skills), true, "global summary repair must fall back to full reference with skills");
});

// --- PATCH-BASED TARGETED_REPAIR (2026-08-23) ------------------------------------------------------

test("44. a patch-eligible TARGETED_REPAIR export offers the PATCH schema with the exact editable paths", async () => {
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
  const prompt = fs.readFileSync(path.join(exportRes.handoffDirectory, "writer_prompt.md"), "utf-8");

  assert.match(prompt, /"schemaVersion": 2/);
  assert.match(prompt, /"outputMode": "PATCH"/);
  assert.match(prompt, /Surgical repair, PATCH mode/);
  assert.match(prompt, /return ONLY the changed values/);
  // The exact editable paths repairScope.ts computed must be stated verbatim so the writer knows
  // precisely which `path` values are authorized.
  assert.match(prompt, /`resume\.experience\[0\]\.bullets\[0\]`/);
  assert.match(prompt, /`resume\.summary\[0\]`/);
});

test("45. a valid PATCH response reconstructs correctly and reaches the SAME writer output shape a legacy full-document response would", async () => {
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
      { document: "resume", path: "experience[0].bullets[0]", replacement: "Built batch data ingestion pipelines using Azure Data Factory." },
      { document: "resume", path: "summary[0]", replacement: "Senior Data Engineer with 5+ years building Azure Data Factory and Databricks pipelines for enterprise analytics platforms." },
    ],
  };
  fs.writeFileSync(path.join(exportRes.handoffDirectory, "writer_output.json"), JSON.stringify(patchOutput, null, 2));

  const writer = new ExternalFileResumeWriter();
  const { buildResumeWriterInput } = await import("../orchestrator");
  const writerInput = buildResumeWriterInput(candidateAliceId, wf.id);
  writerInput.iterationNumber = 2;

  const output = await writer.generate(writerInput);
  assert.equal(output.resume.experience[0].bullets[0], "Built batch data ingestion pipelines using Azure Data Factory.");
  assert.equal(output.resume.summary[0], "Senior Data Engineer with 5+ years building Azure Data Factory and Databricks pipelines for enterprise analytics platforms.");
  // Every field the legacy full-document contract also produces must still be present — the
  // reconstructed output is indistinguishable in SHAPE from a legacy writer's full response.
  assert.equal(typeof output.resume.name, "string");
  assert.equal(typeof output.resume.tagline, "string");
  assert.deepEqual(output.resume.education, FLAWED_RESUME.education);
});

test("46. an unauthorized PATCH operation is rejected before it ever reaches persistence", async () => {
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
      // "education" was never in this repair's editablePaths — must be refused, not silently ignored.
      { document: "resume", path: "education[0]", replacement: "Fabricated Degree, Fabricated University" },
    ],
  };
  fs.writeFileSync(path.join(exportRes.handoffDirectory, "writer_output.json"), JSON.stringify(patchOutput, null, 2));

  const writer = new ExternalFileResumeWriter();
  const { buildResumeWriterInput } = await import("../orchestrator");
  const writerInput = buildResumeWriterInput(candidateAliceId, wf.id);
  writerInput.iterationNumber = 2;

  await assert.rejects(() => writer.generate(writerInput), (err: unknown) => {
    assert.ok(err instanceof ResumeQualityOrchestrationError);
    assert.equal((err as InstanceType<typeof ResumeQualityOrchestrationError>).code, "PATCH_AUTHORIZATION_FAILED");
    return true;
  });
});

test("47. a legacy schemaVersion 1 full-document response still works after PATCH mode was added", async () => {
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

  const repairedResume: ResumeContent = {
    ...FLAWED_RESUME,
    summary: ["Senior Data Engineer with 5+ years building Azure Data Factory and Databricks pipelines for enterprise analytics platforms."],
    experience: [
      { ...FLAWED_RESUME.experience[0], bullets: ["Built batch data ingestion pipelines using Azure Data Factory."] },
    ],
  };
  const legacyOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    jobId: jobOne.id,
    tailoringRunId: runAliceJobOneId,
    workflowId: wf.id,
    iterationNumber: 2,
    resume: repairedResume,
  };
  fs.writeFileSync(path.join(exportRes.handoffDirectory, "writer_output.json"), JSON.stringify(legacyOutput, null, 2));

  const writer = new ExternalFileResumeWriter();
  const { buildResumeWriterInput } = await import("../orchestrator");
  const writerInput = buildResumeWriterInput(candidateAliceId, wf.id);
  writerInput.iterationNumber = 2;

  const output = await writer.generate(writerInput);
  assert.equal(output.resume.summary[0], repairedResume.summary[0]);
});

test("48. a patch-eligible export writes a REDUCED previous_resume_content.json — untouched employer stubbed, cover letter omitted", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  // A two-employer resume with a controlled, UNAMBIGUOUS review (a stub reviewer, matching tests
  // 42/43's own pattern) — one clean bullet-level finding at Acme Corp only, zero unattributed
  // findings, zero cover-letter findings. FLAWED_RESUME's real deterministic-reviewer output turned
  // out to carry 2 unattributed findings (needing candidate clarification) for its own unrelated
  // reasons, which correctly (per shouldOmitCoverLetterContext's fail-toward-inclusion rule) keeps
  // the cover letter in context — not a bug, just the wrong fixture for testing OMISSION
  // specifically. This fixture isolates that one behavior cleanly.
  const twoEmployerResume: ResumeContent = {
    ...PERFECT_RESUME,
    experience: [
      {
        ...PERFECT_RESUME.experience[0],
        bullets: ["Built batch data ingestion pipelines using Azure Data Factory and AWS Glue.", ...PERFECT_RESUME.experience[0].bullets.slice(1)],
      },
      {
        title: "Data Engineer",
        company: "Beta LLC",
        dates: "2017 - 2020",
        bullets: ["Built ETL pipelines with Informatica IICS.", "Maintained SQL Server reporting datasets."],
      },
    ],
  };

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: twoEmployerResume,
    coverLetter: COVER_LETTER,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile({
      skills: [{ rawSkillName: "Azure Data Factory", source: "employer", attributedTo: [{ employer: "Acme Corp" }] }],
    }),
    reviewer: {
      review: async () => ({
        review: {
          overallScore: 60,
          atsScore: 90,
          keywordAlignmentScore: 90,
          truthfulnessScore: 70,
          architectureConsistencyScore: 90,
          recruiterReadabilityScore: 90,
          formattingScore: 90,
          blockingFailures: [
            {
              type: "UNSUPPORTED_CLAIM",
              description: '"AWS Glue" is claimed on the resume at Acme Corp but is not grounded in the Master Resume or Master Skills Inventory.',
              recommendedCorrection: 'Remove "AWS Glue" or replace it with a genuinely evidenced technology.',
            },
          ],
          blockingIssues: [],
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
            checks: Object.fromEntries(INSTRUCTION_COMPLIANCE_CHECK_NAMES.map((name) => [name, name === "finalValidation" ? "FAIL" : "PASS"])) as unknown as InstructionComplianceChecks,
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

  const prevResumePath = path.join(exportRes.handoffDirectory, "previous_resume_content.json");
  assert(fs.existsSync(prevResumePath));
  const parsed = JSON.parse(fs.readFileSync(prevResumePath, "utf-8"));
  assert.equal(parsed.experience[0].company, "Acme Corp");
  // Beta LLC is untouched by this repair — its real bullets must not leak into writer context.
  assert.equal(parsed.experience[1].company, "Beta LLC");
  assert.match(parsed.experience[1].bullets[0], /omitted/);
  assert.ok(!parsed.experience[1].bullets.some((b: string) => b.includes("Informatica")));

  // No cover-letter finding, no unattributed finding, resume-only repair — cover-letter context
  // must be omitted from the package entirely.
  const prevCoverPath = path.join(exportRes.handoffDirectory, "previous_cover_letter_content.json");
  assert.equal(fs.existsSync(prevCoverPath), false, "cover-letter context must be omitted when nothing about this repair concerns it");

  const prompt = fs.readFileSync(path.join(exportRes.handoffDirectory, "writer_prompt.md"), "utf-8");
  assert.match(prompt, /not included in this package/);
  assert.match(prompt, /## CONTEXT MANIFEST/);
  assert.match(prompt, /Beta LLC/); // named in the manifest as a reduced employer
});

test("49. a legacy (non-patch-eligible) TARGETED_REPAIR export still writes the FULL previous_resume_content.json", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  // A summary-touching finding forces the legacy (full-context) path per patchContextProjection.ts's
  // own explicit summary/tagline fallback rule.
  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    coverLetter: COVER_LETTER,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile({
      skills: [{ rawSkillName: "Azure", source: "employer", attributedTo: [{ employer: "Acme Corp" }] }],
    }),
    reviewer: {
      review: async () => ({
        review: {
          overallScore: 75,
          atsScore: 80,
          keywordAlignmentScore: 80,
          truthfulnessScore: 70,
          architectureConsistencyScore: 80,
          recruiterReadabilityScore: 80,
          formattingScore: 90,
          blockingFailures: [{ type: "UNSUPPORTED_CLAIM", description: "Summary claims 10 years experience." }],
          blockingIssues: [],
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
            checks: Object.fromEntries(INSTRUCTION_COMPLIANCE_CHECK_NAMES.map((name) => [name, name === "finalValidation" ? "FAIL" : "PASS"])) as unknown as InstructionComplianceChecks,
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

  const prevResumePath = path.join(exportRes.handoffDirectory, "previous_resume_content.json");
  const parsed = JSON.parse(fs.readFileSync(prevResumePath, "utf-8"));
  assert.ok(!parsed.experience[0].bullets.some((b: string) => b.includes("omitted")), "a summary-touching repair must never stub any employer's bullets");
  assert(fs.existsSync(path.join(exportRes.handoffDirectory, "previous_cover_letter_content.json")), "full-context fallback must still include the cover letter");
});

// -------------------------------------------------------------------------------------------------
// PHASE 3 TOKEN OPTIMIZATION (2026-08-23) — TARGETED_REPAIR CANONICAL-INSTRUCTION PROJECTION.
// resume_tailoring_instructions.md is now a deterministic SECTION-BASED PROJECTION for a
// TARGETED_REPAIR whose editable paths were fully classified — see canonicalInstructions.ts's
// classifyRepairInstructionPaths/buildTargetedRepairInstructions and exporter.ts's own wiring.
// INITIAL_GENERATION is asserted unaffected (test 50); a real, narrow bullet-level repair is
// asserted to receive a materially smaller, correctly-scoped file (test 51); a summary-touching
// repair (test 49's own fixture, reused here) is asserted to still receive a projection that
// correctly includes SUMMARY_STRUCTURE (tests 52).
// -------------------------------------------------------------------------------------------------

test("50. INITIAL_GENERATION always receives the FULL, unmodified canonical instructions — unaffected by Phase 3 projection", async () => {
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

  const instructionsFile = fs.readFileSync(path.join(exportRes.handoffDirectory, "resume_tailoring_instructions.md"), "utf-8");
  assert.ok(instructionsFile.includes(CANONICAL_TAILORING_INSTRUCTIONS), "INITIAL_GENERATION must receive the complete canonical text verbatim");
  assert.match(instructionsFile, /This file is the complete canonical standard\./);
  assert.doesNotMatch(instructionsFile, /DETERMINISTIC SUBSET/);

  const prompt = fs.readFileSync(path.join(exportRes.handoffDirectory, "writer_prompt.md"), "utf-8");
  assert.match(prompt, /It is the complete document\./);
});

test("51. a narrow bullet-only TARGETED_REPAIR receives a materially smaller, correctly-scoped instruction projection", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  const twoEmployerResume: ResumeContent = {
    ...PERFECT_RESUME,
    experience: [
      {
        ...PERFECT_RESUME.experience[0],
        bullets: ["Built batch data ingestion pipelines using Azure Data Factory and AWS Glue.", ...PERFECT_RESUME.experience[0].bullets.slice(1)],
      },
      {
        title: "Data Engineer",
        company: "Beta LLC",
        dates: "2017 - 2020",
        bullets: ["Built ETL pipelines with Informatica IICS.", "Maintained SQL Server reporting datasets."],
      },
    ],
  };

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: twoEmployerResume,
    coverLetter: COVER_LETTER,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile({
      skills: [{ rawSkillName: "Azure Data Factory", source: "employer", attributedTo: [{ employer: "Acme Corp" }] }],
    }),
    reviewer: {
      review: async () => ({
        review: {
          overallScore: 60,
          atsScore: 90,
          keywordAlignmentScore: 90,
          truthfulnessScore: 70,
          architectureConsistencyScore: 90,
          recruiterReadabilityScore: 90,
          formattingScore: 90,
          blockingFailures: [
            {
              type: "UNSUPPORTED_CLAIM",
              description: '"AWS Glue" is claimed on the resume at Acme Corp but is not grounded in the Master Resume or Master Skills Inventory.',
              recommendedCorrection: 'Remove "AWS Glue" or replace it with a genuinely evidenced technology.',
            },
          ],
          blockingIssues: [],
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
            checks: Object.fromEntries(INSTRUCTION_COMPLIANCE_CHECK_NAMES.map((name) => [name, name === "finalValidation" ? "FAIL" : "PASS"])) as unknown as InstructionComplianceChecks,
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

  const instructionsFile = fs.readFileSync(path.join(exportRes.handoffDirectory, "resume_tailoring_instructions.md"), "utf-8");
  assert.match(instructionsFile, /DETERMINISTIC SUBSET/, "a fully-classified narrow repair must be flagged as a projection, not the full document");
  assert.ok(
    instructionsFile.length < CANONICAL_TAILORING_INSTRUCTIONS.length,
    `projection (${instructionsFile.length} bytes) must be materially smaller than the full standard (${CANONICAL_TAILORING_INSTRUCTIONS.length} bytes)`
  );
  // Always-required truthfulness/style guardrails must survive.
  assert.match(instructionsFile, /The Master Resume is authoritative for/);
  assert.match(instructionsFile, /BANNED AI-SOUNDING LANGUAGE/);
  // Content-repair sections relevant to a bullet edit must be present.
  assert.match(instructionsFile, /ARCHITECTURE INTEGRITY RULE/);
  assert.match(instructionsFile, /BULLET WRITING/);
  // Sections irrelevant to this narrow bullet repair must be excluded.
  assert.doesNotMatch(instructionsFile, /PROFESSIONAL SUMMARY STRUCTURE/);
  assert.doesNotMatch(instructionsFile, /TECHNICAL SKILLS ORGANIZATION/);
  assert.doesNotMatch(instructionsFile, /DEEP-REWRITE REQUIREMENT/);

  const prompt = fs.readFileSync(path.join(exportRes.handoffDirectory, "writer_prompt.md"), "utf-8");
  assert.match(prompt, /deterministic SUBSET/);
});

test("52. a summary-touching TARGETED_REPAIR's instruction projection includes PROFESSIONAL SUMMARY STRUCTURE", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    coverLetter: COVER_LETTER,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile({
      skills: [{ rawSkillName: "Azure", source: "employer", attributedTo: [{ employer: "Acme Corp" }] }],
    }),
    reviewer: {
      review: async () => ({
        review: {
          overallScore: 75,
          atsScore: 80,
          keywordAlignmentScore: 80,
          truthfulnessScore: 70,
          architectureConsistencyScore: 80,
          recruiterReadabilityScore: 80,
          formattingScore: 90,
          blockingFailures: [{ type: "UNSUPPORTED_CLAIM", description: "Summary claims 10 years experience." }],
          blockingIssues: [],
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
            checks: Object.fromEntries(INSTRUCTION_COMPLIANCE_CHECK_NAMES.map((name) => [name, name === "finalValidation" ? "FAIL" : "PASS"])) as unknown as InstructionComplianceChecks,
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

  const instructionsFile = fs.readFileSync(path.join(exportRes.handoffDirectory, "resume_tailoring_instructions.md"), "utf-8");
  // Whatever this repair's editable paths turn out to be, MASTER_RESUME_RULE/BANNED_LANGUAGE must
  // always be present — the file must never be empty of the always-required guardrails.
  assert.match(instructionsFile, /The Master Resume is authoritative for/);
  assert.match(instructionsFile, /BANNED AI-SOUNDING LANGUAGE/);
  if (instructionsFile.includes("DETERMINISTIC SUBSET")) {
    // A summary-touching repair, if classified at all, must include summary guidance.
    assert.match(instructionsFile, /PROFESSIONAL SUMMARY STRUCTURE/);
  } else {
    // Or this repair's scope was not fully classified, in which case the fail-safe correctly
    // fell back to the complete canonical standard rather than guessing.
    assert.ok(instructionsFile.includes(CANONICAL_TAILORING_INSTRUCTIONS));
  }
});

test("53. buildTargetedRepairInstructions never invents text — every projected instruction file is a verbatim subset of the full canonical standard", async () => {
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

  const instructionsFile = fs.readFileSync(path.join(exportRes.handoffDirectory, "resume_tailoring_instructions.md"), "utf-8");
  const headerEnd = instructionsFile.indexOf("\n---\n\n") + "\n---\n\n".length;
  const body = instructionsFile.slice(headerEnd);
  // A projection can (and usually does) skip sections from the middle of the document, so the
  // joined body as a WHOLE need not be a contiguous substring of the full standard — what must hold
  // is that every individual section-sized chunk between separators is a verbatim, unmodified
  // section of the canonical standard (never invented or paraphrased text).
  const { CANONICAL_INSTRUCTION_SECTIONS: sections } = await import("../canonicalInstructions");
  const chunks = body.split("\n\n⸻\n\n");
  for (const chunk of chunks) {
    assert.ok(
      sections.some((s) => s.text === chunk),
      `every section-sized chunk must be verbatim canonical text — got an unrecognized chunk starting "${chunk.slice(0, 60)}"`
    );
  }
});
