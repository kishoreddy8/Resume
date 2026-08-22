import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { INSTRUCTION_HASH, INSTRUCTION_VERSION } from "../canonicalInstructions";
import { determineFinalDisposition } from "../finalDisposition";
import { planRepairScope, renderRepairPlanSection } from "../repairScope";
import { publishSafeBestAttempt, SafeAttemptPublicationError } from "../safeAttemptPublication";
import {
  describeSchedulerHost,
  getConfiguredSchedulerHost,
  webProcessOwnsScheduler,
  workerProcessOwnsScheduler,
} from "@/lib/scheduler/host";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES } from "../types";
import type { ComplianceStatus, CoverLetterContent, InstructionComplianceChecks, ResumeContent, StructuredResumeReview } from "../types";

/**
 * Stage 28 (continuation) — targeted repair, scheduler ownership, and safe-attempt publication.
 *
 * Pure + temp-filesystem only: no database, no Claude, no network.
 */

function allChecks(status: ComplianceStatus): InstructionComplianceChecks {
  const checks = {} as InstructionComplianceChecks;
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) checks[name] = status;
  return checks;
}

function review(overrides: Partial<StructuredResumeReview> = {}, checkOverrides: Partial<InstructionComplianceChecks> = {}, checkNotes?: Record<string, string[]>): StructuredResumeReview {
  return {
    overallScore: 88,
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
    blockingFailures: [],
    recruiterQualityAssessment: { status: "PASS", score: 90, issues: [] },
    instructionCompliance: {
      instructionVersion: INSTRUCTION_VERSION,
      instructionHash: INSTRUCTION_HASH,
      checks: { ...allChecks("PASS"), ...checkOverrides },
      notes: [],
      checkNotes,
    },
    ...overrides,
  } as StructuredResumeReview;
}

const BASELINE_RESUME: ResumeContent = {
  name: "Sai Reddy",
  tagline: "Data Engineer",
  location: "Dallas, TX",
  phone: "5551112222",
  email: "sai@example.com",
  summary: ["Data Engineer building supported cloud data platforms for banking teams."],
  skillGroups: [{ label: "Cloud", items: ["Azure", "Snowflake"] }],
  experience: [
    {
      title: "Data Engineer",
      company: "Fiserv",
      dates: "2022 - Present",
      projectDescription: "Built Azure data pipelines for payments reporting.",
      bullets: ["Engineered Azure pipelines for payments reporting."],
    },
  ],
  education: ["MS, Example University - 2022"],
};

const BASELINE_COVER: CoverLetterContent = {
  name: "Sai Reddy",
  location: "Dallas, TX",
  phone: "5551112222",
  email: "sai@example.com",
  salutation: "Dear Hiring Team,",
  paragraphs: ["At Fiserv, I built Snowflake pipelines. I also supported payments reporting."],
  closing: "Sincerely,\nSai Reddy",
};

// =================================================================================================
// A. Repair scope is decided deterministically by CareerOps
// =================================================================================================

test("S28-30 a cover-letter-only failure repairs only the cover letter", () => {
  const plan = planRepairScope(
    review(
      {
        blockingFailures: [
          { type: "EMPLOYER_CONTRADICTION", description: 'Cover letter attributes "Spark" to Fiserv, but the Fiserv bullets do not support it.' },
        ],
      },
      { crossDocumentConsistency: "FAIL", finalValidation: "FAIL" },
      { crossDocumentConsistency: ['Cover letter attributes "Spark" to Fiserv.'] }
    )
  );
  assert.equal(plan.scope, "COVER_LETTER_ONLY");
  assert.equal(plan.resumeFindings.length, 0, "the resume must not be rewritten");
  assert.ok(plan.coverLetterFindings.length > 0);

  const section = renderRepairPlanSection(plan);
  assert.match(section, /Repair scope: COVER_LETTER_ONLY/);
  assert.match(section, /Reproduce it EXACTLY as given/, "the accepted resume must be preserved verbatim");
});

test("S28-31 a resume-only failure repairs only the resume", () => {
  const plan = planRepairScope(
    review({ blockingIssues: ["Resume bullet at Comerica claims an unsupported metric."] }, { bulletWriting: "FAIL", finalValidation: "FAIL" })
  );
  assert.equal(plan.scope, "RESUME_ONLY");
  assert.equal(plan.coverLetterFindings.length, 0, "the cover letter must not be rewritten");
  assert.match(renderRepairPlanSection(plan), /Repair scope: RESUME_ONLY/);
});

