import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ComplianceStatus, InstructionComplianceChecks, StructuredResumeReview } from "../types";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES } from "../types";

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
let getIterationDirectory: typeof import("../workspace").getIterationDirectory;
let getHumanReviewDirectory: typeof import("../workspace").getHumanReviewDirectory;
let getFinalDirectory: typeof import("../workspace").getFinalDirectory;
let generateHumanReviewPackage: typeof import("../humanReviewPackage").generateHumanReviewPackage;

let candidateId: number;
let candidateBId: number;
let companyId: number;
let jobOne: { id: number; dedupe_key: string };

function allChecks(status: ComplianceStatus): InstructionComplianceChecks {
  const checks = {} as InstructionComplianceChecks;
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) checks[name] = status;
  return checks;
}

function review(overrides: Partial<StructuredResumeReview> & { checks?: Partial<InstructionComplianceChecks> }): StructuredResumeReview {
  const { checks, ...rest } = overrides;
  return {
    overallScore: 90,
    atsScore: 90,
    keywordAlignmentScore: 90,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 90,
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
    instructionCompliance: {
      instructionVersion: "test-version",
      instructionHash: "test-hash",
      checks: { ...allChecks("PASS"), ...checks },
      notes: [],
    },
    ...rest,
  };
}

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-hrp-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-hrp-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-hrp-gen-"));
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
  ({ createResumeQualityWorkflow, createResumeQualityIteration } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ getIterationDirectory, getHumanReviewDirectory, getFinalDirectory } = await import("../workspace"));
  ({ generateHumanReviewPackage } = await import("../humanReviewPackage"));
  getDb();

  candidateId = createCandidate({ firstName: "Priya", lastName: "Nair" }).id;
  candidateBId = createCandidate({ firstName: "Other", lastName: "Candidate" }).id;
  companyId = createCompany({ name: "HumanReviewTestCo", source_type: "greenhouse", ats_board_token: "hrtest" }).id;

  function seedProfile(candId: number) {
    const masterDir = path.join(tmpCandidatesDir, String(candId), "master");
    fs.mkdirSync(masterDir, { recursive: true });
    fs.writeFileSync(path.join(masterDir, "resume.txt"), `Resume for candidate ${candId}`);
    fs.writeFileSync(path.join(masterDir, "skills.json"), JSON.stringify({ skills: ["Azure"] }));
    fs.writeFileSync(
      path.join(masterDir, "manifest.json"),
      JSON.stringify({
        resume: { filename: "resume.docx", uploadedAt: new Date().toISOString(), sizeBytes: 1, sha256: `r-${candId}` },
        skills: { filename: "skills.docx", uploadedAt: new Date().toISOString(), sizeBytes: 1, sha256: `s-${candId}` },
      })
    );
    fs.writeFileSync(
      path.join(tmpCandidatesDir, String(candId), "candidate-profile.json"),
      JSON.stringify({
        schemaVersion: 1,
        sourceHashes: { resume: `r-${candId}`, skills: `s-${candId}` },
        builtAt: new Date().toISOString(),
        skills: [],
        experience: [{ employer: "Acme Corp", title: "Data Engineer", startDate: "2020-01", endDate: null, technologies: ["Azure"] }],
        education: [],
        certifications: [],
        totalYearsExperience: 5,
      })
    );
  }
  seedProfile(candidateId);
  seedProfile(candidateBId);

  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, "hrp-job-1");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "hrp-job-1",
      title: "Senior Data Engineer",
      location: "Remote",
      department: "Eng",
      url: "https://boards.greenhouse.io/hrtest/hrp-job-1",
      descriptionHtml: null,
      descriptionText: "Human review package test job",
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
});

let hashCounter = 0;
function nextHash(): string {
  hashCounter += 1;
  return `hrp-hash-${hashCounter}`;
}

