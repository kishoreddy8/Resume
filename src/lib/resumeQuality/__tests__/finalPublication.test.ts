import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";
import type { WorkflowStatus } from "../types";

/**
 * Phase 9A — final tailored artifact publication.
 *
 * Two layers are covered here:
 *  1. finalPublication.ts on its own — slugging, candidate-derived filenames, path containment,
 *     manifest contents, atomic replacement, and the READY-only gate.
 *  2. The orchestrator's READY branch actually invoking it, with the published DOCX bytes proven
 *     identical to the approved artifact in final/ (which is exactly what the artifacts API serves).
 *
 * Everything is written under a throwaway CAREER_OPS_GENERATED_DIR — no test here touches the real
 * data/generated tree, and no test authorizes tailoring or submits an application.
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;
let tmpGeneratedDir: string;
/** Stands in for a workflow's own quality/<id>/final/ directory in the unit-level tests. */
let sourceDir: string;

let getPublishedApplicationsRoot: typeof import("../finalPublication").getPublishedApplicationsRoot;
let publishFinalApplicationArtifacts: typeof import("../finalPublication").publishFinalApplicationArtifacts;
let resolvePublishedApplicationTarget: typeof import("../finalPublication").resolvePublishedApplicationTarget;
let publishedCompanySlug: typeof import("../finalPublication").publishedCompanySlug;
let publishedJobSlug: typeof import("../finalPublication").publishedJobSlug;
let toPathSlug: typeof import("../finalPublication").toPathSlug;
let FinalPublicationError: typeof import("../finalPublication").FinalPublicationError;

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
let executeResumeQualityIteration: typeof import("../orchestrator").executeResumeQualityIteration;

let candidateId: number;
let companyId: number;
let job: { id: number; dedupe_key: string };
let runId: number;
let applicationId: number;
let masterDir: string;

// --- Unit-level fixtures -----------------------------------------------------------------------

const RESUME_BYTES = Buffer.from("PK-approved-resume-docx-bytes");
const COVER_BYTES = Buffer.from("PK-approved-cover-letter-docx-bytes");
const FEEDBACK_TEXT = "# Review Feedback\n\nWorkflow 41, iteration 2. Approved.\n";
/** A second, distinctly-bodied approved resume, so a collision test can prove two job folders hold
 *  genuinely different documents rather than merely different paths. */
const OTHER_RESUME_BYTES = Buffer.from("PK-approved-resume-for-a-different-job");

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: 1,
    candidateFirstName: "Sai Kishore",
    candidateDisplayName: "Sai Kishore Onteru",
    companyId: 11,
    companyName: "Celigo, Inc.",
    jobId: 7362,
    jobTitle: "Senior Data Engineer",
    dedupeKey: "greenhouse:11:job-7362",
    applicationId: 21,
    tailoringRunId: 31,
    workflowId: 41,
    workflowStatus: "READY" as WorkflowStatus,
    iterationNumber: 2,
    qualityGateOutcome: "READY",
    overallScore: 93,
    sourceFinalDirectory: sourceDir,
    sourceResumePath: path.join(sourceDir, "SaiKishore_Resume.docx"),
    sourceCoverLetterPath: path.join(sourceDir, "SaiKishore_CoverLetter.docx"),
    sourceReviewFeedbackPath: path.join(sourceDir, "resume_review_feedback.md"),
    publishedAt: "2026-05-01T12:00:00.000Z",
    ...overrides,
  };
}

/** Everything currently published, so a test can prove nothing outside its own job folder moved. */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(root)) return out;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full).toString("base64");
    }
  };
  walk(root);
  return out;
}

// --- Integration fixtures (mirrors finalArtifactProvenance.test.ts's harness) --------------------

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

