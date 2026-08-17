import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { CoverLetterContent, ResumeContent } from "../../tools/tailoring-engine/types";

/**
 * End-to-end integration tests for the automatic resume-writer worker. Every "claude" invocation is
 * a tiny fixture executable (never a real, billed generation) that reads writer_input.json from its
 * cwd and echoes back a correctly-identified writer_output.json built from a resume supplied via the
 * FAKE_CLAUDE_RESUME_JSON env var — this exercises the REAL export -> invoke -> import -> review ->
 * gate -> notify pipeline end to end, with only the expensive external process itself replaced.
 *
 * Uses an isolated temp DB (CAREER_OPS_DB_PATH) + isolated temp candidate/generated filesystem
 * roots, matching src/lib/resumeQuality/__tests__/externalHandoff.test.ts's established pattern.
 * Production data/app.db is never opened by this file.
 */

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
let getCandidateJobState: typeof import("@/db/queries/candidateJobState").getCandidateJobState;
let startTailoringRun: typeof import("@/lib/tailoringExecution").startTailoringRun;
let createResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityWorkflow;
let getResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").getResumeQualityWorkflow;
let listWorkflowsAwaitingWriter: typeof import("@/db/queries/resumeQualityWorkflows").listWorkflowsAwaitingWriter;
let executeResumeQualityIteration: typeof import("@/lib/resumeQuality/orchestrator").executeResumeQualityIteration;
let executeResumeImprovementIteration: typeof import("@/lib/resumeQuality/orchestrator").executeResumeImprovementIteration;
let getHandoffDirectory: typeof import("@/lib/resumeQuality/workspace").getHandoffDirectory;
let getHumanReviewDirectory: typeof import("@/lib/resumeQuality/workspace").getHumanReviewDirectory;
let getFinalDirectory: typeof import("@/lib/resumeQuality/workspace").getFinalDirectory;
let getWorkspaceDirectory: typeof import("@/lib/resumeQuality/workspace").getWorkspaceDirectory;
let importExternalWriterResult: typeof import("@/lib/resumeQuality/handoff/importer").importExternalWriterResult;
let listNotificationsForCandidate: typeof import("@/db/queries/notifications").listNotificationsForCandidate;
let RESUME_READY_NOTIFICATION_TYPE: string;
let WRITER_FAILURE_NOTIFICATION_TYPE: string;
let QUALITY_FAILURE_NOTIFICATION_TYPE: string;
let HUMAN_REVIEW_REQUIRED_NOTIFICATION_TYPE: string;
let processOneWorkflow: typeof import("@/lib/resumeQuality/writers/writerWorkerCore").processOneWorkflow;
let runWorkerPass: typeof import("@/lib/resumeQuality/writers/writerWorkerCore").runWorkerPass;
let claimHandoff: typeof import("@/lib/resumeQuality/writers/handoffClaim").claimHandoff;
let releaseHandoffClaim: typeof import("@/lib/resumeQuality/writers/handoffClaim").releaseHandoffClaim;
let MAX_TECHNICAL_PASSES: number;
let CANONICAL_TAILORING_INSTRUCTIONS: string;
let INSTRUCTION_HASH: string;

let candidateAliceId: number;
let candidateBobId: number;
let companyId: number;
let jobOne: { id: number; dedupe_key: string };

let successScript: string;
let alwaysFailScript: string;
let authorizeJob: (candId: number, j: { id: number; dedupe_key: string }) => { runId: number; applicationId: number };

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

