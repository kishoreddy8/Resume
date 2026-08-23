import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import JSZip from "jszip";
import { generateCoverLetterDocx } from "../../../../tools/tailoring-engine/cover-letter-template";
import { generateResumeDocx } from "../../../../tools/tailoring-engine/resume-template";
import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";
import { makePng } from "../../../../tools/tailoring-engine/__tests__/pngFixture";
import { writeMasterResumeDocxFixture } from "../../../../tools/tailoring-engine/__tests__/masterResumeFixture";
import type { ResumeReviewerAgent, ResumeReviewerInput, ResumeReviewerOutput } from "../types";
import { getFinalDirectory, getIterationDirectory, type QualityWorkflowLocation } from "../workspace";
import { hashJobIdentity } from "@/lib/tailoringArtifacts";

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
let runDeterministicQualityReview: typeof import("../orchestrator").runDeterministicQualityReview;
let startAndExecuteResumeQualityWorkflow: typeof import("../orchestrator").startAndExecuteResumeQualityWorkflow;
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

const FLAWED_RESUME_BLOCKING: ResumeContent = {
  ...PERFECT_RESUME,
  experience: [
    {
      title: "VP of Engineering",
      company: "NeverExisted Corp", // Truthfulness blocking issue
      dates: "2018 - 2020",
      bullets: ["Led engineering teams."],
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
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-orchestrator-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-orchestrator-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-orchestrator-generated-"));
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
    runDeterministicQualityReview,
    startAndExecuteResumeQualityWorkflow,
    ResumeQualityOrchestrationError,
  } = await import("../orchestrator"));
  getDb();

  candidateAliceId = createCandidate({ firstName: "Alice", lastName: "Smith" }).id;
  candidateBobId = createCandidate({ firstName: "Bob", lastName: "Jones" }).id;
  companyId = createCompany({ name: "OrchestratorTestCo", source_type: "greenhouse", ats_board_token: "orchestratortest" }).id;

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
        url: `https://boards.greenhouse.io/orchestratortest/${externalId}`,
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

  const j1 = seedJob("job-orch-1", "Senior Data Engineer");
  const j2 = seedJob("job-orch-2", "Staff Data Architect");
  jobOne = { id: j1.id, dedupe_key: j1.dedupe_key };
  jobTwo = { id: j2.id, dedupe_key: j2.dedupe_key };

  let hashCounter = 0;
  function nextHash(): string {
    hashCounter += 1;
    return `knowledge-hash-${hashCounter}`;
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
  fs.rmSync(tmpDbDir, { recursive: true, force: true });
  fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  fs.rmSync(tmpGeneratedDir, { recursive: true, force: true });
});

// --- Test Suite: Stage 9 Deterministic Orchestration ---

test("1. Existing workflow can execute deterministic review", async () => {
  const workflow = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const result = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: workflow.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(result.status, "READY");
  assert.equal(result.iterationNumber, 1);
  assert.equal(result.qualityGateOutcome, "READY");
  assert.equal(typeof result.review.overallScore, "number");
});

test("2. Correct candidate isolation (cannot execute review for candidate A with candidate B's workflowId)", async () => {
  const workflowAlice = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  await assert.rejects(
    async () => {
      await executeResumeQualityIteration({
        candidateId: candidateBobId, // Bob attempting to execute Alice's workflow
        workflowId: workflowAlice.id,
        resume: PERFECT_RESUME,
      });
    },
    (err: unknown) => {
      assert(err instanceof ResumeQualityWorkflowNotFoundError);
      return true;
    }
  );
});

