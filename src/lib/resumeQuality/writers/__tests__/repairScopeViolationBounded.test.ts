import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { ResumeContent } from "../../../../../tools/tailoring-engine/types";

/**
 * Phase I (Autonomous Tailoring Quality & Resilience Upgrade) — REPAIR_SCOPE_VIOLATION must consume
 * the SAME bounded technical-failure budget every other writer failure class already uses, instead
 * of retrying unboundedly on every scheduler tick. See writerWorkerCore.ts's dedicated catch around
 * executeResumeImprovementIteration.
 *
 * Self-contained fixture (isolated temp DB/dirs, fixture "claude" scripts, never the real billed
 * CLI) — deliberately NOT appended to stage26AutonomousTailoring.test.ts's large shared sequential
 * fixture, to avoid disturbing its job-index-based shared state.
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
let getResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").getResumeQualityWorkflow;
let getLatestResumeQualityWorkflowForJob: typeof import("@/db/queries/resumeQualityWorkflows").getLatestResumeQualityWorkflowForJob;
let listResumeQualityIterations: typeof import("@/db/queries/resumeQualityWorkflows").listResumeQualityIterations;
let updateCandidateContact: typeof import("@/db/queries/candidateSettings").updateCandidateContact;
let processOneWorkflow: typeof import("../writerWorkerCore").processOneWorkflow;
let MAX_TECHNICAL_PASSES: number;

let workflowPost: typeof import("../../../../app/api/candidates/[candidateId]/jobs/[jobId]/quality-workflow/route").POST;

let candidateId: number;
let job: { id: number; dedupe_key: string };
let successScript: string;

function unit(overrides: Partial<RequirementUnit>): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: [],
    categories: [],
    label: "requirement",
    requirementLevel: "Required",
    criticality: "REQUIRED",
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

function baseResume(): ResumeContent {
  return {
    name: "Sam Rivera",
    tagline: "Senior Data Engineer",
    location: "Remote, US",
    phone: "312-987-6543",
    email: "sam.rivera@gmail.com",
    summary: ["Senior Data Engineer with 5+ years building Azure Data Factory and Databricks pipelines for enterprise analytics platforms."],
    skillGroups: [{ label: "Cloud & Data Platform", items: ["Azure", "Azure Data Factory", "Databricks", "Python", "SQL"] }],
    experience: [
      {
        title: "Senior Data Engineer",
        company: "Acme Corp",
        dates: "2020 - Present",
        // Deliberately flawed: "Azure Data Factory and AWS Glue" performing one responsibility with
        // no migration framing — the exact class of finding that produced a real repair plan this
        // session's live certification run.
        bullets: ["Built batch data ingestion pipelines using Azure Data Factory and AWS Glue."],
      },
    ],
    education: ["B.S. Computer Science, State University"],
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
        technologies: ["Azure", "Azure Data Factory", "AWS Glue", "Databricks", "Python", "SQL"],
      },
    ],
    education: [{ level: "Bachelor's", field: "Computer Science", institution: "State University" }],
    certifications: [],
    totalYearsExperience: 5,
  };
}

async function approveOrThrow(candId: number, jobId: number) {
  const req = new NextRequest(`http://localhost/api/candidates/${candId}/jobs/${jobId}/quality-workflow`, { method: "POST" });
  const res = await workflowPost(req, { params: Promise.resolve({ candidateId: String(candId), jobId: String(jobId) }) });
  assert.equal(res.status, 200, `fixture: approval failed (${await res.text()})`);
}

function scriptReturning(resume: ResumeContent): string {
  const p = path.join(tmpFixturesDir, `fake-claude-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(
    p,
    `#!/usr/bin/env node
const fs = require('fs');
const input = JSON.parse(fs.readFileSync('writer_input.json', 'utf-8'));
fs.writeFileSync('writer_output.json', JSON.stringify({
  schemaVersion: 1,
  candidateId: input.candidateId,
  applicationId: input.applicationId,
  jobId: input.jobId,
  tailoringRunId: input.tailoringRunId,
  workflowId: input.workflowId,
  iterationNumber: input.targetIterationNumber,
  resume: ${JSON.stringify(resume)},
}, null, 2));
process.exit(0);
`,
    { mode: 0o755 }
  );
  return p;
}

before(async () => {
  process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI = "1";

  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-repairbound-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-repairbound-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-repairbound-gen-"));
  tmpFixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-repairbound-fix-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {
      /* ignore */
    }
    global.__careerOpsDb = undefined;
  }

  const { getDb } = await import("@/db/index");
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ setMarkedForTailoring } = await import("@/db/queries/candidateJobState"));
  ({ getResumeQualityWorkflow, getLatestResumeQualityWorkflowForJob, listResumeQualityIterations } = await import(
    "@/db/queries/resumeQualityWorkflows"
  ));
  ({ updateCandidateContact } = await import("@/db/queries/candidateSettings"));
  ({ POST: workflowPost } = await import("../../../../app/api/candidates/[candidateId]/jobs/[jobId]/quality-workflow/route"));
  ({ processOneWorkflow } = await import("../writerWorkerCore"));
  ({ MAX_TECHNICAL_PASSES } = await import("../handoffClaim"));

  getDb();

  candidateId = createCandidate({ firstName: "Sam", lastName: "Rivera" }).id;
  const masterDir = path.join(tmpCandidatesDir, String(candidateId), "master");
  fs.mkdirSync(masterDir, { recursive: true });
  fs.writeFileSync(path.join(masterDir, "resume.txt"), "Resume for Sam Rivera\nAcme Corp\nSenior Data Engineer\n2020 - Present");
  fs.writeFileSync(path.join(masterDir, "skills.json"), JSON.stringify({ skills: ["Azure", "AWS Glue"] }));
  fs.writeFileSync(
    path.join(masterDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: "r-sam" },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: "s-sam" },
    })
  );
  fs.writeFileSync(
    path.join(tmpCandidatesDir, String(candidateId), "candidate-profile.json"),
    JSON.stringify({ ...masterProfile(), sourceHashes: { resume: "r-sam", skills: "s-sam" } })
  );
  updateCandidateContact(candidateId, { email: "sam.rivera@gmail.com", phone: "(312) 987-6543", location: "Remote, US", linkedin: null });

  const companyId = createCompany({ name: "RepairBound Test Co", source_type: "greenhouse", ats_board_token: "repairbound" }).id;
  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, "repairbound-job-1");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "repairbound-job-1",
      title: "Senior Data Engineer",
      location: "Remote",
      department: "Data",
      url: "https://boards.greenhouse.io/repairbound/repairbound-job-1",
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
  job = { id: j.id, dedupe_key: j.dedupe_key };

  insertJobMatchResult({
    candidateId,
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    matchEngineVersion: 2,
    matchKnowledgeHash: "k-repairbound",
    candidateProfileHash: "p-repairbound",
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

  successScript = scriptReturning(baseResume());
});