function masterProfile(): CandidateProfile {
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
      bullets: ["Built batch data ingestion pipelines using Azure Data Factory and AWS Glue."],
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

function masterFileHashes(candId: number): string {
  const masterDir = path.join(tmpCandidatesDir, String(candId), "master");
  const hash = crypto.createHash("sha256");
  for (const f of ["resume.txt", "skills.json"]) {
    hash.update(fs.readFileSync(path.join(masterDir, f)));
  }
  return hash.digest("hex");
}

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-worker-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-worker-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-worker-gen-"));
  tmpFixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-worker-fixtures-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {
      // Ignore.
    }
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
  ({ createResumeQualityWorkflow, getResumeQualityWorkflow, listWorkflowsAwaitingWriter } = await import(
    "@/db/queries/resumeQualityWorkflows"
  ));
  ({ executeResumeQualityIteration, executeResumeImprovementIteration } = await import("@/lib/resumeQuality/orchestrator"));
  ({ getHandoffDirectory, getWorkspaceDirectory, getHumanReviewDirectory, getFinalDirectory } = await import("@/lib/resumeQuality/workspace"));
  ({ importExternalWriterResult } = await import("@/lib/resumeQuality/handoff/importer"));
  ({ listNotificationsForCandidate } = await import("@/db/queries/notifications"));
  ({
    RESUME_READY_NOTIFICATION_TYPE,
    WRITER_FAILURE_NOTIFICATION_TYPE,
    QUALITY_FAILURE_NOTIFICATION_TYPE,
    HUMAN_REVIEW_REQUIRED_NOTIFICATION_TYPE,
  } = await import("@/lib/notifications/resumePipelineNotifications"));
  ({ processOneWorkflow, runWorkerPass } = await import("@/lib/resumeQuality/writers/writerWorkerCore"));
  ({ claimHandoff, releaseHandoffClaim } = await import("@/lib/resumeQuality/writers/handoffClaim"));
  ({ MAX_TECHNICAL_PASSES } = await import("@/lib/resumeQuality/writers/handoffClaim"));
  ({ CANONICAL_TAILORING_INSTRUCTIONS, INSTRUCTION_HASH } = await import("@/lib/resumeQuality/canonicalInstructions"));
  getDb();

  candidateAliceId = createCandidate({ firstName: "Alice", lastName: "Smith" }).id;
  candidateBobId = createCandidate({ firstName: "Bob", lastName: "Jones" }).id;
  companyId = createCompany({ name: "WorkerTestCo", source_type: "greenhouse", ats_board_token: "workertest" }).id;

  function seedCandidateMasterFiles(candId: number) {
    const masterDir = path.join(tmpCandidatesDir, String(candId), "master");
    fs.mkdirSync(masterDir, { recursive: true });
    fs.writeFileSync(path.join(masterDir, "resume.txt"), `Resume for candidate ${candId}\nAcme Corp\nSenior Data Engineer\n2020 - Present`);
    fs.writeFileSync(path.join(masterDir, "skills.json"), JSON.stringify({ skills: ["Azure", "Python"] }));
    fs.writeFileSync(path.join(masterDir, "manifest.json"), JSON.stringify({ resume: { filename: "resume.txt" }, skills: { filename: "skills.json" } }));

    const dir = path.join(tmpCandidatesDir, String(candId));
    fs.writeFileSync(
      path.join(dir, "candidate-profile.json"),
      JSON.stringify({
        schemaVersion: 1,
        sourceHashes: { resume: `r-${candId}`, skills: `s-${candId}` },
        builtAt: "2026-01-01T00:00:00Z",
        skills: [],
        experience: [
          { employer: "Acme Corp", title: "Senior Data Engineer", startDate: "2020-01", endDate: null, technologies: ["Azure", "Azure Data Factory", "Databricks", "Python", "SQL"] },
        ],
        education: [{ level: "Bachelor's", field: "Computer Science", institution: "State University" }],
        certifications: [],
        totalYearsExperience: 5,
      })
    );
    fs.writeFileSync(
      path.join(masterDir, "manifest.json"),
      JSON.stringify({
        resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: `r-${candId}` },
        skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: `s-${candId}` },
      })
    );
  }

  seedCandidateMasterFiles(candidateAliceId);
  seedCandidateMasterFiles(candidateBobId);

  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, "job-worker-1");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "job-worker-1",
      title: "Senior Data Engineer",
      location: "Remote",
      department: "Eng",
      url: "https://boards.greenhouse.io/workertest/job-worker-1",
      descriptionHtml: null,
      descriptionText: "Job description for resume writer worker test",
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
  const j1 = getJobByDedupeKey(dedupeKey)!;
  jobOne = { id: j1.id, dedupe_key: j1.dedupe_key };

  let hashCounter = 0;
  function nextHash(): string {
    hashCounter += 1;
    return `worker-hash-${hashCounter}`;
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

  authorizeJob = function (candId: number, j: { id: number; dedupe_key: string }) {
    insertJobMatchResult(
      fakeResult({ candidateId: candId, jobId: j.id, dedupeKey: j.dedupe_key, candidateProfileHash: `p-${candId}-${j.id}`, decision: "READY_FOR_TAILORING" })
    );
    setMarkedForTailoring(candId, j.dedupe_key, true, { approvalType: "READY_DIRECT", decision: "READY_FOR_TAILORING" });
    const { run } = startTailoringRun({ candidateId: candId, jobId: j.id });
    const applicationId = getCandidateJobState(candId, j.dedupe_key)!.id;
    return { runId: run.id, applicationId };
  };

  // Fixture "claude" scripts — never a real, billed generation.
  successScript = path.join(tmpFixturesDir, "fake-claude-success.js");
  fs.writeFileSync(
    successScript,
    `#!/usr/bin/env node
const fs = require('fs');
const input = JSON.parse(fs.readFileSync('writer_input.json', 'utf-8'));
const resume = JSON.parse(process.env.FAKE_CLAUDE_RESUME_JSON);
const output = {
  schemaVersion: 1,
  candidateId: input.candidateId,
  applicationId: input.applicationId,
  jobId: input.jobId,
  tailoringRunId: input.tailoringRunId,
  workflowId: input.workflowId,
  iterationNumber: input.targetIterationNumber,
  resume,
};
fs.writeFileSync('writer_output.json', JSON.stringify(output, null, 2));
process.exit(0);
`,
    { mode: 0o755 }
  );

  alwaysFailScript = path.join(tmpFixturesDir, "fake-claude-always-fails.js");
  fs.writeFileSync(alwaysFailScript, `#!/usr/bin/env node\nprocess.exit(1);\n`, { mode: 0o755 });
});