test("3. Correct application isolation (application ID must match)", async () => {
  // Try to execute a workflow where application ID belongs to Bob instead of Alice
  const db = (await import("@/db/index")).getDb();
  const ins = db
    .prepare(
      `INSERT INTO resume_quality_workflows (candidate_id, application_id, tailoring_run_id, dedupe_key, status, current_iteration, max_iterations)
       VALUES (?, ?, ?, ?, 'CREATED', 0, 3)`
    )
    .run(candidateAliceId, appBobJobOneId, runAliceJobOneId, jobOne.dedupe_key);
  const wfId = Number(ins.lastInsertRowid);

  await assert.rejects(
    async () => {
      await executeResumeQualityIteration({
        candidateId: candidateAliceId,
        workflowId: wfId,
        resume: PERFECT_RESUME,
      });
    },
    (err: unknown) => {
      assert(err instanceof ResumeQualityOrchestrationError);
      assert.equal(err.code, "APPLICATION_MISMATCH");
      return true;
    }
  );
});

test("4. Correct job isolation (dedupe_key must match between run and workflow)", async () => {
  const db = (await import("@/db/index")).getDb();
  const ins = db
    .prepare(
      `INSERT INTO resume_quality_workflows (candidate_id, application_id, tailoring_run_id, dedupe_key, status, current_iteration, max_iterations)
       VALUES (?, ?, ?, ?, 'CREATED', 0, 3)`
    )
    .run(candidateAliceId, appAliceJobOneId, runAliceJobOneId, "mismatched:job:key");
  const wfId = Number(ins.lastInsertRowid);

  await assert.rejects(
    async () => {
      await executeResumeQualityIteration({
        candidateId: candidateAliceId,
        workflowId: wfId,
        resume: PERFECT_RESUME,
      });
    },
    (err: unknown) => {
      assert(err instanceof ResumeQualityOrchestrationError);
      assert.equal(err.code, "IDENTITY_MISMATCH");
      return true;
    }
  );
});

test("5. Correct tailoring-run isolation (tailoring run must belong to candidate)", async () => {
  // Use Bob's tailoring run with Alice's workflow
  const db = (await import("@/db/index")).getDb();
  const ins = db
    .prepare(
      `INSERT INTO resume_quality_workflows (candidate_id, application_id, tailoring_run_id, dedupe_key, status, current_iteration, max_iterations)
       VALUES (?, ?, ?, ?, 'CREATED', 0, 3)`
    )
    .run(candidateAliceId, appAliceJobOneId, runBobJobOneId, jobOne.dedupe_key);
  const wfId = Number(ins.lastInsertRowid);

  await assert.rejects(
    async () => {
      await executeResumeQualityIteration({
        candidateId: candidateAliceId,
        workflowId: wfId,
        resume: PERFECT_RESUME,
      });
    },
    (err: unknown) => {
      assert(err instanceof ResumeQualityOrchestrationError);
      assert.equal(err.code, "TAILORING_RUN_NOT_FOUND");
      return true;
    }
  );
});

test("6. Correct workflow isolation (separate workflows maintain independent histories)", async () => {
  const wf1 = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });
  const wf2 = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const res1 = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf1.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const iters1 = listResumeQualityIterations(candidateAliceId, wf1.id);
  const iters2 = listResumeQualityIterations(candidateAliceId, wf2.id);

  assert.equal(iters1.length, 1);
  assert.equal(iters2.length, 0);
  assert.equal(res1.workflow.id, wf1.id);
});

test("7. CREATED progresses through expected review lifecycle", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });
  assert.equal(wf.status, "CREATED");

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(res.status, "READY");
  const finalWf = getResumeQualityWorkflow(candidateAliceId, wf.id)!;
  assert.equal(finalWf.status, "READY");
  assert.equal(finalWf.current_iteration, 1);
  assert.equal(finalWf.final_approved_iteration, 1);
});

test("8. Deterministic reviewer is actually invoked", async () => {
  let invoked = false;
  const mockReviewer: ResumeReviewerAgent = {
    async review(input: ResumeReviewerInput): Promise<ResumeReviewerOutput> {
      invoked = true;
      const { DeterministicResumeReviewer } = await import("../reviewers/deterministicReviewer");
      return new DeterministicResumeReviewer().review(input);
    },
  };

  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    reviewer: mockReviewer,
  });

  assert.equal(invoked, true);
});

