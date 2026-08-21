import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";
import type { StructuredResumeReview } from "../types";

/**
 * The legacy revalidation path, end to end, against a throwaway database.
 *
 * WHY THIS EXISTS. Every guard on this path was unit-tested, but the actual sequence — read the
 * artifact off disk, run the deterministic reviewer, persist a new iteration, let readiness re-read
 * it — had never executed once. The unit tests prove the rules; only this proves the plumbing.
 *
 * NOTHING REAL IS TOUCHED. The database path, the candidates directory and the generated-artifact
 * directory are all redirected to temp directories in `before`, and asserted to be temp paths
 * before anything runs. The live workflow is never opened.
 *
 * THE REVIEWER IS NOT MOCKED. The whole question is whether the real deterministic reviewer
 * produces the three typed analyses a legacy review lacks, so substituting a stub would test
 * nothing. No model is called — `reviewResumeDeterministically` is pure.
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;
let tmpGeneratedDir: string;

let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let setMarkedForTailoring: typeof import("@/db/queries/candidateJobState").setMarkedForTailoring;
let getCandidateJobState: typeof import("@/db/queries/candidateJobState").getCandidateJobState;
let startTailoringRun: typeof import("@/lib/tailoringExecution").startTailoringRun;
let createResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityWorkflow;
let createResumeQualityIteration: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityIteration;
let listResumeQualityIterations: typeof import("@/db/queries/resumeQualityWorkflows").listResumeQualityIterations;
let transitionWorkflowStatus: typeof import("@/db/queries/resumeQualityWorkflows").transitionWorkflowStatus;
let revalidateLatestReview: typeof import("../revalidation").revalidateLatestReview;
let isLegacyReviewMissingTypedSafetyAnalysis: typeof import("../legacyReview").isLegacyReviewMissingTypedSafetyAnalysis;
let evaluateApplicationReadiness: typeof import("../applicationReadiness").evaluateApplicationReadiness;
let evaluateQualityGate: typeof import("../qualityGate").evaluateQualityGate;
let getIterationDirectory: typeof import("../workspace").getIterationDirectory;
let insertJobMatchResult: typeof import("@/db/queries/jobMatches").insertJobMatchResult;

let hashCounter = 0;
const nextHash = () => `knowledge-hash-${++hashCounter}`;

/** The authorization a tailoring run requires. Same shape the orchestrator tests seed. */
function fakeResult(
  overrides: Partial<import("@/lib/match/types").JobMatchResult>
): import("@/lib/match/types").JobMatchResult {
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

let candidateId: number;
let companyId: number;

/** A resume with enough real structure for the deterministic checks to have something to read. */
function resumeFixture(): ResumeContent {
  return {
    name: "Alex Rivera",
    tagline: "Senior Data Engineer | Snowflake | Azure Data Platform",
    location: "Austin, TX",
    phone: "555-0100",
    email: "alex.rivera@example.com",
    summary: [
      "Data engineer building batch and streaming pipelines on Azure and Snowflake, with ownership of ingestion, modelling and delivery for analytics teams.",
    ],
    skillGroups: [
      { label: "Languages", items: ["Python", "SQL"] },
      { label: "Data Platforms", items: ["Snowflake", "Azure Data Factory"] },
    ],
    experience: [
      {
        title: "Data Engineer",
        company: "Comerica Bank",
        location: "Dallas, TX",
        dates: "Mar 2021 - Present",
        bullets: [
          "Built Snowflake ingestion pipelines processing daily transaction feeds for analytics consumers.",
          "Modelled curated layers in Snowflake so reporting teams queried governed tables rather than raw extracts.",
          "Automated Azure Data Factory orchestration for scheduled loads across upstream systems.",
        ],
      },
    ],
    education: ["B.S. Computer Science, University of Texas — 2019"],
  } as unknown as ResumeContent;
}

/** Exactly the persisted shape of a pre-typed-analysis review: scores present, analyses absent. */
function legacyReviewJson(): StructuredResumeReview {
  return {
    overallScore: 100,
    atsScore: 100,
    keywordAlignmentScore: 100,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 100,
    formattingScore: 100,
    missingRequiredSkills: [],
    incorrectTechnologyUsage: [],
    genericBullets: [],
    missingImpactEvidence: [],
    summaryIssues: [],
    skillsOrderingIssues: [],
    truthfulnessIssues: [],
    blockingIssues: [],
    requiredCorrections: [],
  } as StructuredResumeReview;
}

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-reval-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-reval-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-reval-gen-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  /* Belt and braces: if any of these ever resolved to the project's own data directory, this test
   * would be writing to real candidate records. Fail before that can happen. */
  assert.ok(process.env.CAREER_OPS_DB_PATH.startsWith(os.tmpdir()), "DB path must be a temp path");
  assert.ok(tmpGeneratedDir.startsWith(os.tmpdir()), "generated dir must be a temp path");

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
  ({ setMarkedForTailoring, getCandidateJobState } = await import("@/db/queries/candidateJobState"));
  ({ startTailoringRun } = await import("@/lib/tailoringExecution"));
  ({
    createResumeQualityWorkflow,
    createResumeQualityIteration,
    listResumeQualityIterations,
    transitionWorkflowStatus,
  } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ revalidateLatestReview } = await import("../revalidation"));
  ({ isLegacyReviewMissingTypedSafetyAnalysis } = await import("../legacyReview"));
  ({ evaluateApplicationReadiness } = await import("../applicationReadiness"));
  ({ evaluateQualityGate } = await import("../qualityGate"));
  ({ getIterationDirectory } = await import("../workspace"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  getDb();

  candidateId = createCandidate({ firstName: "Alex", lastName: "Rivera" }).id;
  companyId = createCompany({ name: "RevalTestCo", source_type: "greenhouse", ats_board_token: "revaltest" }).id;

  fs.mkdirSync(path.join(tmpCandidatesDir, String(candidateId)), { recursive: true });
  fs.writeFileSync(
    path.join(tmpCandidatesDir, String(candidateId), "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: "resume-hash", skills: "skills-hash" },
      builtAt: "2026-01-01T00:00:00Z",
      skills: [],
      experience: [
        {
          employer: "Comerica Bank",
          title: "Data Engineer",
          startDate: "2021-03",
          endDate: null,
          technologies: ["Snowflake", "Python", "SQL", "Azure Data Factory"],
        },
      ],
      education: [{ level: "Bachelor's", field: "Computer Science", institution: "University of Texas" }],
      certifications: [],
      totalYearsExperience: 5,
    })
  );

  const masterDir = path.join(tmpCandidatesDir, String(candidateId), "master");
  fs.mkdirSync(masterDir, { recursive: true });
  fs.writeFileSync(
    path.join(masterDir, "resume.txt"),
    "Alex Rivera\nComerica Bank\nData Engineer\n2021 - Present\nSnowflake, Python, SQL, Azure Data Factory"
  );
  fs.writeFileSync(
    path.join(masterDir, "skills.json"),
    JSON.stringify({ skills: ["Snowflake", "Python", "SQL", "Azure Data Factory"] })
  );
  /* The manifest's sha256 pair is what makes the profile "fresh" — a profile whose sourceHashes do
   * not match is treated as stale and refuses to authorize anything, by design. */
  fs.writeFileSync(
    path.join(masterDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.txt", sha256: "resume-hash" },
      skills: { filename: "skills.json", sha256: "skills-hash" },
    })
  );
});