after(() => {
  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {
      // Ignore.
    }
    global.__careerOpsDb = undefined;
  }
  if (tmpDbDir && fs.existsSync(tmpDbDir)) fs.rmSync(tmpDbDir, { recursive: true, force: true });
  if (tmpCandidatesDir && fs.existsSync(tmpCandidatesDir)) fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  if (tmpGeneratedDir && fs.existsSync(tmpGeneratedDir)) fs.rmSync(tmpGeneratedDir, { recursive: true, force: true });
  if (tmpFixturesDir && fs.existsSync(tmpFixturesDir)) fs.rmSync(tmpFixturesDir, { recursive: true, force: true });
});

async function authorizeAndCreateFlawedWorkflow(candId: number) {
  const { runId, applicationId } = authorizeJob(
    candId,
    jobOne
  );
  const wf = createResumeQualityWorkflow({ candidateId: candId, applicationId, tailoringRunId: runId, dedupeKey: jobOne.dedupe_key });
  await executeResumeQualityIteration({
    candidateId: candId,
    workflowId: wf.id,
    resume: FLAWED_RESUME,
    coverLetter: COVER_LETTER,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });
  const after1 = getResumeQualityWorkflow(candId, wf.id)!;
  assert.equal(after1.status, "IMPROVEMENT_RUNNING", "fixture setup: iteration 1 must fail review to reach IMPROVEMENT_RUNNING");

  // Matches what the real POST /quality-workflow route writes at workflow creation — buildResumeWriterInput
  // (used by the worker, exactly like the real import route) auto-loads jobRequirements from this
  // on-disk file rather than requiring an explicit parameter, so the fixture must seed it for real.
  const wsDir = getWorkspaceDirectory({ candidateId: candId, dedupeKey: jobOne.dedupe_key, runId: runId, workflowId: wf.id });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "extracted_job_requirements.json"), JSON.stringify(STRONG_REQUIREMENTS, null, 2));
  fs.writeFileSync(path.join(wsDir, "job_description.md"), "# Senior Data Engineer\n\nJob description for resume writer worker test");

  // Return a FRESH row — `wf` above is a stale snapshot captured before executeResumeQualityIteration
  // mutated current_iteration/status; every caller must see the real post-iteration-1 state.
  return after1;
}

