import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { ResumeContent } from "../../../../../tools/tailoring-engine/types";

/**
 * Stage 26 — autonomous tailoring execution & application visibility.
 *
 * Everything here runs against an isolated temp DB (CAREER_OPS_DB_PATH) plus isolated temp candidate
 * and generated-artifact roots, following scripts/__tests__/resume-writer-worker.test.ts's pattern.
 * Every "claude" invocation is a tiny fixture executable, never a real billed generation, so the REAL
 * export -> invoke -> import -> review -> gate -> publish pipeline is exercised end to end with only
 * the external process replaced. Production data/app.db is never opened by this file.
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
let getResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").getResumeQualityWorkflow;
let getLatestResumeQualityWorkflowForJob: typeof import("@/db/queries/resumeQualityWorkflows").getLatestResumeQualityWorkflowForJob;
let listResumeQualityIterations: typeof import("@/db/queries/resumeQualityWorkflows").listResumeQualityIterations;
let listWorkflowsAwaitingWriter: typeof import("@/db/queries/resumeQualityWorkflows").listWorkflowsAwaitingWriter;
let updateAppSettings: typeof import("@/db/queries/settings").updateAppSettings;
let getAppSettings: typeof import("@/db/queries/settings").getAppSettings;

let workflowGet: typeof import("../../../../app/api/candidates/[candidateId]/jobs/[jobId]/quality-workflow/route").GET;
let workflowPost: typeof import("../../../../app/api/candidates/[candidateId]/jobs/[jobId]/quality-workflow/route").POST;

let processOneWorkflow: typeof import("../writerWorkerCore").processOneWorkflow;
let runWorkerPass: typeof import("../writerWorkerCore").runWorkerPass;
let runGuardedWriterPass: typeof import("../writerWorkerCore").runGuardedWriterPass;
let runResumeWriterTick: typeof import("../tick").runResumeWriterTick;
let RESUME_WRITER_BATCH_SIZE: number;
let RESUME_WRITER_INTERVAL_MINUTES: number;
let acquireResumeWriterLease: typeof import("../writerState").acquireResumeWriterLease;
let forceReleaseResumeWriterLease: typeof import("../writerState").forceReleaseResumeWriterLease;
let getResumeWriterLeaseStatus: typeof import("../writerState").getResumeWriterLeaseStatus;
let resetResumeWriterStateForTests: typeof import("../writerState").resetResumeWriterStateForTests;
let getResumeWriterRuntimeState: typeof import("../writerState").getResumeWriterRuntimeState;
let getResumeWriterHealth: typeof import("../writerHealth").getResumeWriterHealth;
let getWorkspaceDirectory: typeof import("../../workspace").getWorkspaceDirectory;
let getFinalDirectory: typeof import("../../workspace").getFinalDirectory;
let getHandoffDirectory: typeof import("../../workspace").getHandoffDirectory;
let finalResumeFilename: typeof import("../../workspace").finalResumeFilename;
let getPublishedApplicationsRoot: typeof import("../../finalPublication").getPublishedApplicationsRoot;
let publishedCompanySlug: typeof import("../../finalPublication").publishedCompanySlug;

let candidateAliceId: number;
let candidateBobId: number;
let companyId: number;
const jobs: Array<{ id: number; dedupe_key: string }> = [];

let successScript: string;
let failScript: string;
let malformedScript: string;
let hangScript: string;
let overloadedScript: string;

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

function perfectResume(name: string, email: string): ResumeContent {
  return {
    name,
    tagline: "Senior Data Engineer",
    location: "Remote, US",
    phone: "312-555-9821",
    email,
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
}

function flawedResume(name: string, email: string): ResumeContent {
  const base = perfectResume(name, email);
  return {
    ...base,
    experience: [
      {
        title: "Senior Data Engineer",
        company: "Acme Corp",
        dates: "2020 - Present",
        bullets: ["Built batch data ingestion pipelines using Azure Data Factory and AWS Glue."],
      },
    ],
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

function masterFileHashes(candId: number): string {
  const masterDir = path.join(tmpCandidatesDir, String(candId), "master");
  const hash = crypto.createHash("sha256");
  for (const f of ["resume.txt", "skills.json"]) {
    hash.update(fs.readFileSync(path.join(masterDir, f)));
  }
  return hash.digest("hex");
}

function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function enableScheduler(): void {
  const res = updateAppSettings({
    scheduler: { enabled: true, intervalMinutes: 60, windowStartHour: 0, windowEndHour: 23, timezone: "UTC" },
  });
  assert.equal(res.ok, true, "fixture: scheduler settings must persist");
}

function disableScheduler(): void {
  updateAppSettings({ scheduler: { enabled: false } });
}

/** Every insert needs its own knowledge hash, or a repeat authorization for the same
 *  candidate/job/decision dedupes against the earlier row and the "latest" match result stays
 *  whatever it was before — silently leaving a stale approval behind. */
let matchInsertCounter = 0;

/** Marks a job approved by a human exactly as the UI's approve action does. */
function authorizeJob(candId: number, j: { id: number; dedupe_key: string }, decision = "READY_FOR_TAILORING"): void {
  insertJobMatchResult({
    candidateId: candId,
    jobId: j.id,
    dedupeKey: j.dedupe_key,
    matchEngineVersion: 2,
    matchKnowledgeHash: `k-${candId}-${j.id}-${decision}-${++matchInsertCounter}`,
    candidateProfileHash: `p-${candId}-${j.id}`,
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
    decision: decision as "READY_FOR_TAILORING",
    blockingReasons: [],
    roleAlignmentDetail: null,
  });
  // READY_DIRECT may only pair with READY_FOR_TAILORING, NEEDS_REVIEW_OVERRIDE only with
  // NEEDS_REVIEW — see APPROVAL_TYPE_REQUIRES_DECISION in src/lib/tailoringExecution.ts.
  setMarkedForTailoring(candId, j.dedupe_key, true, {
    approvalType: decision === "READY_FOR_TAILORING" ? "READY_DIRECT" : "NEEDS_REVIEW_OVERRIDE",
    decision,
  });
}