after(() => {
  for (const dir of [tmpDbDir, tmpCandidatesDir, tmpGeneratedDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

/** Builds a workflow with one legacy iteration and the resume artifact on disk. */
function seedLegacyWorkflow(externalId: string, maxIterations = 3) {
  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, externalId);
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId,
      title: "Senior Data Engineer",
      location: "Austin, TX",
      department: "Eng",
      url: `https://boards.greenhouse.io/revaltest/${externalId}`,
      descriptionHtml: null,
      descriptionText: "Senior Data Engineer working with Snowflake, Python, SQL and Azure Data Factory.",
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
  const job = getJobByDedupeKey(dedupeKey)!;

  insertJobMatchResult(
    fakeResult({
      candidateId,
      jobId: job.id,
      dedupeKey,
      candidateProfileHash: "resume-hash:skills-hash",
      decision: "READY_FOR_TAILORING",
    })
  );

  /* The approval context the tailoring run requires — the same shape the existing orchestrator
   * tests use. Nothing about this test bypasses that authorization. */
  setMarkedForTailoring(candidateId, dedupeKey, true, {
    approvalType: "READY_DIRECT",
    decision: "READY_FOR_TAILORING",
  });
  const { run } = startTailoringRun({ candidateId, jobId: job.id });
  const appId = getCandidateJobState(candidateId, dedupeKey)!.id;

  const workflow = createResumeQualityWorkflow({
    candidateId,
    applicationId: appId,
    tailoringRunId: run.id,
    dedupeKey,
    maxIterations,
  });

  const legacy = legacyReviewJson();
  createResumeQualityIteration(candidateId, workflow.id, 1, {
    outputFiles: [],
    reviewJson: JSON.stringify(legacy),
    overallScore: legacy.overallScore,
    atsScore: legacy.atsScore,
    keywordAlignmentScore: legacy.keywordAlignmentScore,
    truthfulnessScore: legacy.truthfulnessScore,
    architectureConsistencyScore: legacy.architectureConsistencyScore,
    recruiterReadabilityScore: legacy.recruiterReadabilityScore,
    formattingScore: legacy.formattingScore,
    blockingIssueCount: 0,
  });

  const location = { candidateId, dedupeKey, runId: run.id, workflowId: workflow.id };
  const iterDir = getIterationDirectory(location, 1);
  fs.mkdirSync(iterDir, { recursive: true });
  fs.writeFileSync(path.join(iterDir, "resume_content.json"), JSON.stringify(resumeFixture(), null, 2));

  return { workflow, dedupeKey, location, legacy };
}

test("BEFORE: the seeded workflow reproduces the real legacy condition", () => {
  const { legacy } = seedLegacyWorkflow("legacy-precheck");
  assert.equal(isLegacyReviewMissingTypedSafetyAnalysis(legacy), true);
  const readiness = evaluateApplicationReadiness(legacy, 1, 3);
  assert.equal(readiness.humanMaySend, false);
  assert.notEqual(evaluateQualityGate(legacy, 1, 3), "READY");
});

test("the full path runs: artifact read, real reviewer, new iteration persisted", () => {
  const { workflow, legacy } = seedLegacyWorkflow("legacy-e2e");
  const before = listResumeQualityIterations(candidateId, workflow.id);
  assert.equal(before.length, 1);
  const beforeJson = before[0]!.review_json;

  const result = revalidateLatestReview(candidateId, workflow.id);
  assert.equal(result.ok, true, result.ok ? "" : `refused: ${result.refusal}`);
  if (!result.ok) return;

  const iterations = listResumeQualityIterations(candidateId, workflow.id);
  assert.equal(iterations.length, 2, "N -> N+1");
  assert.equal(result.iterationNumber, 2);

  /* Historical evidence is untouched, byte for byte. */
  assert.equal(iterations[0]!.review_json, beforeJson, "the legacy review must be unchanged");
  assert.deepEqual(JSON.parse(iterations[0]!.review_json!), legacy);

  /* The real reviewer produced all three analyses the legacy review lacked. */
  const fresh = JSON.parse(iterations[1]!.review_json!) as StructuredResumeReview;
  assert.notEqual(fresh.blockingFailures, undefined, "blockingFailures must now be present");
  assert.notEqual(fresh.instructionCompliance, undefined, "instructionCompliance must now be present");
  assert.notEqual(fresh.recruiterQualityAssessment, undefined, "recruiterQualityAssessment must now be present");

  /* The fresh review is no longer the legacy shape, so the recovery card stops being offered. */
  assert.equal(isLegacyReviewMissingTypedSafetyAnalysis(fresh), false);

  /* Readiness is decided by the normal function reading the NEW review — whatever it says. If it
   * still blocks, the reason is a real one rather than the missing-analysis message. */
  const readiness = evaluateApplicationReadiness(fresh, 2, workflow.max_iterations);
  if (!readiness.humanMaySend) {
    assert.ok(
      !readiness.blockingReasons.some((r) => r.includes("Typed blocking-failure analysis is missing")),
      "after a re-run the legacy reason must never be the reason"
    );
  }
  assert.equal(
    readiness.humanMaySend,
    evaluateApplicationReadiness(fresh, 2, workflow.max_iterations).humanMaySend,
    "readiness is deterministic and comes only from the review"
  );
});

test("a second re-run is refused: the fresh review is no longer legacy", () => {
  const { workflow } = seedLegacyWorkflow("legacy-once");
  assert.equal(revalidateLatestReview(candidateId, workflow.id).ok, true);

  const second = revalidateLatestReview(candidateId, workflow.id);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.refusal, "NOT_LEGACY");
  assert.equal(listResumeQualityIterations(candidateId, workflow.id).length, 2, "no third iteration");
});

test("budget exhausted: refused, no new iteration, history unchanged", () => {
  const { workflow } = seedLegacyWorkflow("legacy-budget", 1);
  const before = listResumeQualityIterations(candidateId, workflow.id);

  const result = revalidateLatestReview(candidateId, workflow.id);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.refusal, "BUDGET_EXHAUSTED");

  const afterRows = listResumeQualityIterations(candidateId, workflow.id);
  assert.equal(afterRows.length, before.length);
  assert.equal(afterRows[0]!.review_json, before[0]!.review_json);
});

test("in progress: refused server-side, no duplicate iteration", () => {
  const { workflow } = seedLegacyWorkflow("legacy-inflight");
  transitionWorkflowStatus(candidateId, workflow.id, "WRITER_RUNNING");

  const result = revalidateLatestReview(candidateId, workflow.id);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.refusal, "IN_PROGRESS");
  assert.equal(listResumeQualityIterations(candidateId, workflow.id).length, 1);
});