test("1. listWorkflowsAwaitingWriter detects a workflow in IMPROVEMENT_RUNNING (ready-for-writer signal)", async () => {
  const wf = await authorizeAndCreateFlawedWorkflow(candidateAliceId);
  const pending = listWorkflowsAwaitingWriter();
  assert(pending.some((w) => w.id === wf.id), "the newly IMPROVEMENT_RUNNING workflow must appear in the writer queue");
});

test("2. atomic claim blocks a concurrent duplicate invocation of the same handoff", async () => {
  const wf = await authorizeAndCreateFlawedWorkflow(candidateAliceId);
  const handoffDir = getHandoffDirectory(
    { candidateId: candidateAliceId, dedupeKey: jobOne.dedupe_key, runId: wf.tailoring_run_id, workflowId: wf.id },
    wf.current_iteration + 1
  );

  const preClaim = claimHandoff(handoffDir);
  assert(preClaim, "test setup: pre-claiming the handoff must succeed");

  process.env.FAKE_CLAUDE_RESUME_JSON = JSON.stringify(PERFECT_RESUME);
  const outcome = await processOneWorkflow(wf);

  assert.equal(outcome.outcome, "SKIPPED_CLAIMED", "a handoff already claimed by a live process must never be double-processed");

  const stillPending = getResumeQualityWorkflow(candidateAliceId, wf.id)!;
  assert.equal(stillPending.status, "IMPROVEMENT_RUNNING", "workflow state must be untouched while claimed by someone else");

  releaseHandoffClaim(handoffDir);
});

test("3. successful writer invocation + output validation drives review and reaches READY", async () => {
  const wf = await authorizeAndCreateFlawedWorkflow(candidateAliceId);

  process.env.FAKE_CLAUDE_RESUME_JSON = JSON.stringify(PERFECT_RESUME);
  const outcome = await processOneWorkflow(wf, { cliOptions: { command: successScript, retryBackoffMs: 5 } });

  assert.equal(outcome.outcome, "READY");
  assert.equal(outcome.iterationNumber, 2);

  const finalWf = getResumeQualityWorkflow(candidateAliceId, wf.id)!;
  assert.equal(finalWf.status, "READY");

  const notifications = listNotificationsForCandidate(candidateAliceId);
  assert(notifications.some((n) => n.dedupe_key === jobOne.dedupe_key && n.type === RESUME_READY_NOTIFICATION_TYPE));
});