test("9. Structured review is persisted in database", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const dbIter = getResumeQualityIteration(candidateAliceId, wf.id, 1)!;
  assert(dbIter.review_json);
  const parsed = JSON.parse(dbIter.review_json);
  assert.equal(parsed.overallScore, res.review.overallScore);
  assert.equal(parsed.atsScore, res.review.atsScore);
  assert.equal(dbIter.overall_score, res.review.overallScore);
});

test("10. review.json is written to disk in iteration directory", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const jsonPath = path.join(res.iterationDirectory, "review.json");
  assert(fs.existsSync(jsonPath));
  const content = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  assert.equal(content.overallScore, res.review.overallScore);
});

test("11. review_feedback.md is written to disk in iteration directory", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const mdPath = path.join(res.iterationDirectory, "review_feedback.md");
  assert(fs.existsSync(mdPath));
  const mdContent = fs.readFileSync(mdPath, "utf-8");
  assert(mdContent.includes("# Resume Review Feedback"));
  assert(mdContent.includes("Overall Quality Score"));
});

test("12. Markdown renderer output matches the structured review", async () => {
  const { renderReviewFeedbackMarkdown } = await import("../reviewFeedback");
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const expectedMarkdown = renderReviewFeedbackMarkdown(res.review);
  const mdPath = path.join(res.iterationDirectory, "review_feedback.md");
  const actualMarkdown = fs.readFileSync(mdPath, "utf-8");
  assert.equal(actualMarkdown, expectedMarkdown);
});

test("13. Iteration 1 is immutable", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_BLOCKING,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const iter1Before = getResumeQualityIteration(candidateAliceId, wf.id, 1)!;

  // Attempt to execute second iteration
  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const iter1After = getResumeQualityIteration(candidateAliceId, wf.id, 1)!;
  assert.deepEqual(iter1Before, iter1After);
});

test("14. Iteration 2 does not overwrite iteration 1", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const res1 = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_BLOCKING,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });
  assert.equal(res1.status, "IMPROVEMENT_RUNNING");

  const res2 = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });
  assert.equal(res2.status, "READY");

  const iters = listResumeQualityIterations(candidateAliceId, wf.id);
  assert.equal(iters.length, 2);
  assert.equal(iters[0].iteration_number, 1);
  assert.equal(iters[1].iteration_number, 2);
  assert.notEqual(iters[0].overall_score, iters[1].overall_score);

  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: wf.id,
  };
  assert(fs.existsSync(path.join(getIterationDirectory(loc, 1), "review.json")));
  assert(fs.existsSync(path.join(getIterationDirectory(loc, 2), "review.json")));
});

test("15. Sequential iteration enforcement remains intact", async () => {
  const { createResumeQualityIteration, IterationOutOfSequenceError } = await import("@/db/queries/resumeQualityWorkflows");
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  assert.throws(
    () => {
      createResumeQualityIteration(candidateAliceId, wf.id, 2, {
        outputFiles: ["review.json"],
        overallScore: 90,
        atsScore: 90,
        keywordAlignmentScore: 90,
        truthfulnessScore: 100,
        architectureConsistencyScore: 100,
        recruiterReadabilityScore: 90,
        formattingScore: 90,
        blockingIssueCount: 0,
        reviewJson: "{}",
      });
    },
    (err: unknown) => err instanceof IterationOutOfSequenceError
  );
});

test("16. READY gate transitions workflow to READY", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(res.status, "READY");
  assert.equal(res.workflow.status, "READY");
  assert.equal(res.workflow.final_approved_iteration, 1);
});