async function authorizeJob(candId: number, j: { id: number; dedupe_key: string }) {
  insertJobMatchResult({
    candidateId: candId,
    jobId: j.id,
    dedupeKey: j.dedupe_key,
    matchEngineVersion: 2,
    matchKnowledgeHash: nextHash(),
    candidateProfileHash: `p-${candId}-${j.id}`,
    candidateSettingsHash: "s",
    jdContentHash: "jd",
    computedAt: new Date().toISOString(),
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
  setMarkedForTailoring(candId, j.dedupe_key, true, { approvalType: "READY_DIRECT", decision: "READY_FOR_TAILORING" });
  const { run } = startTailoringRun({ candidateId: candId, jobId: j.id });
  const applicationId = getCandidateJobState(candId, j.dedupe_key)!.id;
  return { runId: run.id, applicationId };
}

/** Directly seeds an iteration's on-disk directory + immutable DB row — bypasses the real
 *  writer/reviewer so the review shape is fully controlled, matching this test file's own review()
 *  builder rather than depending on the deterministic reviewer's emergent scoring. */
function seedIteration(
  candId: number,
  workflowId: number,
  location: { candidateId: number; dedupeKey: string; runId: number; workflowId: number },
  iterationNumber: number,
  rev: StructuredResumeReview,
  opts: { withCoverLetter?: boolean } = {}
) {
  const dir = getIterationDirectory(location, iterationNumber);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Resume.docx"), `fake docx bytes for iteration ${iterationNumber}`);
  if (opts.withCoverLetter !== false) {
    fs.writeFileSync(path.join(dir, "CoverLetter.docx"), `fake cover letter bytes for iteration ${iterationNumber}`);
  }
  fs.writeFileSync(path.join(dir, "resume_content.json"), JSON.stringify({ name: "Priya Nair", iteration: iterationNumber }));
  fs.writeFileSync(path.join(dir, "review_feedback.md"), `# Feedback for iteration ${iterationNumber}\n`);
  createResumeQualityIteration(candId, workflowId, iterationNumber, {
    outputFiles: ["Resume.docx", "CoverLetter.docx", "resume_content.json", "review.json", "review_feedback.md"],
    overallScore: rev.overallScore,
    atsScore: rev.atsScore,
    keywordAlignmentScore: rev.keywordAlignmentScore,
    truthfulnessScore: rev.truthfulnessScore,
    architectureConsistencyScore: rev.architectureConsistencyScore,
    recruiterReadabilityScore: rev.recruiterReadabilityScore,
    formattingScore: rev.formattingScore,
    blockingIssueCount: rev.blockingIssues.length,
    reviewJson: JSON.stringify(rev),
  });
}

test("1. package generated with the SAME winner bestAttemptSelection would choose (single selection authority)", async () => {
  const { runId, applicationId } = await authorizeJob(candidateId, jobOne);
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: jobOne.dedupe_key });
  const location = { candidateId, dedupeKey: jobOne.dedupe_key, runId, workflowId: wf.id };

  const iter1 = review({ overallScore: 74, atsScore: 25, checks: { deepRewrite: "FAIL" } });
  const iter2 = review({
    overallScore: 100,
    atsScore: 100,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    checks: { crossDocumentConsistency: "FAIL", finalValidation: "FAIL" },
  });
  const iter3 = review({
    overallScore: 40,
    atsScore: 100,
    truthfulnessScore: 100,
    architectureConsistencyScore: 50,
    blockingIssues: ["competing warehouses in one bullet"],
    checks: { architectureIntegrity: "FAIL", technologyAdaptation: "FAIL", migrationIntegrity: "FAIL", noContradictingTechnologies: "FAIL", finalValidation: "FAIL" },
  });

  seedIteration(candidateId, wf.id, location, 1, iter1);
  seedIteration(candidateId, wf.id, location, 2, iter2);
  seedIteration(candidateId, wf.id, location, 3, iter3);

  const { selectBestResumeQualityAttempt } = await import("../bestAttemptSelection");
  const expected = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: iter1 },
    { iterationNumber: 2, review: iter2 },
    { iterationNumber: 3, review: iter3 },
  ]);

  const pkg = generateHumanReviewPackage(candidateId, wf.id);
  assert(pkg);
  assert.equal(pkg!.iterationNumber, expected!.iterationNumber, "package must select the exact same winner bestAttemptSelection computes");
  assert.equal(pkg!.iterationNumber, 2, "matches the Ostium-shaped regression case");
});

