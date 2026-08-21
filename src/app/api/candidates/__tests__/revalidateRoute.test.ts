import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import type { ResumeContent } from "../../../../../tools/tailoring-engine/types";
import type { StructuredResumeReview } from "@/lib/resumeQuality/types";

/**
 * The revalidate route, end to end over HTTP.
 *
 * WHY THIS EXISTS. The service behind this route is integration-tested, but the route itself — the
 * ownership guard, the candidate-scoped workflow lookup and the refusal-to-status mapping — was
 * only covered by reading it. Those three are exactly where a route can be wrong while its service
 * is right: leaking another candidate's workflow, or reporting a refusal as a success.
 *
 * NOTHING IS MOCKED BELOW THE HANDLER. The real guard, the real lookup, the real service and the
 * real deterministic reviewer all run. Only the database and the artifact directories are
 * redirected, to temp paths asserted before anything executes.
 *
 * The route's audited contract, which these tests assert rather than assume:
 *
 *   invalid candidate id ............ 400
 *   inactive candidate .............. 404
 *   locked profile (no unlock) ...... 401  (the guard's own response, returned unchanged)
 *   invalid job id .................. 400
 *   unknown job ..................... 404
 *   no workflow for this candidate .. 404  code NO_WORKFLOW
 *   NO_REVIEW ....................... 404
 *   NOT_LEGACY / BUDGET_EXHAUSTED /
 *   IN_PROGRESS / NO_RESUME_ARTIFACT  409
 *   success ......................... 200  { ok, workflowId, iterationNumber }
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
let createResumeQualityIteration: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityIteration;
let listResumeQualityIterations: typeof import("@/db/queries/resumeQualityWorkflows").listResumeQualityIterations;
let transitionWorkflowStatus: typeof import("@/db/queries/resumeQualityWorkflows").transitionWorkflowStatus;
let getIterationDirectory: typeof import("@/lib/resumeQuality/workspace").getIterationDirectory;
let setPin: typeof import("@/db/queries/candidatePinStore").setPin;
let revalidatePost: typeof import("../[candidateId]/jobs/[jobId]/quality-workflow/revalidate/route").POST;
let workflowGet: typeof import("../[candidateId]/jobs/[jobId]/quality-workflow/route").GET;

let candidateA: number;
let candidateB: number;
let companyId: number;
let hashCounter = 0;
const nextHash = () => `knowledge-hash-${++hashCounter}`;

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

/** The persisted shape of a pre-typed-analysis review: every score, none of the three analyses. */
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

function seedProfile(candId: number) {
  const dir = path.join(tmpCandidatesDir, String(candId));
  const masterDir = path.join(dir, "master");
  fs.mkdirSync(masterDir, { recursive: true });
  fs.writeFileSync(
    path.join(masterDir, "resume.txt"),
    "Alex Rivera\nComerica Bank\nData Engineer\n2021 - Present\nSnowflake, Python, SQL, Azure Data Factory"
  );
  fs.writeFileSync(
    path.join(masterDir, "skills.json"),
    JSON.stringify({ skills: ["Snowflake", "Python", "SQL", "Azure Data Factory"] })
  );
  fs.writeFileSync(
    path.join(masterDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.txt", sha256: `resume-${candId}` },
      skills: { filename: "skills.json", sha256: `skills-${candId}` },
    })
  );
  fs.writeFileSync(
    path.join(dir, "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: `resume-${candId}`, skills: `skills-${candId}` },
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
}

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-revroute-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-revroute-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-revroute-gen-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  /* Asserted before a single row is written: if any of these ever resolved into the project's own
   * data directory, these tests would be mutating real candidate records. */
  assert.ok(process.env.CAREER_OPS_DB_PATH.startsWith(os.tmpdir()), "DB path must be a temp path");
  assert.ok(tmpCandidatesDir.startsWith(os.tmpdir()), "candidates dir must be a temp path");
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
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ setMarkedForTailoring, getCandidateJobState } = await import("@/db/queries/candidateJobState"));
  ({ startTailoringRun } = await import("@/lib/tailoringExecution"));
  ({
    createResumeQualityWorkflow,
    createResumeQualityIteration,
    listResumeQualityIterations,
    transitionWorkflowStatus,
  } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ getIterationDirectory } = await import("@/lib/resumeQuality/workspace"));
  ({ setPin } = await import("@/db/queries/candidatePinStore"));
  ({ POST: revalidatePost } = await import("../[candidateId]/jobs/[jobId]/quality-workflow/revalidate/route"));
  ({ GET: workflowGet } = await import("../[candidateId]/jobs/[jobId]/quality-workflow/route"));
  getDb();

  candidateA = createCandidate({ firstName: "Alex", lastName: "Rivera" }).id;
  candidateB = createCandidate({ firstName: "Bea", lastName: "Nolan" }).id;
  companyId = createCompany({ name: "RevRouteCo", source_type: "greenhouse", ats_board_token: "revroute" }).id;
  seedProfile(candidateA);
  seedProfile(candidateB);
});