test("17. READY creates final artifacts in final/ directory", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  // Real, validator-parseable DOCX files to pass in — validate-docx.ts now runs against every
  // rendered iteration file, so a placeholder byte string would fail the atsFormatting check.
  const fakeResumeDocx = path.join(tmpDbDir, "temp_resume.docx");
  await generateResumeDocx(PERFECT_RESUME, fakeResumeDocx);
  const fakeCoverDocx = path.join(tmpDbDir, "temp_cover.docx");
  await generateCoverLetterDocx(COVER_LETTER, fakeCoverDocx);

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    coverLetter: COVER_LETTER,
    resumeDocxPath: fakeResumeDocx,
    coverLetterDocxPath: fakeCoverDocx,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(res.status, "READY");
  assert(res.finalDirectory);
  assert(fs.existsSync(res.finalDirectory));
  assert(fs.existsSync(path.join(res.finalDirectory, "Alice_Resume.docx")));
  assert(fs.existsSync(path.join(res.finalDirectory, "Alice_CoverLetter.docx")));
  assert(fs.existsSync(path.join(res.finalDirectory, "resume_review_feedback.md")));
});

test("17b. a candidate's real embedded Master Resume certification badge is preserved through the orchestrator's OWN render path (not just tailoringExecution.ts)", { skip: "certification badges disabled per user request — see resume-template.ts BADGES_ENABLED" }, async () => {
  // Found live during the Srikanth (candidate 13) certification run: orchestrator.ts's own
  // generateTailoringOutputs call — the ONLY place a resume-quality workflow's Resume.docx is ever
  // actually rendered — never passed masterResumeDocxPath at all, so every INITIAL_GENERATION/
  // TARGETED_REPAIR iteration silently fell back to the generic text-card badges regardless of what
  // the candidate's own Master Resume had embedded. tailoringExecution.ts's own wiring (already
  // tested in src/lib/__tests__/tailoringExecution.test.ts) is a separate, rarely-used path — only
  // the external Codex/Claude-Code CLI bridge (execute-run.ts) ever calls it.
  const masterResumePath = path.join(tmpCandidatesDir, String(candidateAliceId), "master", "resume.docx");
  const badge = makePng(100, 50, [20, 90, 150]);
  await writeMasterResumeDocxFixture(masterResumePath, [{ bytes: badge, width: 40, height: 20 }]);

  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    maxIterations: 3,
  });

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  // Source-image badges never depend on ResumeContent.certifications at all — they come purely from
  // the Master Resume's own embedded images (see sourceBadgeAssets.ts), so PERFECT_RESUME is used
  // completely unmodified here specifically to prove that: no certification text is required for the
  // candidate's real embedded badge to appear.
  assert.equal(res.status, "READY");
  const resumeDocxPath = path.join(res.finalDirectory!, "Alice_Resume.docx");
  assert(fs.existsSync(resumeDocxPath));

  const zip = await JSZip.loadAsync(fs.readFileSync(resumeDocxPath));
  const mediaFiles = Object.keys(zip.files).filter((f) => /^word\/media\//.test(f) && !f.endsWith("/"));
  assert.equal(mediaFiles.length, 1, "the candidate's real embedded badge must be preserved via the orchestrator's own render call");
  const embedded = await zip.file(mediaFiles[0])!.async("nodebuffer");
  assert.ok(embedded.equals(badge), "the embedded image must be byte-identical to the candidate's own Master Resume asset");
});

test("18. Final candidate filenames are safe", async () => {
  const { finalResumeFilename, finalCoverLetterFilename } = await import("../workspace");
  assert.equal(finalResumeFilename("Alice"), "Alice_Resume.docx");
  assert.equal(finalResumeFilename("Mary-Jane / 123!"), "MaryJane123_Resume.docx");
  assert.equal(finalResumeFilename("   "), "Candidate_Resume.docx");
  assert.equal(finalCoverLetterFilename("Bob"), "Bob_CoverLetter.docx");
});