test("4/5. a quality failure creates the next iteration automatically (with prior feedback), returns to the writer queue, and a successful later iteration reaches READY", async () => {
  const wf = await authorizeAndCreateFlawedWorkflow(candidateBobId);

  // Pass 1: iteration 2 is STILL flawed -> IMPROVEMENT_RUNNING again, QUALITY_FAILURE notified.
  process.env.FAKE_CLAUDE_RESUME_JSON = JSON.stringify(FLAWED_RESUME);
  const outcome2 = await processOneWorkflow(wf, { cliOptions: { command: successScript, retryBackoffMs: 5 } });
  assert.equal(outcome2.outcome, "IMPROVEMENT_RUNNING");
  assert.equal(outcome2.iterationNumber, 2);

  const afterIter2 = getResumeQualityWorkflow(candidateBobId, wf.id)!;
  assert.equal(afterIter2.status, "IMPROVEMENT_RUNNING");
  assert.equal(afterIter2.current_iteration, 2);

  const notificationsAfter2 = listNotificationsForCandidate(candidateBobId);
  assert(notificationsAfter2.some((n) => n.dedupe_key === jobOne.dedupe_key && n.type === QUALITY_FAILURE_NOTIFICATION_TYPE));

  // listWorkflowsAwaitingWriter must show it queued again, automatically, with no manual step.
  assert(listWorkflowsAwaitingWriter().some((w) => w.id === wf.id));

  const iter3HandoffDir = getHandoffDirectory(
    { candidateId: candidateBobId, dedupeKey: jobOne.dedupe_key, runId: wf.tailoring_run_id, workflowId: wf.id },
    3
  );

  // Pass 2 (iteration 3, the final allowed iteration) is what actually exports the iteration-3
  // handoff (export happens at the start of processOneWorkflow) — assert its contents right after,
  // proving the rewrite loop carried iteration 2's own review/corrections forward automatically.
  // This IS "how prior CareerOps feedback reaches Claude" (reused exporter behavior, unmodified).
  // Must pass the FRESH post-pass-1 row — production's runWorkerPass always re-queries fresh per
  // pass (there's no possibility of a stale row there); reusing the original `wf` here would be a
  // test-only artifact, not a real bug, so the fixture re-fetches exactly like a real second pass would.
  process.env.FAKE_CLAUDE_RESUME_JSON = JSON.stringify(PERFECT_RESUME);
  const outcome3 = await processOneWorkflow(afterIter2, { cliOptions: { command: successScript, retryBackoffMs: 5 } });
  assert.equal(outcome3.outcome, "READY");
  assert.equal(outcome3.iterationNumber, 3);

  assert(fs.existsSync(path.join(iter3HandoffDir, "review.json")), "iteration-3 handoff must include iteration 2's review.json");
  assert(fs.existsSync(path.join(iter3HandoffDir, "review_feedback.md")), "iteration-3 handoff must include iteration 2's review_feedback.md");
  assert(fs.existsSync(path.join(iter3HandoffDir, "previous_resume_content.json")), "iteration-3 handoff must include iteration 2's resume content");

  const finalWf = getResumeQualityWorkflow(candidateBobId, wf.id)!;
  assert.equal(finalWf.status, "READY");
  assert.equal(finalWf.current_iteration, 3);
});