const PERFECT_RESUME: ResumeContent = {
  name: "Sai Kishore Onteru",
  tagline: "Senior Data Engineer",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "saikishore@gmail.com",
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

const COVER_LETTER: CoverLetterContent = {
  name: "Sai Kishore Onteru",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "saikishore@gmail.com",
  salutation: "Dear Hiring Team,",
  paragraphs: ["I am excited to apply for the Senior Data Engineer position."],
  closing: "Sincerely,\nSai Kishore Onteru",
};

function masterProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "r", skills: "s" },
    builtAt: "2020-01-01T00:00:00Z",
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

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-publication-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-publication-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-publication-generated-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {}
    global.__careerOpsDb = undefined;
  }

  ({
    getPublishedApplicationsRoot,
    publishFinalApplicationArtifacts,
    resolvePublishedApplicationTarget,
    publishedCompanySlug,
    publishedJobSlug,
    toPathSlug,
    FinalPublicationError,
  } = await import("../finalPublication"));

  // A stand-in for one workflow's approved final/ directory, nested under the generated root exactly
  // as the real one is, so manifest provenance paths are exercised in their relative form.
  sourceDir = path.join(tmpGeneratedDir, "candidates", "1", "jobs", "abcdef0123456789", "runs", "31", "quality", "41", "final");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "SaiKishore_Resume.docx"), RESUME_BYTES);
  fs.writeFileSync(path.join(sourceDir, "SaiKishore_CoverLetter.docx"), COVER_BYTES);
  fs.writeFileSync(path.join(sourceDir, "other_Resume.docx"), OTHER_RESUME_BYTES);
  fs.writeFileSync(path.join(sourceDir, "resume_review_feedback.md"), FEEDBACK_TEXT, "utf-8");

  const { getDb } = await import("@/db/index");
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ setMarkedForTailoring, getCandidateJobState } = await import("@/db/queries/candidateJobState"));
  ({ startTailoringRun } = await import("@/lib/tailoringExecution"));
  ({ createResumeQualityWorkflow } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ executeResumeQualityIteration } = await import("../orchestrator"));
  getDb();

  // First name is deliberately two words — the derived, filesystem-safe prefix must become
  // "SaiKishore" without the module ever hardcoding that string.
  candidateId = createCandidate({ firstName: "Sai Kishore", lastName: "Onteru" }).id;
  companyId = createCompany({ name: "Celigo, Inc.", source_type: "greenhouse", ats_board_token: "celigo" }).id;

  masterDir = path.join(tmpCandidatesDir, String(candidateId), "master");
  fs.mkdirSync(masterDir, { recursive: true });
  fs.writeFileSync(
    path.join(masterDir, "resume.txt"),
    "Resume for Sai Kishore Onteru\nAcme Corp\nSenior Data Engineer\n2020 - Present"
  );
  fs.writeFileSync(path.join(masterDir, "skills.json"), JSON.stringify({ skills: ["Azure", "Python"] }));

  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, "job-celigo-7362");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "job-celigo-7362",
      title: "Senior Data Engineer",
      location: "Remote",
      department: "Eng",
      url: "https://boards.greenhouse.io/celigo/job-celigo-7362",
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
  job = getJobByDedupeKey(dedupeKey)!;

  const resumeHash = `resume-${candidateId}-${job.id}`;
  const skillsHash = `skills-${candidateId}-${job.id}`;
  fs.writeFileSync(
    path.join(tmpCandidatesDir, String(candidateId), "candidate-profile.json"),
    JSON.stringify(masterProfile({ sourceHashes: { resume: resumeHash, skills: skillsHash } }))
  );
  fs.writeFileSync(
    path.join(masterDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: resumeHash },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: skillsHash },
    })
  );

  insertJobMatchResult({
    candidateId,
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    matchEngineVersion: 2,
    matchKnowledgeHash: "publication-hash-1",
    candidateProfileHash: `${resumeHash}:${skillsHash}`,
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
  const { run } = startTailoringRun({ candidateId, jobId: job.id });
  runId = run.id;
  applicationId = getCandidateJobState(candidateId, job.dedupe_key)!.id;
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

// --- 1. Normal company/job publication ----------------------------------------------------------

test("publishes an approved workflow into applications/<company-slug>/<position-slug>-<jobId>/", () => {
  const published = publishFinalApplicationArtifacts(baseInput());

  assert.equal(published.root, path.join(tmpGeneratedDir, "applications"));
  assert.equal(published.companySlug, "celigo-inc");
  assert.equal(published.jobSlug, "senior-data-engineer-7362");
  assert.equal(
    published.directory,
    path.join(tmpGeneratedDir, "applications", "celigo-inc", "senior-data-engineer-7362")
  );

  assert.deepEqual(fs.readdirSync(published.directory).sort(), [
    "SaiKishore_CoverLetter.docx",
    "SaiKishore_Resume.docx",
    "manifest.json",
    "resume_review_feedback.md",
  ]);

  // Published bytes are the approved bytes, copied verbatim — nothing is regenerated.
  assert.deepEqual(fs.readFileSync(published.resumePath), RESUME_BYTES);
  assert.deepEqual(fs.readFileSync(published.coverLetterPath!), COVER_BYTES);
});

// --- 2. Candidate-derived naming ----------------------------------------------------------------

test("filenames are derived from the candidate's own name, never a hardcoded one", () => {
  const other = publishFinalApplicationArtifacts(
    baseInput({
      candidateId: 2,
      candidateFirstName: "Ana María",
      candidateDisplayName: "Ana María Álvarez",
      jobId: 8801,
      jobTitle: "Staff Platform Engineer",
    })
  );

  assert.equal(path.basename(other.resumePath), "AnaMara_Resume.docx");
  assert.equal(path.basename(other.coverLetterPath!), "AnaMara_CoverLetter.docx");
  assert.ok(fs.existsSync(other.resumePath));

  // Two different candidates publishing into the same job folder keep distinct filenames, and the
  // manifest records which candidate each publication belongs to.
  const jobFolder = { jobId: 9100, jobTitle: "Data Engineer II" };
  const first = publishFinalApplicationArtifacts(baseInput({ ...jobFolder, candidateId: 1, candidateFirstName: "Sai Kishore" }));
  const second = publishFinalApplicationArtifacts(baseInput({ ...jobFolder, candidateId: 2, candidateFirstName: "Ana" }));
  assert.equal(first.directory, second.directory);
  assert.notEqual(path.basename(first.resumePath), path.basename(second.resumePath));
  assert.equal(path.basename(second.resumePath), "Ana_Resume.docx");
  assert.equal(second.manifest.candidateId, 2);

  // No candidate name is baked into the module itself.
  const moduleSource = fs.readFileSync(
    path.join(process.cwd(), "src", "lib", "resumeQuality", "finalPublication.ts"),
    "utf-8"
  );
  assert.ok(!/saikishore/i.test(moduleSource), "finalPublication.ts must not hardcode a candidate name");
});

// --- 3. Slug safety -----------------------------------------------------------------------------

test("slugging normalizes punctuation, whitespace, unicode, and control characters", () => {
  assert.equal(toPathSlug("Celigo, Inc."), "celigo-inc");
  assert.equal(toPathSlug("  JPMorganChase  "), "jpmorganchase");
  assert.equal(toPathSlug("Lead Software Engineer - Data Engineering"), "lead-software-engineer-data-engineering");
  assert.equal(toPathSlug("Nestlé"), "nestle");
  assert.equal(toPathSlug("Bad\u0000Name\u0007Here"), "bad-name-here");
  assert.equal(toPathSlug("a/b\\c"), "a-b-c");
  assert.equal(toPathSlug("..."), "");
  assert.equal(toPathSlug(null), "");
  assert.equal(toPathSlug("x".repeat(200)).length, 80);

  // Benign punctuation is normalized rather than rejected.
  assert.equal(publishedCompanySlug("AT&T Inc.", 5), "at-t-inc");
  assert.equal(publishedJobSlug("Sr. Engineer (Remote)", 12), "sr-engineer-remote-12");

  // An unusable company name falls back to the company's own id, never a shared generic word, so two
  // such companies can never share a directory.
  assert.equal(publishedCompanySlug("***", 5), "company-5");
  assert.equal(publishedCompanySlug("", 6), "company-6");
  assert.notEqual(publishedCompanySlug("***", 5), publishedCompanySlug("***", 6));
});

// --- 4. Empty-title fallback --------------------------------------------------------------------

test("an empty or unusable job title falls back to position-<jobId>, not a generic company default", () => {
  assert.equal(publishedJobSlug("", 7362), "position-7362");
  assert.equal(publishedJobSlug("   ", 7362), "position-7362");
  assert.equal(publishedJobSlug(null, 7362), "position-7362");
  assert.equal(publishedJobSlug("!!!", 7362), "position-7362");

  const published = publishFinalApplicationArtifacts(baseInput({ jobId: 5150, jobTitle: "" }));
  assert.equal(published.jobSlug, "position-5150");
  assert.equal(published.manifest.jobTitle, "");
  assert.ok(fs.existsSync(path.join(published.directory, "manifest.json")));
});

// --- 5. Same-company multi-job collision protection ---------------------------------------------

test("two jobs at the same company never overwrite one another", () => {
  const lead = publishFinalApplicationArtifacts(
    baseInput({
      companyId: 90,
      companyName: "JPMorganChase",
      jobId: 33038,
      jobTitle: "Lead Software Engineer - Data Engineering",
    })
  );
  const swe = publishFinalApplicationArtifacts(
    baseInput({
      companyId: 90,
      companyName: "JPMorganChase",
      jobId: 33030,
      jobTitle: "Software Engineer III - Big Data",
      sourceResumePath: path.join(sourceDir, "other_Resume.docx"),
    })
  );

  assert.equal(path.dirname(lead.directory), path.dirname(swe.directory));
  assert.equal(path.basename(lead.directory), "lead-software-engineer-data-engineering-33038");
  assert.equal(path.basename(swe.directory), "software-engineer-iii-big-data-33030");
  assert.notEqual(lead.directory, swe.directory);
  assert.ok(fs.existsSync(lead.resumePath));
  assert.ok(fs.existsSync(swe.resumePath));
  assert.deepEqual(fs.readFileSync(lead.resumePath), RESUME_BYTES);
  assert.deepEqual(fs.readFileSync(swe.resumePath), OTHER_RESUME_BYTES);

  // Even two identical titles stay isolated, because the job id suffix is unconditional.
  const a = publishedJobSlug("Data Engineer", 1);
  const b = publishedJobSlug("Data Engineer", 2);
  assert.notEqual(a, b);
});

// --- 6. Path containment ------------------------------------------------------------------------

test("traversal attempts in a company name or job title cannot escape the applications root", () => {
  const root = path.resolve(getPublishedApplicationsRoot());

  const hostile = resolvePublishedApplicationTarget({
    companyId: 77,
    companyName: "../../../../etc",
    jobId: 4242,
    jobTitle: "../../root/.ssh/authorized_keys",
  });
  assert.ok(hostile.directory.startsWith(root + path.sep));
  assert.ok(!hostile.companySlug.includes("/"));
  assert.ok(!hostile.companySlug.includes(".."));
  assert.ok(!hostile.jobSlug.includes(".."));
  assert.equal(hostile.companySlug, "etc");
  assert.equal(hostile.jobSlug, "root-ssh-authorized-keys-4242");

  const published = publishFinalApplicationArtifacts(
    baseInput({ companyId: 77, companyName: "../../../../etc", jobId: 4242, jobTitle: "../../etc/passwd" })
  );
  assert.ok(path.resolve(published.resumePath).startsWith(root + path.sep));
  assert.ok(!fs.existsSync(path.join(tmpGeneratedDir, "etc")));

  // Invalid identifiers are refused outright rather than silently coerced into a path segment.
  assert.throws(
    () => resolvePublishedApplicationTarget({ companyId: 0, companyName: "X", jobId: 1, jobTitle: "T" }),
    (e: unknown) => e instanceof FinalPublicationError && e.code === "INVALID_IDENTIFIER"
  );
  assert.throws(
    () => resolvePublishedApplicationTarget({ companyId: 1, companyName: "X", jobId: -3, jobTitle: "T" }),
    (e: unknown) => e instanceof FinalPublicationError && e.code === "INVALID_IDENTIFIER"
  );
});

// --- 7. Manifest correctness --------------------------------------------------------------------

test("manifest.json records the exact candidate/job/workflow that produced the files", () => {
  const published = publishFinalApplicationArtifacts(baseInput({ jobId: 6100, jobTitle: "Analytics Engineer" }));
  const manifest = JSON.parse(fs.readFileSync(published.manifestPath, "utf-8"));

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.publishedAt, "2026-05-01T12:00:00.000Z");
  assert.equal(manifest.candidateId, 1);
  assert.equal(manifest.candidateName, "Sai Kishore Onteru");
  assert.equal(manifest.candidateFilePrefix, "SaiKishore");
  assert.equal(manifest.companyId, 11);
  assert.equal(manifest.companyName, "Celigo, Inc.");
  assert.equal(manifest.companySlug, "celigo-inc");
  assert.equal(manifest.jobId, 6100);
  assert.equal(manifest.jobTitle, "Analytics Engineer");
  assert.equal(manifest.jobSlug, "analytics-engineer-6100");
  assert.equal(manifest.dedupeKey, "greenhouse:11:job-7362");
  assert.equal(manifest.applicationId, 21);
  assert.equal(manifest.tailoringRunId, 31);
  assert.equal(manifest.workflowId, 41);
  assert.equal(manifest.iterationId, 2);
  assert.equal(manifest.workflowStatus, "READY");
  assert.equal(manifest.qualityGateOutcome, "READY");
  assert.equal(manifest.overallScore, 93);
  assert.deepEqual(manifest.files, {
    resume: "SaiKishore_Resume.docx",
    coverLetter: "SaiKishore_CoverLetter.docx",
    reviewFeedback: "resume_review_feedback.md",
    manifest: "manifest.json",
  });

  // Checksums let a later audit prove the published copy still matches what was approved.
  assert.equal(manifest.checksums.resume, crypto.createHash("sha256").update(RESUME_BYTES).digest("hex"));
  assert.equal(manifest.checksums.coverLetter, crypto.createHash("sha256").update(COVER_BYTES).digest("hex"));

  // Provenance is stored relative to the generated root, so the manifest stays portable.
  assert.ok(!path.isAbsolute(manifest.source.finalDirectory));
  assert.equal(
    manifest.source.finalDirectory,
    path.join("candidates", "1", "jobs", "abcdef0123456789", "runs", "31", "quality", "41", "final")
  );
  assert.equal(manifest.source.resume, path.join(manifest.source.finalDirectory, "SaiKishore_Resume.docx"));

  // No secret, no JD text, no candidate evidence is copied into the manifest.
  const raw = fs.readFileSync(published.manifestPath, "utf-8").toLowerCase();
  for (const forbidden of ["apikey", "api_key", "token", "secret", "password"]) {
    assert.ok(!raw.includes(forbidden), `manifest must not contain ${forbidden}`);
  }
});

// --- 8. Review-feedback correctness -------------------------------------------------------------

test("review feedback published alongside the documents is the finalized workflow's own", () => {
  const published = publishFinalApplicationArtifacts(baseInput({ jobId: 6200, jobTitle: "Data Platform Engineer" }));
  assert.equal(fs.readFileSync(published.reviewFeedbackPath!, "utf-8"), FEEDBACK_TEXT);
  assert.ok(fs.readFileSync(published.reviewFeedbackPath!, "utf-8").includes("Workflow 41, iteration 2"));

  // A workflow with no feedback publishes without the file and says so in the manifest, rather than
  // reaching for some other run's feedback.
  const noFeedback = publishFinalApplicationArtifacts(
    baseInput({ jobId: 6201, jobTitle: "Data Platform Engineer", sourceReviewFeedbackPath: undefined })
  );
  assert.equal(noFeedback.reviewFeedbackPath, null);
  assert.equal(noFeedback.manifest.files.reviewFeedback, null);
  assert.ok(!fs.existsSync(path.join(noFeedback.directory, "resume_review_feedback.md")));
});

// --- 9. Atomic / no partial publication ---------------------------------------------------------

test("a missing source document publishes nothing at all and leaves no staging residue", () => {
  const before = snapshotTree(getPublishedApplicationsRoot());

  assert.throws(
    () => publishFinalApplicationArtifacts(baseInput({ jobId: 7001, jobTitle: "Ghost Role", sourceResumePath: path.join(sourceDir, "nope.docx") })),
    (e: unknown) => e instanceof FinalPublicationError && e.code === "MISSING_RESUME"
  );
  assert.throws(
    () =>
      publishFinalApplicationArtifacts(
        baseInput({ jobId: 7002, jobTitle: "Ghost Role", sourceCoverLetterPath: path.join(sourceDir, "nope.docx") })
      ),
    (e: unknown) => e instanceof FinalPublicationError && e.code === "MISSING_COVER_LETTER"
  );
  assert.throws(
    () =>
      publishFinalApplicationArtifacts(
        baseInput({ jobId: 7003, jobTitle: "Ghost Role", sourceReviewFeedbackPath: path.join(sourceDir, "nope.md") })
      ),
    (e: unknown) => e instanceof FinalPublicationError && e.code === "MISSING_REVIEW_FEEDBACK"
  );

  // Not one byte changed anywhere under the applications root, and no half-built folder survives.
  assert.deepEqual(snapshotTree(getPublishedApplicationsRoot()), before);
  const companyDir = path.join(getPublishedApplicationsRoot(), "celigo-inc");
  assert.deepEqual(
    fs.readdirSync(companyDir).filter((n) => n.startsWith(".publish-")),
    []
  );
});

// --- 10. Failure preservation & 11. master-file integrity ---------------------------------------

test("a non-READY workflow cannot publish, and cannot replace an existing good publication", () => {
  const good = publishFinalApplicationArtifacts(baseInput({ jobId: 7400, jobTitle: "Senior Data Engineer" }));
  const goodResume = fs.readFileSync(good.resumePath);
  const goodManifest = fs.readFileSync(good.manifestPath, "utf-8");

  const nonReady: WorkflowStatus[] = [
    "CREATED",
    "WRITER_RUNNING",
    "WRITER_COMPLETED",
    "REVIEW_RUNNING",
    "REVIEW_COMPLETED",
    "IMPROVEMENT_RUNNING",
    "FAILED",
  ];
  for (const status of nonReady) {
    assert.throws(
      () =>
        publishFinalApplicationArtifacts(
          baseInput({
            jobId: 7400,
            jobTitle: "Senior Data Engineer",
            workflowStatus: status,
            sourceResumePath: path.join(sourceDir, "SaiKishore_CoverLetter.docx"),
          })
        ),
      (e: unknown) => e instanceof FinalPublicationError && e.code === "WORKFLOW_NOT_READY",
      `status ${status} must not be able to publish`
    );
  }

  // The last known-good publication is byte-identical after every rejected attempt.
  assert.deepEqual(fs.readFileSync(good.resumePath), goodResume);
  assert.equal(fs.readFileSync(good.manifestPath, "utf-8"), goodManifest);

  // A later READY rerun is allowed to replace it, and replaces it completely.
  fs.writeFileSync(path.join(sourceDir, "rerun_Resume.docx"), Buffer.from("PK-second-approved-resume"));
  const rerun = publishFinalApplicationArtifacts(
    baseInput({
      jobId: 7400,
      jobTitle: "Senior Data Engineer",
      iterationNumber: 3,
      sourceResumePath: path.join(sourceDir, "rerun_Resume.docx"),
      publishedAt: "2026-05-02T12:00:00.000Z",
    })
  );
  assert.equal(rerun.directory, good.directory);
  assert.deepEqual(fs.readFileSync(rerun.resumePath), Buffer.from("PK-second-approved-resume"));
  assert.equal(rerun.manifest.iterationId, 3);
});

test("publication never reads or writes candidate master files", () => {
  const masterFiles = fs.readdirSync(masterDir);
  const before = masterFiles.map((name) => {
    const stat = fs.statSync(path.join(masterDir, name));
    return { name, bytes: fs.readFileSync(path.join(masterDir, name)).toString("base64"), mtimeMs: stat.mtimeMs };
  });

  publishFinalApplicationArtifacts(baseInput({ jobId: 7500, jobTitle: "Senior Data Engineer" }));

  const after = fs.readdirSync(masterDir).map((name) => {
    const stat = fs.statSync(path.join(masterDir, name));
    return { name, bytes: fs.readFileSync(path.join(masterDir, name)).toString("base64"), mtimeMs: stat.mtimeMs };
  });
  assert.deepEqual(after, before);

  // Nothing was published outside the applications root either.
  const root = path.resolve(getPublishedApplicationsRoot());
  assert.ok(root.startsWith(path.resolve(tmpGeneratedDir) + path.sep));
});

// --- 12. The orchestrator's READY branch actually publishes -------------------------------------

test("the orchestrator publishes on READY, with published bytes identical to the approved artifacts", async () => {
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: job.dedupe_key });

  const res = await executeResumeQualityIteration({
    candidateId,
    workflowId: wf.id,
    resume: PERFECT_RESUME,
    coverLetter: COVER_LETTER,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(res.status, "READY");
  assert.equal(res.publicationError, undefined);
  assert.ok(res.publishedApplication, "READY must publish into the applications tree");

  const published = res.publishedApplication!;
  assert.equal(
    published.directory,
    path.join(tmpGeneratedDir, "applications", "celigo-inc", `senior-data-engineer-${job.id}`)
  );
  assert.equal(path.basename(published.resumePath), "SaiKishore_Resume.docx");
  assert.ok(fs.existsSync(published.resumePath));
  assert.ok(fs.existsSync(published.manifestPath));
  assert.ok(fs.existsSync(published.reviewFeedbackPath!));

  // The published documents are byte-identical to the approved artifacts in final/ — which is exactly
  // what the quality-workflow artifacts API serves for this workflow.
  assert.deepEqual(fs.readFileSync(published.resumePath), fs.readFileSync(res.finalArtifacts!.resumePath!));
  if (res.finalArtifacts!.coverLetterPath) {
    assert.deepEqual(
      fs.readFileSync(published.coverLetterPath!),
      fs.readFileSync(res.finalArtifacts!.coverLetterPath!)
    );
  }
  assert.equal(
    fs.readFileSync(published.reviewFeedbackPath!, "utf-8"),
    fs.readFileSync(res.finalArtifacts!.reviewFeedbackPath, "utf-8")
  );

  // The manifest ties the files back to this candidate, job, and workflow.
  assert.equal(published.manifest.candidateId, candidateId);
  assert.equal(published.manifest.jobId, job.id);
  assert.equal(published.manifest.workflowId, wf.id);
  assert.equal(published.manifest.tailoringRunId, runId);
  assert.equal(published.manifest.applicationId, applicationId);
  assert.equal(published.manifest.dedupeKey, job.dedupe_key);
  assert.equal(published.manifest.workflowStatus, "READY");
  assert.equal(published.manifest.iterationId, res.iterationNumber);

  // final/ remains authoritative and untouched by publication.
  assert.ok(fs.existsSync(path.join(res.finalDirectory!, "careerops_review.json")));
});

test("an improvement-needed iteration publishes nothing", async () => {
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: job.dedupe_key });

  const flawedResume: ResumeContent = {
    ...PERFECT_RESUME,
    summary: ["Data Engineer with some experience."],
    skillGroups: [{ label: "Programming", items: ["Python"] }],
    experience: [{ ...PERFECT_RESUME.experience[0], bullets: ["Responsible for writing scripts."] }],
  };

  const res = await executeResumeQualityIteration({
    candidateId,
    workflowId: wf.id,
    resume: flawedResume,
    coverLetter: COVER_LETTER,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(res.status, "IMPROVEMENT_RUNNING");
  assert.equal(res.publishedApplication, undefined);
  assert.equal(res.finalDirectory, undefined);
});