test("19. Candidate name is not hardcoded (derived from candidate's first_name)", async () => {
  const wfBob = createResumeQualityWorkflow({
    candidateId: candidateBobId,
    applicationId: appBobJobOneId,
    tailoringRunId: runBobJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const fakeResumeDocx = path.join(tmpDbDir, "bob_temp_resume.docx");
  await generateResumeDocx({ ...PERFECT_RESUME, name: "Bob Jones" }, fakeResumeDocx);

  const res = await executeResumeQualityIteration({
    candidateId: candidateBobId,
    workflowId: wfBob.id,
    resume: { ...PERFECT_RESUME, name: "Bob Jones" },
    resumeDocxPath: fakeResumeDocx,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(res.status, "READY");
  assert(res.finalDirectory);
  assert(fs.existsSync(path.join(res.finalDirectory, "Bob_Resume.docx")));
  assert(!fs.existsSync(path.join(res.finalDirectory, "Alice_Resume.docx")));
  assert(!fs.existsSync(path.join(res.finalDirectory, "Saikishore_Resume.docx")));
});

test("20. Failed quality gate does not create final approved artifacts", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_BLOCKING,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(res.status, "IMPROVEMENT_RUNNING");
  assert.equal(res.finalDirectory, undefined);
  assert.equal(res.finalArtifacts, undefined);

  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: wf.id,
  };
  assert(!fs.existsSync(getFinalDirectory(loc)));
});

test("21. Failed quality gate transitions to improvement state (IMPROVEMENT_RUNNING)", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_BLOCKING,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(res.status, "IMPROVEMENT_RUNNING");
  const updated = getResumeQualityWorkflow(candidateAliceId, wf.id)!;
  assert.equal(updated.status, "IMPROVEMENT_RUNNING");
});

test("22. Second failed iteration remains isolated", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const res1 = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_BLOCKING,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });
  assert.equal(res1.iterationNumber, 1);

  const res2 = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_BLOCKING,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });
  assert.equal(res2.iterationNumber, 2);
  assert.equal(res2.status, "IMPROVEMENT_RUNNING");

  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: wf.id,
  };
  assert(fs.existsSync(path.join(getIterationDirectory(loc, 1), "review.json")));
  assert(fs.existsSync(path.join(getIterationDirectory(loc, 2), "review.json")));
});

test("23. Third failed iteration produces the human-review outcome (FAILED with reason)", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    maxIterations: 3,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_BLOCKING,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });
  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_BLOCKING,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });
  const res3 = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_BLOCKING,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(res3.iterationNumber, 3);
  assert.equal(res3.status, "FAILED");
  assert.equal(res3.qualityGateOutcome, "NEEDS_HUMAN_REVIEW");
  assert(res3.failureReason?.includes("human review required"));

  const updatedWf = getResumeQualityWorkflow(candidateAliceId, wf.id)!;
  assert.equal(updatedWf.status, "FAILED");
  assert(updatedWf.failure_reason?.includes("human review required"));
});

test("24. Iteration 4 is rejected when max_iterations is 3", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
    maxIterations: 3,
  });

  await executeResumeQualityIteration({ candidateId: candidateAliceId, workflowId: wf.id, resume: FLAWED_RESUME_BLOCKING });
  await executeResumeQualityIteration({ candidateId: candidateAliceId, workflowId: wf.id, resume: FLAWED_RESUME_BLOCKING });
  await executeResumeQualityIteration({ candidateId: candidateAliceId, workflowId: wf.id, resume: FLAWED_RESUME_BLOCKING });

  // Now in FAILED state (terminal)
  await assert.rejects(
    async () => {
      await executeResumeQualityIteration({
        candidateId: candidateAliceId,
        workflowId: wf.id,
        resume: PERFECT_RESUME,
      });
    },
    (err: unknown) => {
      assert(err instanceof ResumeQualityOrchestrationError);
      assert.equal(err.code, "WORKFLOW_ALREADY_TERMINAL");
      return true;
    }
  );
});