test("S28-32 broad or structural failures trigger a full repair", () => {
  const structural = planRepairScope(
    review({ blockingIssues: ["Cover letter tone is wrong."] }, { hardCareerFacts: "FAIL", finalValidation: "FAIL" })
  );
  assert.equal(structural.scope, "FULL", "a resume-structural check cannot be fixed from the cover letter");

  const both = planRepairScope(
    review({ blockingIssues: ["Resume bullet is generic.", "Cover letter opening is generic."] })
  );
  assert.equal(both.scope, "FULL", "findings on both artifacts widen the scope");
});

test("S28-33 an unattributable finding always widens the scope rather than being dropped", () => {
  const plan = planRepairScope(review({ blockingIssues: ["Tone is inconsistent throughout the package."] }));
  assert.equal(plan.scope, "FULL");
  assert.ok(plan.unattributedFindings.length > 0, "the finding must be recorded, never silently discarded");
  // It must still reach the writer somewhere.
  const section = renderRepairPlanSection(plan);
  assert.ok(section.includes("Tone is inconsistent throughout the package."), "an unattributed finding must still be stated to the writer");
});

test("S28-34 a finding naming BOTH documents is repaired on both sides and never dropped", () => {
  const plan = planRepairScope(
    review({ blockingIssues: ["The cover letter claims a technology the resume never mentions."] })
  );
  assert.equal(plan.scope, "FULL");
  assert.ok(plan.resumeFindings.some((f) => f.includes("cover letter")));
  assert.ok(plan.coverLetterFindings.some((f) => f.includes("resume")));
});

test("S28-35 the repair brief always demands the complete pair back for a full re-review", () => {
  for (const plan of [
    planRepairScope(review({ blockingIssues: ["Cover letter names the wrong employer."] })),
    planRepairScope(review({ blockingIssues: ["Resume bullet is generic."] })),
  ]) {
    const section = renderRepairPlanSection(plan);
    assert.match(section, /return BOTH documents/i, "a narrower repair must never become a narrower review");
    assert.match(section, /re-reviews the complete pair/i);
  }
});

test("S28-36 a clean review needs no repair scope narrowing decision at all", () => {
  const plan = planRepairScope(review());
  assert.equal(plan.resumeFindings.length, 0);
  assert.equal(plan.coverLetterFindings.length, 0);
  assert.equal(plan.scope, "FULL", "with nothing attributed, the conservative default is a full rewrite");
});

test("root repair normalization excludes finalValidation and deduplicates its originating failure", () => {
  const plan = planRepairScope(
    review(
      {
        blockingFailures: [
          {
            type: "UNSUPPORTED_CLAIM",
            description: '"Data Governance" is claimed on the resume but is not grounded in candidate evidence.',
            evidenceSearched: ["Master Resume", "Master Skills Inventory"],
          },
        ],
        requiredCorrections: [
          { priority: "CRITICAL", description: "Canonical instruction compliance — masterSkillsInventoryCompliance: FAIL. This is a hard-gate check." },
          { priority: "CRITICAL", description: "Canonical instruction compliance — finalValidation: FAIL. This is a hard-gate check." },
        ],
      },
      { masterSkillsInventoryCompliance: "FAIL", finalValidation: "FAIL" },
      { masterSkillsInventoryCompliance: ["Technologies with no grounding: Data Governance"] }
    ),
    { resume: { ...BASELINE_RESUME, summary: ["Data Engineer focused on Data Governance."] }, coverLetter: BASELINE_COVER }
  );
  assert.equal(plan.rootFindings?.length, 1);
  assert.doesNotMatch(JSON.stringify(plan.rootFindings), /finalValidation/);
  assert.deepEqual(plan.editablePaths, ["resume.summary[0]"]);
});