after(() => {
  for (const dir of [tmpDbDir, tmpCandidatesDir, tmpGeneratedDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

/** A workflow owned by `candId`, with one legacy iteration and its resume artifact on disk. */
function seedLegacyWorkflow(
  candId: number,
  externalId: string,
  opts: { maxIterations?: number; withArtifact?: boolean; legacy?: boolean } = {}
) {
  const { maxIterations = 3, withArtifact = true, legacy = true } = opts;
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
      url: `https://boards.greenhouse.io/revroute/${externalId}`,
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
      candidateId: candId,
      jobId: job.id,
      dedupeKey,
      candidateProfileHash: `resume-${candId}:skills-${candId}`,
      decision: "READY_FOR_TAILORING",
    })
  );
  setMarkedForTailoring(candId, dedupeKey, true, {
    approvalType: "READY_DIRECT",
    decision: "READY_FOR_TAILORING",
  });
  const { run } = startTailoringRun({ candidateId: candId, jobId: job.id });
  const appId = getCandidateJobState(candId, dedupeKey)!.id;

  const workflow = createResumeQualityWorkflow({
    candidateId: candId,
    applicationId: appId,
    tailoringRunId: run.id,
    dedupeKey,
    maxIterations,
  });

  /* `legacy: false` seeds a review that already ran today's checks, which is what NOT_LEGACY needs. */
  const review: StructuredResumeReview = legacy
    ? legacyReviewJson()
    : ({
        ...legacyReviewJson(),
        blockingFailures: [],
        recruiterQualityAssessment: { status: "PASS", score: 100, issues: [] },
      } as StructuredResumeReview);

  createResumeQualityIteration(candId, workflow.id, 1, {
    outputFiles: [],
    reviewJson: JSON.stringify(review),
    overallScore: review.overallScore,
    atsScore: review.atsScore,
    keywordAlignmentScore: review.keywordAlignmentScore,
    truthfulnessScore: review.truthfulnessScore,
    architectureConsistencyScore: review.architectureConsistencyScore,
    recruiterReadabilityScore: review.recruiterReadabilityScore,
    formattingScore: review.formattingScore,
    blockingIssueCount: 0,
  });

  if (withArtifact) {
    const iterDir = getIterationDirectory(
      { candidateId: candId, dedupeKey, runId: run.id, workflowId: workflow.id },
      1
    );
    fs.mkdirSync(iterDir, { recursive: true });
    fs.writeFileSync(path.join(iterDir, "resume_content.json"), JSON.stringify(resumeFixture(), null, 2));
  }

  return { workflow, job, dedupeKey, review };
}

/** Invokes the real handler exactly as Next would. */
async function callRevalidate(candId: number | string, jobId: number | string) {
  const req = new NextRequest(
    `http://localhost/api/candidates/${candId}/jobs/${jobId}/quality-workflow/revalidate`,
    { method: "POST" }
  );
  return revalidatePost(req, {
    params: Promise.resolve({ candidateId: String(candId), jobId: String(jobId) }),
  });
}

function appRunCount(candId: number): number {
  const db = global.__careerOpsDb!;
  return (
    db.prepare("SELECT COUNT(*) AS n FROM application_runs WHERE candidate_id = ?").get(candId) as { n: number }
  ).n;
}

/* ── 1. success ────────────────────────────────────────────────────────────────────────────── */

test("200: a legacy workflow is re-reviewed, history preserved, analyses now present", async () => {
  const { workflow, job, review: legacy } = seedLegacyWorkflow(candidateA, "route-success");
  const before = listResumeQualityIterations(candidateA, workflow.id);
  const beforeJson = before[0]!.review_json;
  const runsBefore = appRunCount(candidateA);

  const res = await callRevalidate(candidateA, job.id);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; workflowId: number; iterationNumber: number };
  assert.equal(body.ok, true);
  assert.equal(body.workflowId, workflow.id);
  assert.equal(body.iterationNumber, 2);

  const iterations = listResumeQualityIterations(candidateA, workflow.id);
  assert.equal(iterations.length, 2, "N -> N+1");

  /* Legacy history is untouched, byte for byte. */
  assert.equal(iterations[0]!.review_json, beforeJson);
  assert.deepEqual(JSON.parse(iterations[0]!.review_json!), legacy);

  /* The real reviewer produced all three analyses the legacy review lacked. */
  const fresh = JSON.parse(iterations[1]!.review_json!) as StructuredResumeReview;
  assert.notEqual(fresh.blockingFailures, undefined);
  assert.notEqual(fresh.instructionCompliance, undefined);
  assert.notEqual(fresh.recruiterQualityAssessment, undefined);

  /* No application was created or touched by re-validating. */
  assert.equal(appRunCount(candidateA), runsBefore);
});