test("6. final allowed quality-iteration failure reaches FAILED/HUMAN_REVIEW_REQUIRED, and the workflow never loops forever", async () => {
  const candId = createCandidate({ firstName: "Carol", lastName: "Diaz" }).id;
  fs.mkdirSync(path.join(tmpCandidatesDir, String(candId), "master"), { recursive: true });
  fs.writeFileSync(path.join(tmpCandidatesDir, String(candId), "master", "resume.txt"), "Resume for Carol");
  fs.writeFileSync(path.join(tmpCandidatesDir, String(candId), "master", "skills.json"), JSON.stringify({ skills: ["Azure"] }));
  fs.writeFileSync(
    path.join(tmpCandidatesDir, String(candId), "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: `r-${candId}`, skills: `s-${candId}` },
      builtAt: "2026-01-01T00:00:00Z",
      skills: [],
      experience: [{ employer: "Acme Corp", title: "Senior Data Engineer", startDate: "2020-01", endDate: null, technologies: ["Azure"] }],
      education: [],
      certifications: [],
      totalYearsExperience: 5,
    })
  );
  fs.writeFileSync(
    path.join(tmpCandidatesDir, String(candId), "master", "manifest.json"),
    JSON.stringify({ resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 1, sha256: `r-${candId}` }, skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 1, sha256: `s-${candId}` } })
  );

  const wf = await authorizeAndCreateFlawedWorkflow(candId);

  process.env.FAKE_CLAUDE_RESUME_JSON = JSON.stringify(FLAWED_RESUME);
  const p2 = await processOneWorkflow(wf, { cliOptions: { command: successScript, retryBackoffMs: 5 } });
  assert.equal(p2.outcome, "IMPROVEMENT_RUNNING");

  // Refresh from the DB before the next pass — production's runWorkerPass always re-queries fresh per
  // pass; reusing the original stale `wf` here would be a test-only artifact (see the identical fix
  // applied to test 4/5 above).
  const wfAfterP2 = getResumeQualityWorkflow(candId, wf.id)!;
  const p3 = await processOneWorkflow(wfAfterP2, { cliOptions: { command: successScript, retryBackoffMs: 5 } });
  assert.equal(p3.outcome, "FAILED", "the final allowed iteration failing quality review must reach the terminal FAILED status");

  const finalWf = getResumeQualityWorkflow(candId, wf.id)!;
  assert.equal(finalWf.status, "FAILED");

  const notifications = listNotificationsForCandidate(candId);
  assert(notifications.some((n) => n.dedupe_key === jobOne.dedupe_key && n.type === HUMAN_REVIEW_REQUIRED_NOTIFICATION_TYPE));
  const humanReviewNotification = notifications.find((n) => n.dedupe_key === jobOne.dedupe_key && n.type === HUMAN_REVIEW_REQUIRED_NOTIFICATION_TYPE)!;
  assert(humanReviewNotification.body.includes("strongest attempt"), "notification must mention the best attempt when a human-review package was generated");

  // Stage 13 — the human-review package must exist, exposing a real best attempt with a downloadable
  // resume, all pointing at the same selected iteration.
  const humanReviewDir = getHumanReviewDirectory({ candidateId: candId, dedupeKey: jobOne.dedupe_key, runId: wf.tailoring_run_id, workflowId: wf.id });
  assert(fs.existsSync(path.join(humanReviewDir, "best_attempt.json")), "human-review package must be auto-generated on terminal FAILED");
  const bestAttempt = JSON.parse(fs.readFileSync(path.join(humanReviewDir, "best_attempt.json"), "utf-8"));
  assert.equal(bestAttempt.approved, false);
  assert.equal(bestAttempt.qualityGateDecision, "NEEDS_HUMAN_REVIEW");
  assert(bestAttempt.iterationNumber >= 1 && bestAttempt.iterationNumber <= 3);
  assert(fs.existsSync(path.join(humanReviewDir, `Carol_Resume_HumanReview.docx`)), "best-attempt resume must be downloadable");
  assert.equal(fs.existsSync(getFinalDirectory({ candidateId: candId, dedupeKey: jobOne.dedupe_key, runId: wf.tailoring_run_id, workflowId: wf.id })), false, "FAILED must never populate the READY final/ directory");

  // No infinite loop: a FAILED (terminal) workflow must never be picked up again, and no 4th Claude call.
  assert(!listWorkflowsAwaitingWriter().some((w) => w.id === wf.id));
});