test("employer attribution becomes one cover-letter sentence repair and freezes the resume", () => {
  const plan = planRepairScope(
    review(
      {
        blockingFailures: [
          {
            type: "EMPLOYER_CONTRADICTION",
            description: 'Cover letter attributes "Snowflake" to Fiserv, but Fiserv evidence does not support it.',
          },
        ],
      },
      { crossDocumentConsistency: "FAIL", finalValidation: "FAIL" },
      { crossDocumentConsistency: ['Cover letter attributes "Snowflake" to Fiserv.'] }
    ),
    { resume: BASELINE_RESUME, coverLetter: BASELINE_COVER }
  );
  assert.equal(plan.scope, "COVER_LETTER_ONLY");
  assert.deepEqual(plan.editablePaths, ["coverLetter.paragraphs[0].sentences[0]"]);
  assert.equal(plan.rootFindings?.length, 1, "the compliance echo must not become a second repair");
  assert.match(renderRepairPlanSection(plan), /Every other summary sentence[\s\S]*FROZEN/);
});

// =================================================================================================
// B. Scheduler ownership — exactly one host
// =================================================================================================

test("S28-40 the default host is unchanged: the web process owns the scheduler", () => {
  const env = {} as unknown as NodeJS.ProcessEnv;
  assert.equal(getConfiguredSchedulerHost(env), "web");
  assert.equal(webProcessOwnsScheduler(env), true);
  assert.equal(workerProcessOwnsScheduler(env), false);
});

test("S28-41 web and worker can never both own the scheduler", () => {
  for (const value of ["web", "worker", "none", "", "nonsense"]) {
    const env = { CAREER_OPS_SCHEDULER_HOST: value } as unknown as NodeJS.ProcessEnv;
    const web = webProcessOwnsScheduler(env);
    const worker = workerProcessOwnsScheduler(env);
    assert.ok(!(web && worker), `both hosts armed for CAREER_OPS_SCHEDULER_HOST=${JSON.stringify(value)}`);
  }
});

test("S28-42 worker mode disarms the web process, and none disarms both", () => {
  const worker = { CAREER_OPS_SCHEDULER_HOST: "worker" } as unknown as NodeJS.ProcessEnv;
  assert.equal(workerProcessOwnsScheduler(worker), true);
  assert.equal(webProcessOwnsScheduler(worker), false);

  const none = { CAREER_OPS_SCHEDULER_HOST: "none" } as unknown as NodeJS.ProcessEnv;
  assert.equal(webProcessOwnsScheduler(none), false);
  assert.equal(workerProcessOwnsScheduler(none), false);
});

test("S28-43 an unrecognised value falls back to the old behaviour rather than silently disabling automation", () => {
  const env = { CAREER_OPS_SCHEDULER_HOST: "typo" } as unknown as NodeJS.ProcessEnv;
  assert.equal(getConfiguredSchedulerHost(env), "web");
  assert.match(describeSchedulerHost(env), /web process/i);
});

// =================================================================================================
// C. Safe-attempt publication — never labelled READY, never published when unsafe
// =================================================================================================

function tmpAttemptDir(): { dir: string; resume: string; cover: string; feedback: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s28-pub-"));
  const resume = path.join(dir, "Resume.docx");
  const cover = path.join(dir, "CoverLetter.docx");
  const feedback = path.join(dir, "review_feedback.md");
  fs.writeFileSync(resume, "RESUME BYTES");
  fs.writeFileSync(cover, "COVER BYTES");
  fs.writeFileSync(feedback, "# feedback");
  return { dir, resume, cover, feedback };
}

function publishInput(disposition: ReturnType<typeof determineFinalDisposition>, src: ReturnType<typeof tmpAttemptDir>) {
  return {
    disposition,
    candidateId: 1,
    candidateName: "Sai Kishore Reddy",
    // Deliberately the raw first name WITH its space — the Stage 28 closure bug was that only Phase 9A
    // normalised it. Both publications must now derive "SaiKishore" from this identical input.
    candidateFirstName: "Sai Kishore",
    companyId: 3928,
    companyName: "JPMorganChase",
    jobId: 33034,
    jobTitle: "Lead Software Engineer",
    workflowId: 9,
    tailoringRunId: 9,
    sourceResumePath: src.resume,
    sourceCoverLetterPath: src.cover,
    sourceReviewFeedbackPath: src.feedback,
  };
}

/** Truthful but under-optimised — the SAFE_BEST_ATTEMPT shape. */
const SAFE_REVIEW = review({ overallScore: 78, recruiterQualityAssessment: { status: "REVIEW", score: 40, issues: [] } }, { technologyGrouping: "REVIEW", finalValidation: "FAIL" });