test("missing artifact: refused, no empty review written, history unchanged", () => {
  const { workflow, location } = seedLegacyWorkflow("legacy-noartifact");
  fs.rmSync(path.join(getIterationDirectory(location, 1), "resume_content.json"), { force: true });
  const before = listResumeQualityIterations(candidateId, workflow.id);

  const result = revalidateLatestReview(candidateId, workflow.id);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.refusal, "NO_RESUME_ARTIFACT");

  const afterRows = listResumeQualityIterations(candidateId, workflow.id);
  assert.equal(afterRows.length, before.length, "no iteration may be written without a resume");
  assert.equal(afterRows[0]!.review_json, before[0]!.review_json);
});

test("no application state is created by re-validating", async () => {
  const { workflow, dedupeKey } = seedLegacyWorkflow("legacy-noapp");
  const { getDb } = await import("@/db/index");
  const runsBefore = (
    getDb().prepare("SELECT COUNT(*) AS n FROM application_runs WHERE candidate_id = ?").get(candidateId) as {
      n: number;
    }
  ).n;

  revalidateLatestReview(candidateId, workflow.id);

  const runsAfter = (
    getDb().prepare("SELECT COUNT(*) AS n FROM application_runs WHERE candidate_id = ?").get(candidateId) as {
      n: number;
    }
  ).n;
  assert.equal(runsAfter, runsBefore, "re-validation must never create or touch an application");
  /* And the candidate's own job state is untouched — this changes no decision about the job. */
  assert.equal(getCandidateJobState(candidateId, dedupeKey)!.marked_for_tailoring, 1);
});