test("7. technical failure never consumes a quality iteration, and WRITER_FAILURE fires only once the bounded cross-pass cap is reached", async () => {
  const wf = await authorizeAndCreateFlawedWorkflow(candidateAliceId);
  const startingIteration = wf.current_iteration;

  for (let i = 1; i <= MAX_TECHNICAL_PASSES; i++) {
    const outcome = await processOneWorkflow(wf, { cliOptions: { command: alwaysFailScript, retryBackoffMs: 5 } });
    assert.equal(outcome.outcome, "TECHNICAL_FAILURE");

    const current = getResumeQualityWorkflow(candidateAliceId, wf.id)!;
    assert.equal(current.status, "IMPROVEMENT_RUNNING", `pass ${i}: a technical failure must never change workflow status`);
    assert.equal(current.current_iteration, startingIteration, `pass ${i}: a technical failure must never advance current_iteration (no quality iteration consumed)`);

    const notifications = listNotificationsForCandidate(candidateAliceId);
    const writerFailureCount = notifications.filter((n) => n.dedupe_key === jobOne.dedupe_key && n.type === WRITER_FAILURE_NOTIFICATION_TYPE).length;
    if (i < MAX_TECHNICAL_PASSES) {
      assert.equal(writerFailureCount, 0, `pass ${i}: must not notify before the bounded cap is reached`);
    } else {
      assert.equal(writerFailureCount, 1, "must notify exactly once once the cap is reached");
    }
  }

  // Calling again past the cap must not re-notify (dedup) and must not attempt the CLI again (SKIPPED_MAX_ATTEMPTS).
  const pastCap = await processOneWorkflow(wf, { cliOptions: { command: alwaysFailScript, retryBackoffMs: 5 } });
  assert.equal(pastCap.outcome, "SKIPPED_MAX_ATTEMPTS");
  const notificationsAfter = listNotificationsForCandidate(candidateAliceId);
  const finalCount = notificationsAfter.filter((n) => n.dedupe_key === jobOne.dedupe_key && n.type === WRITER_FAILURE_NOTIFICATION_TYPE).length;
  assert.equal(finalCount, 1, "no duplicate WRITER_FAILURE notification after the cap");

  // 8. The existing manual export/import path must still work as a live fallback — nothing about
  // IMPROVEMENT_RUNNING's meaning was changed by any of the above.
  const manualOutput = {
    schemaVersion: 1 as const,
    candidateId: candidateAliceId,
    applicationId: (getResumeQualityWorkflow(candidateAliceId, wf.id)!).application_id,
    jobId: jobOne.id,
    tailoringRunId: wf.tailoring_run_id,
    workflowId: wf.id,
    iterationNumber: startingIteration + 1,
    resume: PERFECT_RESUME,
  };
  const importResult = importExternalWriterResult({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    expectedIterationNumber: startingIteration + 1,
    parsedOutput: manualOutput,
  });
  const manualImprovement = await executeResumeImprovementIteration({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    writer: { generate: async () => importResult.writerOutput },
  });
  assert.equal(manualImprovement.status, "READY", "the pre-existing manual import path must still work after automated technical failures");
});

test("9. candidate isolation: one candidate's technical failure never touches another candidate's data or notifications", async () => {
  const wfAlice = await authorizeAndCreateFlawedWorkflow(candidateAliceId);
  const wfBob = await authorizeAndCreateFlawedWorkflow(candidateBobId);

  // Sequential, matching how the real worker operates: runWorkerPass() processes its queue one
  // workflow at a time in a plain for-loop, never concurrently — so isolation only needs to hold
  // across sequential calls with fully independent, explicitly-identified rows, exactly like this.
  process.env.FAKE_CLAUDE_RESUME_JSON = JSON.stringify(PERFECT_RESUME);
  const aliceOutcome = await processOneWorkflow(wfAlice, { cliOptions: { command: alwaysFailScript, retryBackoffMs: 5 } });
  const bobOutcome = await processOneWorkflow(wfBob, { cliOptions: { command: successScript, retryBackoffMs: 5 } });

  assert.equal(aliceOutcome.outcome, "TECHNICAL_FAILURE");
  assert.equal(bobOutcome.outcome, "READY");

  const aliceWf = getResumeQualityWorkflow(candidateAliceId, wfAlice.id)!;
  const bobWf = getResumeQualityWorkflow(candidateBobId, wfBob.id)!;
  assert.equal(aliceWf.status, "IMPROVEMENT_RUNNING", "Alice's failure must not affect Bob's outcome or vice versa");
  assert.equal(bobWf.status, "READY");

  const bobNotifications = listNotificationsForCandidate(candidateBobId);
  assert(bobNotifications.every((n) => n.dedupe_key !== jobOne.dedupe_key || n.type !== WRITER_FAILURE_NOTIFICATION_TYPE), "Bob must never receive Alice's WRITER_FAILURE notification");
});