test("25. Truthfulness <100 cannot become READY", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const resumeTitleMismatch: ResumeContent = {
    ...PERFECT_RESUME,
    experience: [
      {
        title: "VP of Product Strategy", // Unsubstantiated title promotion
        company: "Acme Corp",
        dates: "2020 - Present",
        bullets: [
          "Designed Azure Data Factory pipelines that reduced nightly batch processing time from 6 hours to 45 minutes.",
        ],
      },
    ],
  };

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: resumeTitleMismatch,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.notEqual(res.status, "READY");
  assert(res.review.truthfulnessScore < 100);
});

test("26. Architecture consistency <100 cannot become READY", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const resumeContradiction: ResumeContent = {
    ...PERFECT_RESUME,
    experience: [
      {
        title: "Senior Data Engineer",
        company: "Acme Corp",
        dates: "2020 - Present",
        bullets: ["Built batch pipelines using Azure Data Factory and AWS Glue for daily reporting."], // competing tools
      },
    ],
  };

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: resumeContradiction,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.notEqual(res.status, "READY");
  assert(res.review.architectureConsistencyScore < 100);
});

test("27. Blocking issue cannot become READY", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_BLOCKING,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.notEqual(res.status, "READY");
  assert(res.review.blockingIssues.length > 0);
  assert(res.review.overallScore <= 40); // Cap on blocking issue
});

test("28. overallScore <95 cannot become READY", async () => {
  const mockReviewer: ResumeReviewerAgent = {
    async review(): Promise<ResumeReviewerOutput> {
      return {
        review: {
          overallScore: 94, // below 95
          atsScore: 95,
          keywordAlignmentScore: 95,
          truthfulnessScore: 100,
          architectureConsistencyScore: 100,
          recruiterReadabilityScore: 90,
          formattingScore: 90,
          missingRequiredSkills: [],
          incorrectTechnologyUsage: [],
          genericBullets: [],
          missingImpactEvidence: [],
          summaryIssues: [],
          skillsOrderingIssues: [],
          truthfulnessIssues: [],
          blockingIssues: [],
          requiredCorrections: [],
        },
      };
    },
  };

  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    reviewer: mockReviewer,
  });

  assert.equal(res.status, "IMPROVEMENT_RUNNING");
  assert.equal(res.qualityGateOutcome, "IMPROVEMENT_NEEDED");
});

test("29. Duplicate execution cannot overwrite an existing iteration", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  // Attempt to execute on the same workflow now that it's READY
  await assert.rejects(
    async () => {
      await executeResumeQualityIteration({
        candidateId: candidateAliceId,
        workflowId: wf.id,
        resume: PERFECT_RESUME,
      });
    },
    (err: unknown) => {
      assert(err instanceof ResumeQualityOrchestrationError);
      assert.equal(err.code, "WORKFLOW_ALREADY_TERMINAL");
      return true;
    }
  );
});

test("30. Reviewer failure never marks workflow READY (marks FAILED)", async () => {
  const failingReviewer: ResumeReviewerAgent = {
    async review(): Promise<ResumeReviewerOutput> {
      throw new Error("Reviewer engine crashed unexpectedly");
    },
  };

  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  await assert.rejects(
    async () => {
      await executeResumeQualityIteration({
        candidateId: candidateAliceId,
        workflowId: wf.id,
        resume: PERFECT_RESUME,
        reviewer: failingReviewer,
      });
    },
    (err: unknown) => {
      assert.equal((err as Error).message, "Reviewer engine crashed unexpectedly");
      return true;
    }
  );

  const failedWf = getResumeQualityWorkflow(candidateAliceId, wf.id)!;
  assert.equal(failedWf.status, "FAILED");
  assert.equal(failedWf.failure_reason, "Reviewer engine crashed unexpectedly");
});