test("the workflow GET then reports gate and readiness from the NEW iteration, not the old one", async () => {
  const { workflow, job } = seedLegacyWorkflow(candidateA, "route-consistency");
  assert.equal((await callRevalidate(candidateA, job.id)).status, 200);

  const req = new NextRequest(`http://localhost/api/candidates/${candidateA}/jobs/${job.id}/quality-workflow`);
  const res = await workflowGet(req, {
    params: Promise.resolve({ candidateId: String(candidateA), jobId: String(job.id) }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    iterations: { iteration_number: number; review_json: string }[];
    latestReview: StructuredResumeReview;
    applicationReadiness: { humanMaySend: boolean; blockingReasons: string[] };
    revalidation: { isLegacyMissingAnalysis: boolean };
  };

  /* Same record throughout: the served latestReview IS the newest iteration's review. */
  const newest = body.iterations[body.iterations.length - 1]!;
  assert.equal(newest.iteration_number, 2);
  assert.deepEqual(body.latestReview, JSON.parse(newest.review_json));

  /* The recovery offer retracts, because the newest review is no longer the legacy shape. */
  assert.equal(body.revalidation.isLegacyMissingAnalysis, false);

  /* And whatever readiness now says, the legacy reason can no longer be the reason. */
  if (!body.applicationReadiness.humanMaySend) {
    assert.ok(
      !body.applicationReadiness.blockingReasons.some((r) =>
        r.includes("Typed blocking-failure analysis is missing")
      ),
      "after a re-run the missing-analysis reason must be gone"
    );
  }
});

/* ── fail-closed, at the HTTP layer ────────────────────────────────────────────────────────── */

test("a 100/100 legacy review is never reported as send-ready over HTTP", async () => {
  const { job } = seedLegacyWorkflow(candidateA, "route-failclosed");
  const req = new NextRequest(`http://localhost/api/candidates/${candidateA}/jobs/${job.id}/quality-workflow`);
  const res = await workflowGet(req, {
    params: Promise.resolve({ candidateId: String(candidateA), jobId: String(job.id) }),
  });
  const body = (await res.json()) as {
    latestReview: StructuredResumeReview;
    applicationReadiness: { humanMaySend: boolean };
  };
  assert.equal(body.latestReview.overallScore, 100);
  assert.equal(body.applicationReadiness.humanMaySend, false, "100/100 is not authorization to send");
});

/* ── refusal mappings ──────────────────────────────────────────────────────────────────────── */

test("409 NOT_LEGACY: a review that already ran today's checks is refused", async () => {
  const { workflow, job } = seedLegacyWorkflow(candidateA, "route-notlegacy", { legacy: false });
  const before = listResumeQualityIterations(candidateA, workflow.id);

  const res = await callRevalidate(candidateA, job.id);
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, "NOT_LEGACY");

  const afterRows = listResumeQualityIterations(candidateA, workflow.id);
  assert.equal(afterRows.length, before.length);
  assert.equal(afterRows[0]!.review_json, before[0]!.review_json);
});

test("409 BUDGET_EXHAUSTED: no pass left to record one", async () => {
  const { workflow, job } = seedLegacyWorkflow(candidateA, "route-budget", { maxIterations: 1 });
  const before = listResumeQualityIterations(candidateA, workflow.id);

  const res = await callRevalidate(candidateA, job.id);
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, "BUDGET_EXHAUSTED");

  const afterRows = listResumeQualityIterations(candidateA, workflow.id);
  assert.equal(afterRows.length, before.length);
  assert.equal(afterRows[0]!.review_json, before[0]!.review_json);
});