after(() => {
  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {
      /* ignore */
    }
    global.__careerOpsDb = undefined;
  }
  for (const d of [tmpDbDir, tmpCandidatesDir, tmpGeneratedDir, tmpFixturesDir]) {
    if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("Phase I: a repair-scope violation is a bounded technical failure, not an unbounded loop", async () => {
  await approveOrThrow(candidateId, job.id);
  const wf = getResumeQualityWorkflow(candidateId, getLatestResumeQualityWorkflowForJob(candidateId, job.dedupe_key)!.id)!;

  // Seed real, deterministic job requirements so the review is stable (the route already writes
  // these; STRONG_REQUIREMENTS keeps them fixed for this fixture regardless of route defaults).
  const { getWorkspaceDirectory } = await import("../../workspace");
  const wsDir = getWorkspaceDirectory({ candidateId, dedupeKey: job.dedupe_key, runId: wf.tailoring_run_id, workflowId: wf.id });
  fs.writeFileSync(path.join(wsDir, "extracted_job_requirements.json"), JSON.stringify(STRONG_REQUIREMENTS, null, 2));

  // Iteration 1: the flawed baseline resume, reviewed and (expected) not READY — this creates a real
  // repair plan with real editable paths, exactly as the live pipeline does.
  const iter1 = await processOneWorkflow(wf, { cliOptions: { command: successScript, retryBackoffMs: 1 } });
  assert.equal(iter1.outcome, "IMPROVEMENT_RUNNING", `fixture: expected a real repair plan from the flawed baseline, got ${iter1.outcome}`);
  assert.equal(listResumeQualityIterations(candidateId, wf.id).length, 1);

  // Iteration 2: a "collateral damage" writer output — touches the tagline, which no repair
  // operation authorized, exactly test 41's pattern in orchestratorLoop.test.ts but exercised at the
  // WORKER level (processOneWorkflow), where the Phase I bounded-retry fix actually lives.
  const collateral = baseResume();
  collateral.tagline = "A completely unrelated replacement tagline no repair operation authorized";
  const violatingScript = scriptReturning(collateral);

  const afterFirstViolation = await processOneWorkflow(getResumeQualityWorkflow(candidateId, wf.id)!, {
    cliOptions: { command: violatingScript, retryBackoffMs: 1 },
  });
  assert.equal(afterFirstViolation.outcome, "TECHNICAL_FAILURE");
  assert.equal(afterFirstViolation.failureClass, "REPAIR_SCOPE_VIOLATION");
  // Still only 1 accepted iteration — the rejected output was never persisted as iteration 2.
  assert.equal(listResumeQualityIterations(candidateId, wf.id).length, 1, "a rejected repair must never consume a quality iteration");
  assert.equal(getResumeQualityWorkflow(candidateId, wf.id)!.current_iteration, 1);

  // Exhaust the bounded technical budget with the same violating output.
  let last: string = afterFirstViolation.outcome;
  for (let i = 1; i < MAX_TECHNICAL_PASSES + 2; i++) {
    const result = await processOneWorkflow(getResumeQualityWorkflow(candidateId, wf.id)!, {
      cliOptions: { command: violatingScript, retryBackoffMs: 1 },
    });
    last = result.outcome;
  }
  assert.equal(last, "BLOCKED_MAX_ATTEMPTS", "repeated repair-scope violations must stop auto-retrying at the bounded cap instead of looping forever");

  // The last VALID accepted attempt (iteration 1's real content) is untouched.
  assert.equal(listResumeQualityIterations(candidateId, wf.id).length, 1);
  assert.notEqual(getResumeQualityWorkflow(candidateId, wf.id)!.status, "READY");

  // A genuinely correct repair (respecting the plan's editable paths) still works after the operator
  // resets the technical bookkeeping — proving this is a bounded pause, not a permanent poison state.
  const { resetWriterTechnicalFailures } = await import("../writerWorkerCore");
  const reset = resetWriterTechnicalFailures(candidateId, wf.id);
  assert.equal(reset.ok, true, reset.message);
  const recovered = await processOneWorkflow(getResumeQualityWorkflow(candidateId, wf.id)!, {
    cliOptions: { command: successScript, retryBackoffMs: 1 },
  });
  assert.notEqual(recovered.outcome, "BLOCKED_MAX_ATTEMPTS");
});

test("Phase I: an ordinary technical failure (not a scope violation) is unaffected by this change", async () => {
  const failScript = path.join(tmpFixturesDir, "fake-claude-fails.js");
  fs.writeFileSync(failScript, `#!/usr/bin/env node\nprocess.stderr.write('boom');\nprocess.exit(3);\n`, { mode: 0o755 });

  const secondCompanyId = (await import("@/db/queries/companies")).createCompany({
    name: "RepairBound Test Co 2",
    source_type: "greenhouse",
    ats_board_token: "repairbound2",
  }).id;
  const dedupeKey = dedupeKeyForAts("greenhouse", secondCompanyId, "repairbound-job-2");
  upsertJob({
    companyId: secondCompanyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "repairbound-job-2",
      title: "Senior Data Engineer",
      location: "Remote",
      department: "Data",
      url: "https://boards.greenhouse.io/repairbound/repairbound-job-2",
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
  const j2 = getJobByDedupeKey(dedupeKey)!;
  insertJobMatchResult({
    candidateId,
    jobId: j2.id,
    dedupeKey: j2.dedupe_key,
    matchEngineVersion: 2,
    matchKnowledgeHash: "k-repairbound-2",
    candidateProfileHash: "p-repairbound-2",
    candidateSettingsHash: "settings-hash",
    jdContentHash: "jd-hash-2",
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
  setMarkedForTailoring(candidateId, j2.dedupe_key, true, { approvalType: "READY_DIRECT", decision: "READY_FOR_TAILORING" });
  await approveOrThrow(candidateId, j2.id);
  const wf2 = getResumeQualityWorkflow(candidateId, getLatestResumeQualityWorkflowForJob(candidateId, j2.dedupe_key)!.id)!;

  const result = await processOneWorkflow(wf2, { cliOptions: { command: failScript, retryBackoffMs: 1 } });
  assert.equal(result.outcome, "TECHNICAL_FAILURE");
  assert.notEqual(result.failureClass, "REPAIR_SCOPE_VIOLATION");
});