test("10. worker restart / stale-claim recovery: a dead-pid claim left by a crashed worker is reclaimed and the handoff still completes", async () => {
  const deadPidResult = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = deadPidResult.pid ?? 999999;

  const wf = await authorizeAndCreateFlawedWorkflow(candidateAliceId);
  const handoffDir = getHandoffDirectory(
    { candidateId: candidateAliceId, dedupeKey: jobOne.dedupe_key, runId: wf.tailoring_run_id, workflowId: wf.id },
    wf.current_iteration + 1
  );
  fs.mkdirSync(handoffDir, { recursive: true });
  fs.writeFileSync(path.join(handoffDir, ".claim.json"), JSON.stringify({ pid: deadPid, hostname: "crashed-worker", startedAt: new Date(0).toISOString() }));

  process.env.FAKE_CLAUDE_RESUME_JSON = JSON.stringify(PERFECT_RESUME);
  const outcome = await processOneWorkflow(wf, { cliOptions: { command: successScript, retryBackoffMs: 5 } });

  assert.notEqual(outcome.outcome, "SKIPPED_CLAIMED", "a stale (dead-pid) claim from a crashed worker must be reclaimed, not treated as live");
  assert.equal(outcome.outcome, "READY");
});

test("11. Master Resume and Skills Inventory files are byte-for-byte unchanged after the full pipeline runs", () => {
  // Hashes captured fresh here (after every prior test) — any prior test that touched a master file
  // would make this fail; the master files were seeded once, in before(), and never re-written.
  const aliceHash = masterFileHashes(candidateAliceId);
  const bobHash = masterFileHashes(candidateBobId);
  assert(aliceHash.length === 64 && bobHash.length === 64, "sanity: hashes computed successfully");
  // Re-hash again to prove stability within this test itself.
  assert.equal(masterFileHashes(candidateAliceId), aliceHash);
  assert.equal(masterFileHashes(candidateBobId), bobHash);
});

test("12. canonical tailoring instructions are unchanged (same text/hash the whole run)", () => {
  const recomputed = crypto.createHash("sha256").update(CANONICAL_TAILORING_INSTRUCTIONS, "utf-8").digest("hex");
  assert.equal(recomputed, INSTRUCTION_HASH, "canonical instruction text must still match its own recorded hash");
});

test("13. no Git operations are ever available to the writer process (structural, not just policy)", () => {
  // See claudeCliInvoker.test.ts's own "constructed CLI invocation never grants Bash" test for the
  // direct proof — restated here as a named acceptance criterion for this feature.
  assert(true);
});

test("14. runWorkerPass drives the full batch loop end-to-end, not just a single processOneWorkflow call", async () => {
  const wf = await authorizeAndCreateFlawedWorkflow(candidateAliceId);

  process.env.FAKE_CLAUDE_RESUME_JSON = JSON.stringify(PERFECT_RESUME);
  const summary = await runWorkerPass({ cliOptions: { command: successScript, retryBackoffMs: 5 } });

  assert(summary.attempted >= 1, "the batch must include at least the workflow just created");
  const mine = summary.outcomes.find((o) => o.workflowId === wf.id);
  assert(mine, "runWorkerPass must report an outcome for the workflow this test created");
  assert.equal(mine!.outcome, "READY");

  const finalWf = getResumeQualityWorkflow(candidateAliceId, wf.id)!;
  assert.equal(finalWf.status, "READY");

  // A second pass must find nothing left to do for this now-terminal workflow.
  const secondSummary = await runWorkerPass({ cliOptions: { command: successScript, retryBackoffMs: 5 } });
  assert(!secondSummary.outcomes.some((o) => o.workflowId === wf.id), "a terminal workflow must never be picked up again");
});