test("2. resume, cover letter, and review all correspond to the SAME selected iteration", async () => {
  const { runId, applicationId } = await authorizeJob(candidateId, jobOne);
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: jobOne.dedupe_key });
  const location = { candidateId, dedupeKey: jobOne.dedupe_key, runId, workflowId: wf.id };

  seedIteration(candidateId, wf.id, location, 1, review({ overallScore: 50, checks: { bulletWriting: "FAIL" } }));
  seedIteration(candidateId, wf.id, location, 2, review({ overallScore: 95 })); // clean winner

  const pkg = generateHumanReviewPackage(candidateId, wf.id);
  assert.equal(pkg?.iterationNumber, 2);

  const humanReviewDir = getHumanReviewDirectory(location);
  const resumeContent = fs.readFileSync(path.join(humanReviewDir, "resume_content.json"), "utf-8");
  const resumeDocx = fs.readFileSync(path.join(humanReviewDir, "Priya_Resume_HumanReview.docx"), "utf-8");
  const coverDocx = fs.readFileSync(path.join(humanReviewDir, "Priya_CoverLetter_HumanReview.docx"), "utf-8");
  const careerOpsReview = JSON.parse(fs.readFileSync(path.join(humanReviewDir, "careerops_review.json"), "utf-8"));

  assert(resumeContent.includes('"iteration":2'), "resume_content.json must come from iteration 2");
  assert(resumeDocx.includes("iteration 2"), "Resume.docx must come from iteration 2");
  assert(coverDocx.includes("iteration 2"), "CoverLetter.docx must come from iteration 2");
  assert.equal(careerOpsReview.overallScore, 95, "careerops_review.json must be iteration 2's own review, not iteration 1's");
});

test("3. best_attempt.json is always approved: false, and it is not caller-controlled", async () => {
  const { runId, applicationId } = await authorizeJob(candidateId, jobOne);
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: jobOne.dedupe_key });
  const location = { candidateId, dedupeKey: jobOne.dedupe_key, runId, workflowId: wf.id };
  seedIteration(candidateId, wf.id, location, 1, review({}));

  generateHumanReviewPackage(candidateId, wf.id);

  const bestAttempt = JSON.parse(fs.readFileSync(path.join(getHumanReviewDirectory(location), "best_attempt.json"), "utf-8"));
  assert.equal(bestAttempt.approved, false);
  assert.equal(bestAttempt.qualityGateDecision, "NEEDS_HUMAN_REVIEW");
  assert.equal(typeof bestAttempt.iterationNumber, "number");
  assert.equal(typeof bestAttempt.selectionReason, "string");
  assert(Array.isArray(bestAttempt.hardGateFailures));
  assert(Array.isArray(bestAttempt.blockingIssues));

  // generateHumanReviewPackage's public signature takes only (candidateId, workflowId) — there is no
  // parameter through which a caller could pass approved:true; this is a structural guarantee, not
  // just a runtime assertion. (See src/lib/resumeQuality/humanReviewPackage.ts's exported signature.)
});

test("4. nothing is ever written into the READY final/ directory by this module", async () => {
  const { runId, applicationId } = await authorizeJob(candidateId, jobOne);
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: jobOne.dedupe_key });
  const location = { candidateId, dedupeKey: jobOne.dedupe_key, runId, workflowId: wf.id };
  seedIteration(candidateId, wf.id, location, 1, review({}));

  generateHumanReviewPackage(candidateId, wf.id);

  assert.equal(fs.existsSync(getFinalDirectory(location)), false, "human-review generation must never create the final/ directory");
});

test("5. candidate isolation: candidate B's package generation never touches candidate A's directory", async () => {
  const jobForB = getJobByDedupeKey(jobOne.dedupe_key)!;
  const { runId: runIdA, applicationId: appA } = await authorizeJob(candidateId, jobOne);
  const wfA = createResumeQualityWorkflow({ candidateId, applicationId: appA, tailoringRunId: runIdA, dedupeKey: jobOne.dedupe_key });
  const locationA = { candidateId, dedupeKey: jobOne.dedupe_key, runId: runIdA, workflowId: wfA.id };
  seedIteration(candidateId, wfA.id, locationA, 1, review({}));

  const { runId: runIdB, applicationId: appB } = await authorizeJob(candidateBId, { id: jobForB.id, dedupe_key: jobForB.dedupe_key });
  const wfB = createResumeQualityWorkflow({ candidateId: candidateBId, applicationId: appB, tailoringRunId: runIdB, dedupeKey: jobOne.dedupe_key });
  const locationB = { candidateId: candidateBId, dedupeKey: jobOne.dedupe_key, runId: runIdB, workflowId: wfB.id };
  seedIteration(candidateBId, wfB.id, locationB, 1, review({}));

  const pkgA = generateHumanReviewPackage(candidateId, wfA.id);
  const pkgB = generateHumanReviewPackage(candidateBId, wfB.id);

  assert(pkgA && pkgB);
  assert.notEqual(pkgA!.directory, pkgB!.directory, "each candidate must get its own isolated human-review directory");
  assert(pkgA!.directory.includes(`/candidates/${candidateId}/`));
  assert(pkgB!.directory.includes(`/candidates/${candidateBId}/`));
});