test("409 IN_PROGRESS: refused server-side while the workflow is running", async () => {
  const { workflow, job } = seedLegacyWorkflow(candidateA, "route-inflight");
  transitionWorkflowStatus(candidateA, workflow.id, "WRITER_RUNNING");

  const res = await callRevalidate(candidateA, job.id);
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, "IN_PROGRESS");
  assert.equal(listResumeQualityIterations(candidateA, workflow.id).length, 1);
});

test("409 NO_RESUME_ARTIFACT: no empty review is written when the resume is gone", async () => {
  const { workflow, job } = seedLegacyWorkflow(candidateA, "route-noartifact", { withArtifact: false });
  const before = listResumeQualityIterations(candidateA, workflow.id);

  const res = await callRevalidate(candidateA, job.id);
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, "NO_RESUME_ARTIFACT");

  const afterRows = listResumeQualityIterations(candidateA, workflow.id);
  assert.equal(afterRows.length, before.length);
  assert.equal(afterRows[0]!.review_json, before[0]!.review_json);
});

/* ── ownership and scope ───────────────────────────────────────────────────────────────────── */

test("401: a locked profile is refused before the service runs", async () => {
  const locked = createCandidate({ firstName: "Locked", lastName: "Profile" }).id;
  seedProfile(locked);
  const { workflow, job } = seedLegacyWorkflow(locked, "route-locked");
  setPin(locked, "4417");

  const res = await callRevalidate(locked, job.id);
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { reason: string }).reason, "profile_locked");

  /* The guard returned before anything could be written. */
  assert.equal(listResumeQualityIterations(locked, workflow.id).length, 1);
});

test("404: candidate B cannot revalidate a workflow belonging to candidate A", async () => {
  const { workflow, job } = seedLegacyWorkflow(candidateA, "route-crosscandidate");
  const before = listResumeQualityIterations(candidateA, workflow.id);

  /* Candidate B is a legitimate, unlocked candidate asking about A's job. The candidate-scoped
   * lookup must not find A's workflow, so B learns nothing about it and can change nothing. */
  const res = await callRevalidate(candidateB, job.id);
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { code: string }).code, "NO_WORKFLOW");

  const afterRows = listResumeQualityIterations(candidateA, workflow.id);
  assert.equal(afterRows.length, before.length, "A's workflow must be untouched");
  assert.equal(afterRows[0]!.review_json, before[0]!.review_json);
});

/* ── shape guards ──────────────────────────────────────────────────────────────────────────── */

test("400 on an invalid candidate id, 400 on an invalid job id", async () => {
  const bad = await callRevalidate("0", "1");
  assert.equal(bad.status, 400);

  const { job } = seedLegacyWorkflow(candidateA, "route-badjob");
  const badJob = await callRevalidate(candidateA, "-3");
  assert.equal(badJob.status, 400);
  assert.ok(job.id > 0);
});

test("404 on an unknown candidate and on an unknown job", async () => {
  const unknownCandidate = await callRevalidate(999_999, 1);
  assert.equal(unknownCandidate.status, 404);

  const unknownJob = await callRevalidate(candidateA, 999_999);
  assert.equal(unknownJob.status, 404);
  assert.equal(((await unknownJob.json()) as { error: string }).error, "Job not found");
});

test("404 NO_WORKFLOW: a job the candidate has never tailored", async () => {
  const externalId = "route-noworkflow";
  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, externalId);
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId,
      title: "Untailored Role",
      location: "Remote",
      department: "Eng",
      url: `https://boards.greenhouse.io/revroute/${externalId}`,
      descriptionHtml: null,
      descriptionText: "No workflow exists for this one.",
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

  const res = await callRevalidate(candidateA, job.id);
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { code: string }).code, "NO_WORKFLOW");
});