test("31. Artifact-write failure never marks workflow READY", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  // Pass an invalid/unreadable path to simulate error during artifact copying
  await assert.rejects(
    async () => {
      await executeResumeQualityIteration({
        candidateId: candidateAliceId,
        workflowId: wf.id,
        resume: PERFECT_RESUME,
        resumeDocxPath: "/nonexistent/invalid/path/resume.docx",
        jobRequirements: STRONG_REQUIREMENTS,
        masterResumeProfile: masterProfile(),
      });
    }
  );

  const failedWf = getResumeQualityWorkflow(candidateAliceId, wf.id)!;
  assert.notEqual(failedWf.status, "READY");
});

test("32. Previous successful iteration artifacts survive later failure", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  // Iteration 1 succeeds in improvement needed
  await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: FLAWED_RESUME_BLOCKING,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const loc: QualityWorkflowLocation = {
    candidateId: candidateAliceId,
    dedupeKey: jobOne.dedupe_key,
    runId: runAliceJobOneId,
    workflowId: wf.id,
  };
  const iter1Json = path.join(getIterationDirectory(loc, 1), "review.json");
  assert(fs.existsSync(iter1Json));

  // Iteration 2 crashes during review
  const failingReviewer: ResumeReviewerAgent = {
    async review(): Promise<ResumeReviewerOutput> {
      throw new Error("Simulated crash in iteration 2");
    },
  };

  await assert.rejects(async () => {
    await executeResumeQualityIteration({
      candidateId: candidateAliceId,
      workflowId: wf.id,
      resume: PERFECT_RESUME,
      reviewer: failingReviewer,
    });
  });

  // Iteration 1 artifact still survives completely intact
  assert(fs.existsSync(iter1Json));
  const iter1Db = getResumeQualityIteration(candidateAliceId, wf.id, 1);
  assert(iter1Db);
});

test("33. No absolute filesystem paths are persisted where relative metadata is expected", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });
  assert.equal(res.status, "READY");

  const dbIter = getResumeQualityIteration(candidateAliceId, wf.id, 1)!;
  const outputFiles = JSON.parse(dbIter.output_files!);
  for (const file of outputFiles) {
    assert(!file.startsWith("/"), `Output file "${file}" must be a relative filename, not absolute path`);
    assert(!file.includes("\\"), `Output file "${file}" must not contain backslashes`);
  }
});

test("34. Raw dedupe_key never appears in artifact path", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert(!res.iterationDirectory.includes(jobOne.dedupe_key));
  const expectedHash = hashJobIdentity(jobOne.dedupe_key);
  assert(res.iterationDirectory.includes(expectedHash));
});

test("35. No production DB mutation occurs in tests (uses isolated tmp DB)", () => {
  assert(process.env.CAREER_OPS_DB_PATH?.includes("career-ops-orchestrator-db-"));
  assert(!process.env.CAREER_OPS_DB_PATH?.includes("data/app.db"));
});

test("36. No network access is required", async () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobOneId,
    tailoringRunId: runAliceJobOneId,
    dedupeKey: jobOne.dedupe_key,
      // Stage 28 lowered the production default to 2 content attempts. These cases exercise the
    // iteration machinery, which must behave correctly at any budget, so the budget is pinned
    // explicitly here; the shipped default is asserted separately (stage28FastPipeline S28-01).
    maxIterations: 3,
  });

  // Entire run executes in-process synchronously with zero network
  const res = await executeResumeQualityIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(res.status, "READY");
});

test("37. startAndExecuteResumeQualityWorkflow convenience helper creates and executes workflow", async () => {
  const res = await startAndExecuteResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceJobTwoId,
    tailoringRunId: runAliceJobTwoId,
    dedupeKey: jobTwo.dedupe_key,
    resume: PERFECT_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(res.status, "READY");
  assert.equal(res.iterationNumber, 1);
  const wf = getResumeQualityWorkflow(candidateAliceId, res.workflow.id)!;
  assert.equal(wf.status, "READY");
});

test("38. runDeterministicQualityReview alias points to executeResumeQualityIteration", () => {
  assert.equal(runDeterministicQualityReview, executeResumeQualityIteration);
});