test("S28-50 a safe best attempt publishes, and never claims READY or approved", () => {
  const src = tmpAttemptDir();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s28-root-"));
  const prev = process.env.CAREER_OPS_GENERATED_DIR;
  process.env.CAREER_OPS_GENERATED_DIR = outDir;
  try {
    const disposition = determineFinalDisposition([{ iterationNumber: 2, review: SAFE_REVIEW }]);
    assert.equal(disposition.disposition, "SAFE_BEST_ATTEMPT");

    const published = publishSafeBestAttempt(publishInput(disposition, src));

    assert.equal(published.manifest.status, "SAFE_BEST_ATTEMPT");
    assert.equal(published.manifest.humanReviewRequired, true);
    assert.equal(published.manifest.optimizationScore, 78);
    assert.equal(published.manifest.selectedIterationNumber, 2);
    assert.ok(fs.existsSync(published.resumePath), "resume must be published");
    assert.ok(fs.existsSync(published.coverLetterPath), "cover letter must be published");

    // Same candidate-derived filename convention as a Phase 9A READY publication — one algorithm,
    // no hardcoding, and a first name containing a space normalises identically in both.
    assert.equal(path.basename(published.resumePath), "SaiKishore_Resume.docx");
    assert.equal(path.basename(published.coverLetterPath), "SaiKishore_CoverLetter.docx");
    assert.equal(published.manifest.candidateFilePrefix, "SaiKishore");
    assert.ok(published.reviewFeedbackPath && fs.existsSync(published.reviewFeedbackPath), "review feedback must be published");

    // Bytes are copied verbatim from the selected attempt.
    assert.equal(fs.readFileSync(published.resumePath, "utf-8"), "RESUME BYTES");

    // Nothing anywhere may read as an approved READY publication.
    const status = JSON.parse(fs.readFileSync(published.statusPath, "utf-8"));
    assert.equal(status.status, "SAFE_BEST_ATTEMPT");
    assert.equal(status.approved, false);
    const manifestText = fs.readFileSync(published.manifestPath, "utf-8");
    assert.ok(!/"status"\s*:\s*"READY"/.test(manifestText), "the manifest must never state READY");
    assert.match(published.directory, /human-review$/, "published beside, not into, the approved artifact directory");
  } finally {
    if (prev === undefined) delete process.env.CAREER_OPS_GENERATED_DIR;
    else process.env.CAREER_OPS_GENERATED_DIR = prev;
    fs.rmSync(src.dir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("S28-51 an unsafe attempt can never be published as usable application artifacts", () => {
  const src = tmpAttemptDir();
  try {
    const unsafe = determineFinalDisposition([
      { iterationNumber: 1, review: review({ overallScore: 100, blockingFailures: [{ type: "EMPLOYER_CONTRADICTION", description: "x" }] }) },
    ]);
    assert.equal(unsafe.disposition, "BLOCKED");
    assert.throws(
      () => publishSafeBestAttempt(publishInput(unsafe, src)),
      (err: unknown) => err instanceof SafeAttemptPublicationError && err.code === "NOT_SAFE_BEST_ATTEMPT"
    );
  } finally {
    fs.rmSync(src.dir, { recursive: true, force: true });
  }
});

test("S28-52 a READY workflow does not go down the safe-attempt path", () => {
  const src = tmpAttemptDir();
  try {
    const ready = determineFinalDisposition([{ iterationNumber: 1, review: review({ overallScore: 97 }) }]);
    assert.equal(ready.disposition, "READY", "Phase 9A owns this case, untouched");
    assert.throws(
      () => publishSafeBestAttempt(publishInput(ready, src)),
      (err: unknown) => err instanceof SafeAttemptPublicationError && err.code === "NOT_SAFE_BEST_ATTEMPT"
    );
  } finally {
    fs.rmSync(src.dir, { recursive: true, force: true });
  }
});

test("S28-53 a package whose documents did not render is refused", () => {
  const src = tmpAttemptDir();
  try {
    const disposition = determineFinalDisposition([{ iterationNumber: 1, review: SAFE_REVIEW }]);
    fs.rmSync(src.cover);
    assert.throws(
      () => publishSafeBestAttempt(publishInput(disposition, src)),
      (err: unknown) => err instanceof SafeAttemptPublicationError && err.code === "MISSING_COVER_LETTER"
    );
  } finally {
    fs.rmSync(src.dir, { recursive: true, force: true });
  }
});