test("6. no orphaned .tmp directory remains after a successful generation (atomic rename)", async () => {
  const { runId, applicationId } = await authorizeJob(candidateId, jobOne);
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: jobOne.dedupe_key });
  const location = { candidateId, dedupeKey: jobOne.dedupe_key, runId, workflowId: wf.id };
  seedIteration(candidateId, wf.id, location, 1, review({}));

  const pkg = generateHumanReviewPackage(candidateId, wf.id);
  assert(pkg);

  const qualityDir = path.dirname(getHumanReviewDirectory(location));
  const entries = fs.readdirSync(qualityDir);
  const tmpEntries = entries.filter((e) => e.includes(".tmp-"));
  assert.equal(tmpEntries.length, 0, "no .tmp sibling directory should remain after a successful run");
  assert(entries.includes("human-review"));
});

test("7. re-running generation for the same workflow overwrites cleanly (no duplicate/partial artifacts)", async () => {
  const { runId, applicationId } = await authorizeJob(candidateId, jobOne);
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: jobOne.dedupe_key });
  const location = { candidateId, dedupeKey: jobOne.dedupe_key, runId, workflowId: wf.id };
  seedIteration(candidateId, wf.id, location, 1, review({ overallScore: 60 }));

  const first = generateHumanReviewPackage(candidateId, wf.id);
  const second = generateHumanReviewPackage(candidateId, wf.id);

  assert(first && second);
  assert.equal(first!.iterationNumber, second!.iterationNumber);
  const files = fs.readdirSync(getHumanReviewDirectory(location));
  assert.equal(new Set(files).size, files.length, "no duplicate filenames after re-running generation");
});

test("8. returns null (writes nothing) for a workflow with zero iterations", async () => {
  const { runId, applicationId } = await authorizeJob(candidateId, jobOne);
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: jobOne.dedupe_key });
  const location = { candidateId, dedupeKey: jobOne.dedupe_key, runId, workflowId: wf.id };

  const pkg = generateHumanReviewPackage(candidateId, wf.id);
  assert.equal(pkg, null);
  assert.equal(fs.existsSync(getHumanReviewDirectory(location)), false);
});

test("9. missing cover letter for an iteration is omitted, not an error", async () => {
  const { runId, applicationId } = await authorizeJob(candidateId, jobOne);
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: jobOne.dedupe_key });
  const location = { candidateId, dedupeKey: jobOne.dedupe_key, runId, workflowId: wf.id };
  seedIteration(candidateId, wf.id, location, 1, review({}), { withCoverLetter: false });

  assert.doesNotThrow(() => {
    const pkg = generateHumanReviewPackage(candidateId, wf.id);
    assert(pkg);
    assert.equal(fs.existsSync(path.join(getHumanReviewDirectory(location), "Priya_CoverLetter_HumanReview.docx")), false);
    assert.equal(fs.existsSync(path.join(getHumanReviewDirectory(location), "Priya_Resume_HumanReview.docx")), true);
  });
});

test("10. instruction_snapshot.md and workflow_status.json are present and reflect FAILED/HUMAN_REVIEW", async () => {
  const { runId, applicationId } = await authorizeJob(candidateId, jobOne);
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: jobOne.dedupe_key });
  const location = { candidateId, dedupeKey: jobOne.dedupe_key, runId, workflowId: wf.id };
  seedIteration(candidateId, wf.id, location, 1, review({}));

  generateHumanReviewPackage(candidateId, wf.id);
  const dir = getHumanReviewDirectory(location);

  const snapshot = fs.readFileSync(path.join(dir, "instruction_snapshot.md"), "utf-8");
  assert(snapshot.includes("Canonical Instruction Snapshot"));

  const status = JSON.parse(fs.readFileSync(path.join(dir, "workflow_status.json"), "utf-8"));
  assert.equal(status.workflowStatus, "FAILED");
  assert.equal(status.waitingFor, "HUMAN_REVIEW");
});