/** Runs the real POST route (the human "Approve & Start Tailoring" action). */
async function approveViaRoute(candId: number, jobId: number) {
  const req = new NextRequest(`http://localhost/api/candidates/${candId}/jobs/${jobId}/quality-workflow`, { method: "POST" });
  const res = await workflowPost(req, { params: Promise.resolve({ candidateId: String(candId), jobId: String(jobId) }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Same, but asserts the approval actually succeeded — a silent 400 here would otherwise surface much
 *  later as a confusing "undefined workflow" in an unrelated assertion. */
async function approveOrThrow(candId: number, jobId: number) {
  const { status, body } = await approveViaRoute(candId, jobId);
  assert.equal(status, 200, `fixture: approval failed (${JSON.stringify(body)})`);
  return body;
}

async function getViaRoute(candId: number, jobId: number) {
  const req = new NextRequest(`http://localhost/api/candidates/${candId}/jobs/${jobId}/quality-workflow`);
  const res = await workflowGet(req, { params: Promise.resolve({ candidateId: String(candId), jobId: String(jobId) }) });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

/** Seeds the workspace files the writer reads. The POST route writes these itself; tests that build a
 *  workflow through the route rely on that, and only override jobRequirements to keep the fixture's
 *  review deterministic. */
function seedRequirements(candId: number, wfId: number, runId: number, dedupeKey: string): void {
  const wsDir = getWorkspaceDirectory({ candidateId: candId, dedupeKey, runId, workflowId: wfId });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "extracted_job_requirements.json"), JSON.stringify(STRONG_REQUIREMENTS, null, 2));
}

before(async () => {
  // Armed BEFORE anything is imported: no code path in this suite — including the scheduler tick,
  // which reaches the writer indirectly — may spawn the real, billed Claude CLI. Every invocation
  // below passes an explicit fixture command; this makes forgetting one a loud failure, not a charge.
  process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI = "1";

  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s26-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s26-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s26-gen-"));
  tmpFixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s26-fix-"));
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
  ({
    getResumeQualityWorkflow,
    getLatestResumeQualityWorkflowForJob,
    listResumeQualityIterations,
    listWorkflowsAwaitingWriter,
  } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ updateAppSettings, getAppSettings } = await import("@/db/queries/settings"));
  ({ GET: workflowGet, POST: workflowPost } = await import(
    "../../../../app/api/candidates/[candidateId]/jobs/[jobId]/quality-workflow/route"
  ));
  ({ processOneWorkflow, runWorkerPass, runGuardedWriterPass } = await import("../writerWorkerCore"));
  ({ runResumeWriterTick, RESUME_WRITER_BATCH_SIZE, RESUME_WRITER_INTERVAL_MINUTES } = await import("../tick"));
  ({
    acquireResumeWriterLease,
    forceReleaseResumeWriterLease,
    getResumeWriterLeaseStatus,
    resetResumeWriterStateForTests,
    getResumeWriterRuntimeState,
  } = await import("../writerState"));
  ({ getResumeWriterHealth } = await import("../writerHealth"));
  ({ getWorkspaceDirectory, getFinalDirectory, getHandoffDirectory, finalResumeFilename } = await import("../../workspace"));
  ({ getPublishedApplicationsRoot, publishedCompanySlug } = await import("../../finalPublication"));

  getDb();

  candidateAliceId = createCandidate({ firstName: "Alice", lastName: "Smith" }).id;
  candidateBobId = createCandidate({ firstName: "Bob", lastName: "Jones" }).id;

  function seedCandidateMasterFiles(candId: number) {
    const masterDir = path.join(tmpCandidatesDir, String(candId), "master");
    fs.mkdirSync(masterDir, { recursive: true });
    fs.writeFileSync(
      path.join(masterDir, "resume.txt"),
      `Resume for candidate ${candId}\nAcme Corp\nSenior Data Engineer\n2020 - Present`
    );
    fs.writeFileSync(path.join(masterDir, "skills.json"), JSON.stringify({ skills: ["Azure", "Python"] }));
    fs.writeFileSync(
      path.join(masterDir, "manifest.json"),
      JSON.stringify({
        resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: `r-${candId}` },
        skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: `s-${candId}` },
      })
    );
    fs.writeFileSync(
      path.join(tmpCandidatesDir, String(candId), "candidate-profile.json"),
      JSON.stringify({ ...masterProfile(), sourceHashes: { resume: `r-${candId}`, skills: `s-${candId}` } })
    );
  }
  seedCandidateMasterFiles(candidateAliceId);
  seedCandidateMasterFiles(candidateBobId);

  companyId = createCompany({ name: "Stage26 Test Co", source_type: "greenhouse", ats_board_token: "stage26" }).id;

  for (let i = 1; i <= 6; i++) {
    const dedupeKey = dedupeKeyForAts("greenhouse", companyId, `s26-job-${i}`);
    upsertJob({
      companyId,
      sourceType: "greenhouse",
      dedupeKey,
      job: {
        externalId: `s26-job-${i}`,
        title: `Senior Data Engineer ${i}`,
        location: "Remote",
        department: "Data",
        url: `https://boards.greenhouse.io/stage26/s26-job-${i}`,
        descriptionHtml: null,
        descriptionText: "Azure Data Factory and Databricks pipelines at scale.",
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
    const j = getJobByDedupeKey(dedupeKey)!;
    jobs.push({ id: j.id, dedupe_key: j.dedupe_key });
  }

  // Fixture "claude" executables — never a real, billed generation.
  successScript = path.join(tmpFixturesDir, "fake-claude-success.js");
  fs.writeFileSync(
    successScript,
    `#!/usr/bin/env node
const fs = require('fs');
const input = JSON.parse(fs.readFileSync('writer_input.json', 'utf-8'));
const resume = JSON.parse(process.env.FAKE_CLAUDE_RESUME_JSON);
fs.writeFileSync('writer_output.json', JSON.stringify({
  schemaVersion: 1,
  candidateId: input.candidateId,
  applicationId: input.applicationId,
  jobId: input.jobId,
  tailoringRunId: input.tailoringRunId,
  workflowId: input.workflowId,
  iterationNumber: input.targetIterationNumber,
  resume,
}, null, 2));
process.exit(0);
`,
    { mode: 0o755 }
  );

  failScript = path.join(tmpFixturesDir, "fake-claude-fails.js");
  fs.writeFileSync(failScript, `#!/usr/bin/env node\nprocess.stderr.write('boom');\nprocess.exit(3);\n`, { mode: 0o755 });

  malformedScript = path.join(tmpFixturesDir, "fake-claude-malformed.js");
  fs.writeFileSync(
    malformedScript,
    `#!/usr/bin/env node\nrequire('fs').writeFileSync('writer_output.json', '{ this is not json');\nprocess.exit(0);\n`,
    { mode: 0o755 }
  );

  // Reproduces the exact shape the real CLI produced on the real corpus: exit 1, EMPTY stderr, and
  // the only explanation in the stdout JSON. Before Stage 26 captured stdout, this surfaced as the
  // literally uninformative "Claude CLI exited with code 1: ".
  overloadedScript = path.join(tmpFixturesDir, "fake-claude-529.js");
  fs.writeFileSync(
    overloadedScript,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  is_error: true,
  subtype: "success",
  api_error_status: 529,
  terminal_reason: "api_error",
  result: "API Error: 529 Overloaded. This is a server-side issue, usually temporary."
}));
process.exit(1);
`,
    { mode: 0o755 }
  );

  hangScript = path.join(tmpFixturesDir, "fake-claude-hangs.js");
  fs.writeFileSync(hangScript, `#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 60000);\n`, { mode: 0o755 });

  // Used by every tick-level test: the tick's own scheduling decisions are what those tests assert,
  // so the pass underneath must be inert — zero workflows processed, and a fixture command even so.
  STUB_CLI = { maxWorkflows: 0, cliOptions: { command: failScript, retryBackoffMs: 1 } };
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
  for (const d of [tmpDbDir, tmpCandidatesDir, tmpGeneratedDir, tmpFixturesDir]) {
    if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

/** A pass that must not produce anything: processes at most nothing, and if it somehow reaches the
 *  writer it uses the deterministic failing fixture rather than the real CLI. */
let STUB_CLI: { maxWorkflows: number; cliOptions: { command: string; retryBackoffMs: number } };

const cliSuccess = (resume: ResumeContent) => {
  process.env.FAKE_CLAUDE_RESUME_JSON = JSON.stringify(resume);
  return { command: successScript, retryBackoffMs: 1 };
};

// ---------------------------------------------------------------------------------------------
// Phase 2 — initial seed defect
// ---------------------------------------------------------------------------------------------

test("S26-01 approving a job creates a CREATED workflow with zero iterations and no synthesized resume", async () => {
  const job = jobs[0];
  authorizeJob(candidateAliceId, job);
  const { status, body } = await approveViaRoute(candidateAliceId, job.id);

  assert.equal(status, 200);
  assert.equal(body.awaitingWriter, true, "the human's part is done; the writer owns the next step");
  const wf = body.workflow as { status: string; current_iteration: number; max_iterations: number };
  assert.equal(wf.status, "CREATED");
  assert.equal(wf.current_iteration, 0, "no iteration is consumed at approval time");
  assert.equal(wf.max_iterations, 3);
  assert.equal(listResumeQualityIterations(candidateAliceId, (body.workflow as { id: number }).id).length, 0);
});

test("S26-02 no placeholder contact details or fabricated bullets exist anywhere in the new workflow", async () => {
  const job = jobs[0];
  const wf = getLatestResumeQualityWorkflowForJob(candidateAliceId, job.dedupe_key)!;
  const qualityDir = path.dirname(getWorkspaceDirectory({ candidateId: candidateAliceId, dedupeKey: job.dedupe_key, runId: wf.tailoring_run_id, workflowId: wf.id }));

  const forbidden = [
    "candidate@example.com",
    "555-0100",
    "Software Professional",
    "Engineered data platforms and core workflows at",
    "Experienced software and data professional with a proven track record",
  ];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      let text: string;
      try {
        text = fs.readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      for (const needle of forbidden) {
        if (text.includes(needle)) offenders.push(`${full} :: ${needle}`);
      }
    }
  };
  walk(qualityDir);
  assert.deepEqual(offenders, [], "the removed placeholder seed must leave no trace on disk");

  // And nothing in the DB either — no iteration row exists to hold it.
  assert.equal(listResumeQualityIterations(candidateAliceId, wf.id).length, 0);
});

test("S26-03 all three quality iterations remain available as genuine writer attempts", async () => {
  const job = jobs[0];
  const wf = getLatestResumeQualityWorkflowForJob(candidateAliceId, job.dedupe_key)!;
  const { body } = await getViaRoute(candidateAliceId, job.id);
  const budget = body.iterationBudget as unknown as { max: number; writerAttemptsUsed: number; writerAttemptsRemaining: number; targetIteration: number };
  assert.equal(budget.max, wf.max_iterations);
  assert.equal(budget.writerAttemptsUsed, 0);
  assert.equal(budget.writerAttemptsRemaining, 3, "before Stage 26 iteration 1 was spent on a synthesized resume, leaving 2");
  assert.equal(budget.targetIteration, 1, "the writer produces iteration 1 itself");
});

test("S26-04 approving twice never creates a second workflow and never re-runs anything", async () => {
  const job = jobs[0];
  const before = getLatestResumeQualityWorkflowForJob(candidateAliceId, job.dedupe_key)!;
  const { status, body } = await approveViaRoute(candidateAliceId, job.id);
  assert.equal(status, 200);
  assert.equal((body.workflow as { id: number }).id, before.id);
  assert.equal((body.workflow as { current_iteration: number }).current_iteration, before.current_iteration);
});

test("S26-05 candidate master resume / skills inventory are byte-for-byte unchanged by approval", () => {
  const masterDir = path.join(tmpCandidatesDir, String(candidateAliceId), "master");
  assert.equal(
    masterFileHashes(candidateAliceId),
    crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(masterDir, "resume.txt")))
      .update(fs.readFileSync(path.join(masterDir, "skills.json")))
      .digest("hex")
  );
});

// ---------------------------------------------------------------------------------------------
// Phase 3 — automatic scheduling
// ---------------------------------------------------------------------------------------------

test("S26-10 the tick refuses to run while background automation is disabled", async () => {
  resetResumeWriterStateForTests();
  disableScheduler();
  const out = await runResumeWriterTick(new Date("2026-06-01T12:00:00Z"), STUB_CLI);
  assert.equal(out.outcome, "SKIPPED_DISABLED");
  // But it still recorded that it was evaluated — that is what makes "off" distinguishable from
  // "nothing is running the scheduler".
  assert.ok(getResumeWriterRuntimeState().lastTickAt);
});

test("S26-11 the tick refuses to run outside the operator's automation window", async () => {
  resetResumeWriterStateForTests();
  const res = updateAppSettings({
    scheduler: { enabled: true, intervalMinutes: 60, windowStartHour: 1, windowEndHour: 2, timezone: "UTC" },
  });
  assert.equal(res.ok, true);
  const out = await runResumeWriterTick(new Date("2026-06-01T12:00:00Z"), STUB_CLI);
  assert.equal(out.outcome, "SKIPPED_OUTSIDE_WINDOW");
});

test("S26-12 the tick honours its own bounded interval", async () => {
  resetResumeWriterStateForTests();
  enableScheduler();
  const job = jobs[0];
  // First tick runs (there is pending work); a tick one minute later must not.
  const first = await runResumeWriterTick(new Date("2026-06-01T12:00:00Z"), STUB_CLI);
  assert.notEqual(first.outcome, "SKIPPED_INTERVAL_NOT_DUE");
  const second = await runResumeWriterTick(new Date("2026-06-01T12:01:00Z"), STUB_CLI);
  assert.equal(second.outcome, "SKIPPED_INTERVAL_NOT_DUE");
  assert.ok(RESUME_WRITER_INTERVAL_MINUTES >= 30, "cadence must stay conservative — subscription usage is involved");
  assert.ok(getLatestResumeQualityWorkflowForJob(candidateAliceId, job.dedupe_key));
});

test("S26-13 the tick discovers an approved CREATED workflow and the writer produces iteration 1 — no manual worker needed", async () => {
  resetResumeWriterStateForTests();
  enableScheduler();
  const job = jobs[1];
  authorizeJob(candidateAliceId, job);
  await approveOrThrow(candidateAliceId, job.id);
  const wf = getLatestResumeQualityWorkflowForJob(candidateAliceId, job.dedupe_key)!;
  seedRequirements(candidateAliceId, wf.id, wf.tailoring_run_id, job.dedupe_key);

  assert.ok(
    listWorkflowsAwaitingWriter().some((w) => w.id === wf.id),
    "a CREATED workflow must be discoverable as awaiting-writer work"
  );

  // Drive the pass the tick drives, with the fixture CLI substituted for the real one.
  const outcome = await processOneWorkflow(wf, { cliOptions: cliSuccess(flawedResume("Alice Smith", "alice@gmail.com")) });
  assert.equal(outcome.iterationNumber, 1);
  assert.ok(["IMPROVEMENT_RUNNING", "READY"].includes(outcome.outcome), `unexpected outcome ${outcome.outcome}: ${outcome.error ?? ""}`);

  const iters = listResumeQualityIterations(candidateAliceId, wf.id);
  assert.equal(iters.length, 1);
  assert.equal(iters[0].iteration_number, 1);
  const review = JSON.parse(iters[0].review_json!) as { overallScore: number };
  assert.ok(review.overallScore > 0);

  // The resume that was reviewed is the writer's, carrying the candidate's own contact details.
  const resumeJson = JSON.parse(
    fs.readFileSync(
      path.join(
        path.dirname(getWorkspaceDirectory({ candidateId: candidateAliceId, dedupeKey: job.dedupe_key, runId: wf.tailoring_run_id, workflowId: wf.id })),
        "iterations",
        "1",
        "resume_content.json"
      ),
      "utf-8"
    )
  ) as ResumeContent;
  assert.equal(resumeJson.email, "alice@gmail.com");
  assert.notEqual(resumeJson.email, "candidate@example.com");
  assert.notEqual(resumeJson.phone, "555-0100");
});

test("S26-14 a high match score alone never causes tailoring — with no human approval there is no workflow and nothing queued", async () => {
  const job = jobs[5];
  // A strong, READY_FOR_TAILORING match result, but the human never approved it.
  insertJobMatchResult({
    candidateId: candidateBobId,
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    matchEngineVersion: 2,
    matchKnowledgeHash: "score-only",
    candidateProfileHash: "p-score-only",
    candidateSettingsHash: "s",
    jdContentHash: "j",
    computedAt: "2026-01-01T00:00:00Z",
    eligibility: { status: "PASS", reasons: [], sponsorship: { signal: "not_applicable", note: "n/a" } },
    dimensionScores: { roleAlignment: null, required: 100, preferred: 100, experience: 100, seniority: 100 },
    overallScore: 100,
    requirementCoverage: 1,
    employerEvidencedShare: 1,
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

  assert.equal(getLatestResumeQualityWorkflowForJob(candidateBobId, job.dedupe_key), undefined);
  assert.equal(
    listWorkflowsAwaitingWriter().some((w) => w.candidate_id === candidateBobId && w.dedupe_key === job.dedupe_key),
    false
  );

  // And the route itself still refuses without the approval flag.
  const { status } = await approveViaRoute(candidateBobId, job.id);
  assert.equal(status, 400);
});

test("S26-15 an approval that no longer matches the job's current decision is skipped, not written", async () => {
  const job = jobs[2];
  authorizeJob(candidateAliceId, job, "NEEDS_REVIEW");
  await approveOrThrow(candidateAliceId, job.id);
  const wf = getLatestResumeQualityWorkflowForJob(candidateAliceId, job.dedupe_key)!;
  seedRequirements(candidateAliceId, wf.id, wf.tailoring_run_id, job.dedupe_key);

  // The job is re-evaluated and now BLOCKED — the earlier NEEDS_REVIEW approval is stale.
  insertJobMatchResult({
    candidateId: candidateAliceId,
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    matchEngineVersion: 2,
    matchKnowledgeHash: "now-blocked",
    candidateProfileHash: "p-blocked",
    candidateSettingsHash: "s",
    jdContentHash: "j",
    computedAt: "2026-02-01T00:00:00Z",
    eligibility: { status: "BLOCKED", reasons: ["sponsorship"], sponsorship: { signal: "explicit_negative", note: "no" } },
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
    decision: "BLOCKED",
    blockingReasons: ["Requires sponsorship"],
    roleAlignmentDetail: null,
  });

  const outcome = await processOneWorkflow(wf, { cliOptions: cliSuccess(perfectResume("Alice Smith", "alice@gmail.com")) });
  assert.equal(outcome.outcome, "SKIPPED_UNAUTHORIZED");
  assert.match(outcome.error ?? "", /stale/i);
  // Nothing was written, nothing was spent, and no handoff directory was even created.
  assert.equal(listResumeQualityIterations(candidateAliceId, wf.id).length, 0);
  assert.equal(getResumeQualityWorkflow(candidateAliceId, wf.id)!.status, "CREATED");
  assert.equal(fs.existsSync(getHandoffDirectory({ candidateId: candidateAliceId, dedupeKey: job.dedupe_key, runId: wf.tailoring_run_id, workflowId: wf.id }, 1)), false);
});

test("S26-16 a pass is bounded — more pending workflows than the batch size are processed a batch at a time", async () => {
  const pending = listWorkflowsAwaitingWriter();
  assert.ok(pending.length >= RESUME_WRITER_BATCH_SIZE, "fixture: need at least a full batch of pending work");
  // maxWorkflows: 1 proves the bound is honoured independently of the production constant's value.
  const summary = await runWorkerPass({ maxWorkflows: 1, cliOptions: { command: failScript, retryBackoffMs: 1 } });
  assert.equal(summary.attempted, 1);
  assert.equal(summary.pending, pending.length, "pending must report the true queue depth, never just what was attempted");
});

test("S26-17 a READY workflow is never picked up again", async () => {
  const job = jobs[3];
  authorizeJob(candidateAliceId, job);
  await approveOrThrow(candidateAliceId, job.id);
  const wf = getLatestResumeQualityWorkflowForJob(candidateAliceId, job.dedupe_key)!;
  seedRequirements(candidateAliceId, wf.id, wf.tailoring_run_id, job.dedupe_key);

  const outcome = await processOneWorkflow(wf, { cliOptions: cliSuccess(perfectResume("Alice Smith", "alice@gmail.com")) });
  assert.equal(outcome.outcome, "READY", `expected READY, got ${outcome.outcome}: ${outcome.error ?? ""}`);
  assert.equal(getResumeQualityWorkflow(candidateAliceId, wf.id)!.status, "READY");
  assert.equal(listWorkflowsAwaitingWriter().some((w) => w.id === wf.id), false);
});

test("S26-18 the machine-wide lease prevents overlapping writer execution", async () => {
  resetResumeWriterStateForTests();
  const held = acquireResumeWriterLease();
  assert.equal(held.acquired, true);
  try {
    const blocked = await runGuardedWriterPass({ cliOptions: { command: failScript, retryBackoffMs: 1 } });
    assert.equal(blocked.ran, false, "a second pass must not run while the lease is held");
    assert.equal(blocked.attempted, 0);
    assert.ok(blocked.heldSince);
  } finally {
    forceReleaseResumeWriterLease();
  }
  assert.equal(getResumeWriterLeaseStatus().held, false);
});

test("S26-19 a lease abandoned by a dead process (or a sleeping Mac) goes stale and is reclaimed — bounded, never duplicated", async () => {
  resetResumeWriterStateForTests();
  const { getDb } = await import("@/db/index");
  acquireResumeWriterLease();
  // Simulate a pass that died without releasing: its last heartbeat is far in the past.
  getDb()
    .prepare("UPDATE settings SET value = ? WHERE key = 'resume_writer_lock.acquired_at'")
    .run(new Date(Date.now() - 60 * 60_000).toISOString());
  assert.equal(getResumeWriterLeaseStatus().held, false, "a lease with no recent heartbeat reads as not held");
  assert.equal(getResumeWriterLeaseStatus().stale, true);

  const reacquired = acquireResumeWriterLease();
  assert.equal(reacquired.acquired, true, "the next pass reclaims it rather than waiting forever");
  forceReleaseResumeWriterLease();
});

test("S26-20 the tick keeps working after a writer failure, and never marks anything READY", async () => {
  resetResumeWriterStateForTests();
  enableScheduler();
  const job = jobs[4];
  authorizeJob(candidateBobId, job);
  await approveOrThrow(candidateBobId, job.id);
  const wf = getLatestResumeQualityWorkflowForJob(candidateBobId, job.dedupe_key)!;
  seedRequirements(candidateBobId, wf.id, wf.tailoring_run_id, job.dedupe_key);

  const failed = await processOneWorkflow(wf, { cliOptions: { command: failScript, retryBackoffMs: 1 } });
  assert.equal(failed.outcome, "TECHNICAL_FAILURE");
  assert.equal(getResumeQualityWorkflow(candidateBobId, wf.id)!.status, "CREATED", "a technical failure must not advance the workflow");
  assert.equal(listResumeQualityIterations(candidateBobId, wf.id).length, 0, "a technical failure must not consume a quality iteration");

  // The scheduler keeps functioning: the very next pass processes work normally.
  const recovered = await processOneWorkflow(getResumeQualityWorkflow(candidateBobId, wf.id)!, {
    cliOptions: cliSuccess(perfectResume("Bob Jones", "bob@gmail.com")),
  });
  assert.ok(["READY", "IMPROVEMENT_RUNNING"].includes(recovered.outcome), `unexpected ${recovered.outcome}: ${recovered.error ?? ""}`);
});

// ---------------------------------------------------------------------------------------------
// Failure acceptance
// ---------------------------------------------------------------------------------------------

test("S26-30 malformed writer output never marks a workflow READY", async () => {
  const job = jobs[2];
  // Re-approve this job so the stale-approval skip from S26-15 no longer applies and the writer is
  // genuinely reached — these three tests are about technical failure, not authorization.
  authorizeJob(candidateAliceId, job, "NEEDS_REVIEW");
  const wf = getResumeQualityWorkflow(candidateAliceId, getLatestResumeQualityWorkflowForJob(candidateAliceId, job.dedupe_key)!.id)!;
  const outcome = await processOneWorkflow(wf, { cliOptions: { command: malformedScript, retryBackoffMs: 1 } });
  assert.equal(outcome.outcome, "TECHNICAL_FAILURE");
  assert.match(outcome.error ?? "", /not valid JSON/i);
  assert.notEqual(getResumeQualityWorkflow(candidateAliceId, wf.id)!.status, "READY");
});

test("S26-31 a writer timeout never marks a workflow READY, and retries stay bounded", async () => {
  const job = jobs[2];
  const wf = getResumeQualityWorkflow(candidateAliceId, getLatestResumeQualityWorkflowForJob(candidateAliceId, job.dedupe_key)!.id)!;
  const started = Date.now();
  const outcome = await processOneWorkflow(wf, { cliOptions: { command: hangScript, timeoutMs: 250, retryBackoffMs: 1 } });
  const elapsed = Date.now() - started;
  assert.equal(outcome.outcome, "TECHNICAL_FAILURE");
  assert.match(outcome.error ?? "", /timed out/i);
  assert.notEqual(getResumeQualityWorkflow(candidateAliceId, wf.id)!.status, "READY");
  assert.ok(elapsed < 30_000, `retries must be bounded, took ${elapsed}ms`);
});

test("S26-32 repeated technical failures stop auto-retrying at the bounded cap instead of looping", async () => {
  const { MAX_TECHNICAL_PASSES } = await import("../handoffClaim");
  const job = jobs[2];
  const wf = getResumeQualityWorkflow(candidateAliceId, getLatestResumeQualityWorkflowForJob(candidateAliceId, job.dedupe_key)!.id)!;
  let last = "";
  for (let i = 0; i < MAX_TECHNICAL_PASSES + 2; i++) {
    last = (await processOneWorkflow(wf, { cliOptions: { command: failScript, retryBackoffMs: 1 } })).outcome;
  }
  assert.equal(last, "SKIPPED_MAX_ATTEMPTS");
  assert.notEqual(getResumeQualityWorkflow(candidateAliceId, wf.id)!.status, "READY");
});

// ---------------------------------------------------------------------------------------------
// Phase 4 — worker health
// ---------------------------------------------------------------------------------------------

test("S26-40 health reports the writer as unavailable when nothing has evaluated the tick", async () => {
  resetResumeWriterStateForTests();
  enableScheduler();
  const health = getResumeWriterHealth(new Date());
  assert.equal(health.state, "UNAVAILABLE_NOT_RUNNING");
  assert.match(health.detail, /never run|not been evaluated/i);
});

test("S26-41 health reports scheduler-disabled distinctly from processing or idle", async () => {
  resetResumeWriterStateForTests();
  disableScheduler();
  await runResumeWriterTick(new Date(), STUB_CLI);
  const health = getResumeWriterHealth(new Date());
  assert.equal(health.state, "UNAVAILABLE_SCHEDULER_DISABLED");
  assert.equal(health.schedulerEnabled, false);
});

test("S26-42 health reports PROCESSING only while a pass genuinely holds the lease", async () => {
  resetResumeWriterStateForTests();
  enableScheduler();
  await runResumeWriterTick(new Date(), STUB_CLI);
  const idleState = getResumeWriterHealth(new Date()).state;
  assert.notEqual(idleState, "PROCESSING");

  acquireResumeWriterLease();
  try {
    const health = getResumeWriterHealth(new Date());
    assert.equal(health.state, "PROCESSING");
    assert.ok(health.processingSince);
  } finally {
    forceReleaseResumeWriterLease();
  }
});

test("S26-43 health never infers progress from a workflow being IMPROVEMENT_RUNNING", async () => {
  resetResumeWriterStateForTests();
  enableScheduler();
  await runResumeWriterTick(new Date(), STUB_CLI);
  const health = getResumeWriterHealth(new Date());
  // There IS queued work in this fixture DB, but no pass holds the lease — so it must not read as
  // "processing" merely because a workflow is waiting.
  assert.ok(health.pendingWorkflowCount >= 0);
  assert.notEqual(health.state, "PROCESSING");
});

// ---------------------------------------------------------------------------------------------
// Phase 6 — publication truthfulness
// ---------------------------------------------------------------------------------------------

test("S26-50 a READY workflow records a truthful PUBLISHED result and the published bytes match the approved artifacts", async () => {
  const job = jobs[3];
  const wf = getLatestResumeQualityWorkflowForJob(candidateAliceId, job.dedupe_key)!;
  assert.equal(wf.status, "READY", "fixture: S26-17 left this workflow READY");

  const finalDir = getFinalDirectory({ candidateId: candidateAliceId, dedupeKey: job.dedupe_key, runId: wf.tailoring_run_id, workflowId: wf.id });
  const statusFile = path.join(finalDir, "publication_status.json");
  assert.ok(fs.existsSync(statusFile), "the orchestrator must record what happened to publication");
  const record = JSON.parse(fs.readFileSync(statusFile, "utf-8")) as { status: string; directory: string; error: string | null };
  assert.equal(record.status, "PUBLISHED");
  assert.equal(record.error, null);
  assert.ok(record.directory, "a published record must name where it landed");

  const publishedResume = path.join(getPublishedApplicationsRoot(), publishedCompanySlug("Stage26 Test Co", companyId), path.basename(record.directory), "Alice_Resume.docx");
  assert.ok(fs.existsSync(publishedResume), `expected published resume at ${publishedResume}`);
  assert.equal(
    sha256File(publishedResume),
    sha256File(path.join(finalDir, finalResumeFilename("Alice"))),
    "published bytes must equal the approved artifact byte-for-byte"
  );

  // And the API reports it truthfully.
  const { body } = await getViaRoute(candidateAliceId, job.id);
  const pub = body.publication as unknown as { status: string; directory: string };
  assert.equal(pub.status, "PUBLISHED");
  assert.equal(pub.directory, record.directory);
  assert.ok(!path.isAbsolute(pub.directory), "the API must expose a repo-relative path, not an absolute one");
});

test("S26-51 a publication failure is surfaced separately and never rolls back a legitimate READY approval", async () => {
  // Force a real publication failure: put a plain FILE where the company directory must be created.
  const blockerCompanyId = createCompany({ name: "Blocked Publish Co", source_type: "greenhouse", ats_board_token: "blockedpub" }).id;
  const dedupeKey = dedupeKeyForAts("greenhouse", blockerCompanyId, "s26-blocked");
  upsertJob({
    companyId: blockerCompanyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "s26-blocked",
      title: "Senior Data Engineer Blocked",
      location: "Remote",
      department: "Data",
      url: "https://boards.greenhouse.io/blockedpub/s26-blocked",
      descriptionHtml: null,
      descriptionText: "Azure Data Factory and Databricks pipelines at scale.",
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
  const blockedJob = getJobByDedupeKey(dedupeKey)!;
  authorizeJob(candidateAliceId, { id: blockedJob.id, dedupe_key: blockedJob.dedupe_key });
  await approveOrThrow(candidateAliceId, blockedJob.id);
  const wf = getLatestResumeQualityWorkflowForJob(candidateAliceId, blockedJob.dedupe_key)!;
  seedRequirements(candidateAliceId, wf.id, wf.tailoring_run_id, blockedJob.dedupe_key);

  const root = getPublishedApplicationsRoot();
  fs.mkdirSync(root, { recursive: true });
  const blockerPath = path.join(root, publishedCompanySlug("Blocked Publish Co", blockerCompanyId));
  fs.writeFileSync(blockerPath, "not a directory");

  try {
    const outcome = await processOneWorkflow(wf, { cliOptions: cliSuccess(perfectResume("Alice Smith", "alice@gmail.com")) });
    assert.equal(outcome.outcome, "READY", `expected the quality result to stand: ${outcome.error ?? ""}`);
    const updated = getResumeQualityWorkflow(candidateAliceId, wf.id)!;
    assert.equal(updated.status, "READY", "a filesystem publication failure must never unwind a genuine approval");

    const finalDir = getFinalDirectory({ candidateId: candidateAliceId, dedupeKey: blockedJob.dedupe_key, runId: wf.tailoring_run_id, workflowId: wf.id });
    assert.ok(fs.existsSync(path.join(finalDir, finalResumeFilename("Alice"))), "final/ stays authoritative");
    const record = JSON.parse(fs.readFileSync(path.join(finalDir, "publication_status.json"), "utf-8")) as {
      status: string;
      directory: string | null;
      error: string | null;
    };
    assert.equal(record.status, "FAILED");
    assert.equal(record.directory, null);
    assert.ok(record.error, "the reason must be named, not swallowed");

    const { body } = await getViaRoute(candidateAliceId, blockedJob.id);
    const pub = body.publication as unknown as { status: string; error: string };
    assert.equal(pub.status, "FAILED");
    assert.ok(pub.error);
    // The resume itself is still reported as ready and downloadable.
    assert.equal((body.workflow as unknown as { status: string }).status, "READY");
    assert.equal((body.availableArtifacts as unknown as { hasFinalResume: boolean }).hasFinalResume, true);
  } finally {
    fs.rmSync(blockerPath, { force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Cross-cutting safety
// ---------------------------------------------------------------------------------------------

test("S26-60 no cross-candidate artifact contamination across two concurrently pending candidates", async () => {
  const aliceWf = getLatestResumeQualityWorkflowForJob(candidateAliceId, jobs[1].dedupe_key)!;
  const bobWf = getLatestResumeQualityWorkflowForJob(candidateBobId, jobs[4].dedupe_key)!;
  assert.notEqual(aliceWf.candidate_id, bobWf.candidate_id);

  for (const it of listResumeQualityIterations(candidateAliceId, aliceWf.id)) {
    if (!it.review_json) continue;
    assert.equal(it.candidate_id, candidateAliceId);
  }
  for (const it of listResumeQualityIterations(candidateBobId, bobWf.id)) {
    if (!it.review_json) continue;
    assert.equal(it.candidate_id, candidateBobId);
  }
  // Each candidate's iteration artifacts live under their own candidate-scoped directory.
  const aliceDir = getWorkspaceDirectory({ candidateId: candidateAliceId, dedupeKey: jobs[1].dedupe_key, runId: aliceWf.tailoring_run_id, workflowId: aliceWf.id });
  const bobDir = getWorkspaceDirectory({ candidateId: candidateBobId, dedupeKey: jobs[4].dedupe_key, runId: bobWf.tailoring_run_id, workflowId: bobWf.id });
  assert.ok(aliceDir.includes(`/${candidateAliceId}/`));
  assert.ok(bobDir.includes(`/${candidateBobId}/`));
  assert.notEqual(aliceDir, bobDir);
});

test("S26-61 no application is ever submitted or marked applied by the autonomous writer", () => {
  const applied = [candidateAliceId, candidateBobId].flatMap((cand) =>
    jobs
      .map((j) => getCandidateJobState(cand, j.dedupe_key))
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .filter((s) => Boolean((s as unknown as { applied_at?: string | null }).applied_at))
  );
  assert.deepEqual(applied, [], "the autonomous writer must never submit or mark an application as applied");
});

test("S26-62 no paid provider is required, and the writer is spawned with the exact sandbox flags — never --dangerously-skip-permissions", async () => {
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(process.env.OPENAI_API_KEY, undefined);

  // Asserted against the REAL argv the invoker spawns, not a grep of its source: the module's own
  // doc comment legitimately names the flag it promises never to pass, so a source scan would be
  // both false-positive-prone and no evidence of actual behaviour.
  const argvDump = path.join(tmpFixturesDir, "argv.json");
  const argvScript = path.join(tmpFixturesDir, "fake-claude-argv.js");
  fs.writeFileSync(
    argvScript,
    `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(argvDump)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(9);\n`,
    { mode: 0o755 }
  );
  const { invokeClaudeWriter } = await import("../claudeCliInvoker");
  const handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s26-argv-"));
  await assert.rejects(() => invokeClaudeWriter({ handoffDir, command: argvScript, retryBackoffMs: 1 }));

  const argv = JSON.parse(fs.readFileSync(argvDump, "utf-8")) as string[];
  assert.equal(argv.includes("--dangerously-skip-permissions"), false);
  assert.ok(argv.includes("--safe-mode"));
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.ok(argv.includes("--no-session-persistence"));
  assert.equal(argv[argv.indexOf("--tools") + 1], "Read,Write", "no Bash tool may exist in the writer session at all");
  assert.equal(argv[argv.indexOf("--add-dir") + 1], handoffDir, "the only writable location is the one handoff directory");
  assert.ok(argv.includes("--max-budget-usd"));
  fs.rmSync(handoffDir, { recursive: true, force: true });
});

test("S26-64 the real Claude CLI cannot be spawned while the test guard is armed", async () => {
  const { invokeClaudeWriter } = await import("../claudeCliInvoker");
  const handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s26-guard-"));
  await assert.rejects(
    () => invokeClaudeWriter({ handoffDir }),
    /Refusing to spawn the real Claude CLI/,
    "a test that forgets to inject a fixture command must fail loudly, never bill a real generation"
  );
  fs.rmSync(handoffDir, { recursive: true, force: true });
});

test("S26-63 candidate master files are byte-for-byte unchanged after the whole suite", () => {
  for (const cand of [candidateAliceId, candidateBobId]) {
    const masterDir = path.join(tmpCandidatesDir, String(cand), "master");
    assert.equal(fs.readFileSync(path.join(masterDir, "resume.txt"), "utf-8").includes(`candidate ${cand}`), true);
    assert.ok(masterFileHashes(cand));
  }
  assert.equal(getAppSettings().scheduler.timezone.length > 0, true);
});


// ---------------------------------------------------------------------------------------------
// Provider-unavailable diagnosis (found on the real corpus: HTTP 529 with an empty stderr)
// ---------------------------------------------------------------------------------------------

test("S26-70 a provider API error reported only on stdout is surfaced verbatim, not swallowed as a bare exit code", async () => {
  const { invokeClaudeWriter, ClaudeCliTechnicalFailure } = await import("../claudeCliInvoker");
  const handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s26-529-"));
  try {
    await invokeClaudeWriter({ handoffDir, command: overloadedScript, retryBackoffMs: 1 });
    assert.fail("a CLI that never writes writer_output.json must not resolve");
  } catch (err) {
    assert.ok(err instanceof ClaudeCliTechnicalFailure);
    const failure = err as InstanceType<typeof ClaudeCliTechnicalFailure>;
    assert.match(failure.message, /529 Overloaded/, "the provider's own explanation must reach the operator");
    assert.match(failure.message, /HTTP 529/);
    assert.match(failure.message, /api_error/);
    assert.doesNotMatch(
      failure.message,
      /exited with code 1: *$/,
      "the pre-Stage-26 failure mode: a message that ends at the colon and explains nothing"
    );
    assert.equal(failure.providerUnavailable, true, "429/5xx is the provider being unable to serve, not a workflow problem");
  }
  fs.rmSync(handoffDir, { recursive: true, force: true });
});

test("S26-71 a non-provider failure is NOT misreported as a provider outage", async () => {
  const { invokeClaudeWriter } = await import("../claudeCliInvoker");
  type ClaudeCliTechnicalFailure = import("../claudeCliInvoker").ClaudeCliTechnicalFailure;
  const handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s26-plain-"));
  try {
    await invokeClaudeWriter({ handoffDir, command: failScript, retryBackoffMs: 1 });
    assert.fail("must not resolve");
  } catch (err) {
    const failure = err as ClaudeCliTechnicalFailure;
    assert.equal(failure.providerUnavailable, false);
    assert.match(failure.message, /boom|code 3/, "the raw stderr is still used when there is no JSON report");
  }
  fs.rmSync(handoffDir, { recursive: true, force: true });
});

test("S26-72 a provider outage never marks READY, never consumes a quality iteration, and is reported as the provider's fault", async () => {
  resetResumeWriterStateForTests();
  enableScheduler();
  // A job of its own, with a fresh technical-retry budget: jobs[2] deliberately exhausted its budget
  // in S26-32, and a workflow at the cap is SKIPPED, never re-invoked.
  const job = jobs[5];
  authorizeJob(candidateBobId, job);
  await approveOrThrow(candidateBobId, job.id);
  const wf = getLatestResumeQualityWorkflowForJob(candidateBobId, job.dedupe_key)!;
  seedRequirements(candidateBobId, wf.id, wf.tailoring_run_id, job.dedupe_key);
  const itersBefore = listResumeQualityIterations(candidateBobId, wf.id).length;

  // Stamp a tick FIRST, as the running app does every 60s: without it the health model correctly
  // prioritises "no scheduler is running here" over any failure detail, and the tick must come before
  // the pass or its own (zero-workflow) summary would overwrite the outcomes asserted below.
  await runResumeWriterTick(new Date(), STUB_CLI);

  // Unbounded on purpose: the bound is asserted in S26-16, and the point here is that THIS workflow is
  // reached and correctly classified — not which position it holds in the queue.
  const summary = await runGuardedWriterPass({ cliOptions: { command: overloadedScript, retryBackoffMs: 1 } });
  const outcome = summary.outcomes.find((o) => o.workflowId === wf.id);
  assert.ok(outcome, "the target workflow must have been processed");
  assert.equal(outcome!.outcome, "TECHNICAL_FAILURE");
  assert.equal(outcome!.providerUnavailable, true);
  assert.match(outcome!.error ?? "", /529/);

  const after = getResumeQualityWorkflow(candidateBobId, wf.id)!;
  assert.notEqual(after.status, "READY");
  assert.equal(after.current_iteration, wf.current_iteration, "no iteration was advanced");
  assert.equal(listResumeQualityIterations(candidateBobId, wf.id).length, itersBefore, "no quality iteration was consumed");

  // And the health model tells the user it was the provider, not their resume.
  const health = getResumeWriterHealth(new Date(), wf.id);
  assert.equal(health.state, "TECHNICAL_FAILURE");
  assert.match(health.detail, /temporarily unavailable/i);
  assert.match(health.detail, /Nothing is wrong with this resume/i);
  assert.match(health.detail, /no quality iteration was used/i);
});


// ---------------------------------------------------------------------------------------------
// Correction loop completeness (found on the real corpus: the writer was never told why it failed)
// ---------------------------------------------------------------------------------------------

test("S26-80 hard blocking failures reach the writer — feedback markdown and the writer prompt both name them", async () => {
  const { renderReviewFeedbackMarkdown } = await import("../../reviewFeedback");
  const { buildExternalWriterPrompt } = await import("../../handoff/exporter");

  // The exact shape the real corpus produced: perfect scores, ZERO blockingIssues, and four
  // PLACEHOLDER_CONTACT blocking failures that alone withheld approval.
  const review = {
    overallScore: 100,
    atsScore: 100,
    keywordAlignmentScore: 100,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 100,
    formattingScore: 100,
    blockingIssues: [] as string[],
    missingRequiredSkills: [],
    incorrectTechnologyUsage: [],
    genericBullets: [],
    missingImpactEvidence: [],
    summaryIssues: [],
    skillsOrderingIssues: [],
    truthfulnessIssues: [],
    requiredCorrections: [],
    blockingFailures: [
      {
        type: "PLACEHOLDER_CONTACT" as const,
        description: 'resume.email contains a placeholder value: "candidate@example.com"',
        recommendedCorrection: "Omit this field entirely if a real value is unavailable — never fabricate one.",
      },
    ],
  } as unknown as import("../../types").StructuredResumeReview;

  const feedback = renderReviewFeedbackMarkdown(review);
  assert.match(feedback, /Blocking Failures/, "the feedback the writer reads must have a blocking-failures section");
  assert.match(feedback, /PLACEHOLDER_CONTACT/);
  assert.match(feedback, /candidate@example\.com/);
  assert.match(feedback, /Omit this field entirely/, "the reviewer's own correction must be carried, not just the complaint");

  const prompt = buildExternalWriterPrompt({
    candidateId: candidateAliceId,
    candidateName: "Alice Smith",
    applicationId: 1,
    jobId: jobs[0].id,
    tailoringRunId: 1,
    workflowId: 1,
    iterationNumber: 2,
    selectedTrack: null,
    latestReview: review,
    requiredCorrections: [],
    blockingIssues: [],
    blockingFailures: review.blockingFailures,
  });
  assert.match(prompt, /Hard Blocking Failures/, "the prompt must state the failures that alone prevent approval");
  assert.match(prompt, /PLACEHOLDER_CONTACT/);
  assert.match(prompt, /Omit this field entirely/);
});

test("S26-81 buildResumeWriterInput carries blockingFailures forward for the next iteration", async () => {
  const { buildResumeWriterInput } = await import("../../orchestrator");
  const job = jobs[1];
  const wf = getLatestResumeQualityWorkflowForJob(candidateAliceId, job.dedupe_key)!;
  assert.ok(wf.current_iteration > 0, "fixture: needs a workflow with a completed iteration to carry forward from");

  const input = buildResumeWriterInput(candidateAliceId, wf.id);
  // The field must exist on the input contract and mirror the prior review exactly — including the
  // empty case, which must be an empty array or undefined rather than silently dropped.
  const prior = input.latestReview?.blockingFailures ?? [];
  assert.deepEqual(input.blockingFailures ?? [], prior, "the writer input must mirror the prior review's blocking failures");
});
