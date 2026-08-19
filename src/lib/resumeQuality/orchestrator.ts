import fs from "node:fs";
import path from "node:path";
import { getCandidate } from "@/db/queries/candidates";
import { getCandidateJobState } from "@/db/queries/candidateJobState";
import { getCompany } from "@/db/queries/companies";
import { getJobByDedupeKey } from "@/db/queries/jobs";
import { getTailoringRun } from "@/db/queries/tailoringRuns";
import {
  createResumeQualityIteration,
  createResumeQualityWorkflow,
  getResumeQualityIteration,
  getResumeQualityWorkflow,
  listResumeQualityIterations,
  IterationAlreadyExistsError,
  IterationExceedsMaxError,
  ResumeQualityWorkflowNotFoundError,
  transitionWorkflowStatus,
  type ResumeQualityIterationRow,
  type ResumeQualityWorkflowRow,
} from "@/db/queries/resumeQualityWorkflows";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import { getTailoringArtifactDirectory } from "@/lib/tailoringArtifacts";
import { CANONICAL_TAILORING_INSTRUCTIONS, INSTRUCTION_HASH, INSTRUCTION_VERSION } from "./canonicalInstructions";
import { resolveCandidateContact } from "./candidateContact";
import { gateBlockingComplianceCorrections } from "./instructionCompliance";
import { planRepairScope, type RepairPlan } from "./repairScope";
import { generateColdFollowUpEmail } from "./coldFollowUpEmail";
import { publishFinalApplicationArtifacts, type PublishedApplication } from "./finalPublication";
import { generateHumanReviewPackage } from "./humanReviewPackage";
import { determineFinalDisposition } from "./finalDisposition";
import { publishSafeBestAttempt } from "./safeAttemptPublication";
import { evaluateQualityGate, type QualityGateOutcome } from "./qualityGate";
import { renderReviewFeedbackMarkdown } from "./reviewFeedback";
import { DeterministicResumeReviewer } from "./reviewers/deterministicReviewer";
import { assertValidWorkflowTransition } from "./stateMachine";
import { generateTailoringOutputs } from "../../../tools/tailoring-engine/generate";
import type { CoverLetterContent, ResumeContent } from "../../../tools/tailoring-engine/types";
import { validateDocx } from "../../../tools/tailoring-engine/validate-docx";
import {
  structuredResumeReviewSchema,
  type BlockingFailure,
  type RequiredCorrection,
  type ResumeQualityLoopResult,
  type ResumeReviewerAgent,
  type ResumeReviewerInput,
  type ResumeWriterAgent,
  type ResumeWriterInput,
  type ResumeWriterOutput,
  type StructuredResumeReview,
  type WorkflowStatus,
  type WorkflowStatusFile,
  type WriterValidation,
} from "./types";
import {
  finalCoverLetterFilename,
  finalResumeFilename,
  getFinalDirectory,
  getIterationDirectory,
  getWorkspaceDirectory,
  type QualityWorkflowLocation,
} from "./workspace";
import { buildWorkspacePackage } from "./workspacePackage";

/**
 * Phase 3 Stage 9 & 10 — Deterministic Multi-Iteration Resume Quality Orchestrator.
 *
 * Connects tailoring output, quality workflow state machine, deterministic reviewer,
 * and writer agents into a complete, reproducible multi-turn improvement loop:
 *
 *   Iteration 1 (Initial Tailored Resume)
 *          ↓
 *   Reviewer (Stage 8 DeterministicReviewer)
 *          ↓
 *   Quality Gate (evaluateQualityGate)
 *     ├── READY → Final approved artifacts in final/ (<FirstName>_Resume.docx, feedback)
 *     └── IMPROVEMENT_RUNNING
 *              ↓
 *          Writer Agent (ResumeWriterAgent)
 *              ↓
 *          Iteration 2 (Improved Resume)
 *              ↓
 *          Reviewer (DeterministicReviewer)
 *              ↓
 *          Quality Gate
 *            ├── READY
 *            └── IMPROVEMENT_RUNNING
 *                     ↓
 *                 Iteration 3 (Improved Resume)
 *                     ↓
 *                 Reviewer (DeterministicReviewer)
 *                     ↓
 *                 Quality Gate
 *                   ├── READY
 *                   └── NEEDS_HUMAN_REVIEW (Workflow FAILED with explanatory reason)
 *
 * Max iterations: 3 (strictly enforced).
 * Immutability: Iterations 1, 2, and 3 have independent non-overwriting directories and DB records.
 * Zero external AI provider SDKs required; works with provider-independent interfaces and test doubles.
 */

export interface ExecuteResumeQualityIterationInput {
  candidateId: number;
  workflowId: number;
  resume: ResumeContent;
  coverLetter?: CoverLetterContent;
  /** Optional pre-rendered DOCX paths on filesystem to copy into this iteration. */
  resumeDocxPath?: string;
  coverLetterDocxPath?: string;
  /** Optional structured JD requirements. If omitted, loaded from workspace extracted_job_requirements.json if present. */
  jobRequirements?: RequirementUnit[];
  /** Optional CandidateProfile. If omitted, loaded from loadCandidateProfile(candidateId) if available. */
  masterResumeProfile?: CandidateProfile;
  /** Optional custom reviewer agent for testing/extensibility; defaults to new DeterministicResumeReviewer(). */
  reviewer?: ResumeReviewerAgent;
  /** External writer's self-reported guardrail self-check, when supplied — provenance only, persisted
   *  as writer_validation.json on READY, never consulted by the quality gate. */
  writerValidation?: WriterValidation;
}

export interface ResumeQualityFinalArtifacts {
  resumePath?: string;
  coverLetterPath?: string;
  reviewFeedbackPath: string;
}

export interface ResumeQualityOrchestrationResult {
  workflow: ResumeQualityWorkflowRow;
  iteration: ResumeQualityIterationRow;
  review: StructuredResumeReview;
  qualityGateOutcome: QualityGateOutcome;
  status: WorkflowStatus;
  iterationNumber: number;
  outputFiles: string[];
  iterationDirectory: string;
  finalDirectory?: string;
  finalArtifacts?: ResumeQualityFinalArtifacts;
  requiredCorrections: RequiredCorrection[];
  failureReason?: string | null;
  /** Populated only on the terminal NEEDS_HUMAN_REVIEW/FAILED path — see humanReviewPackage.ts. Never
   *  set on READY (final/ remains the sole approved-artifact directory) or on any non-terminal status. */
  humanReviewPackage?: { iterationNumber: number; directory: string };
  /** Stage 28 — set only when the exhausted workflow was nevertheless truthful and its safest attempt
   *  was published as an explicitly-labelled human-review package. Never implies READY. */
  safeBestAttempt?: { directory: string; selectedIterationNumber: number; optimizationScore: number | null };
  /** Phase 9A — the durable, human-readable copy of the approved artifacts under
   *  data/generated/applications/<company>/<position>-<jobId>/. Only ever set on READY. Absent when
   *  the job/company could not be resolved, when no approved resume DOCX was rendered, or when
   *  publication itself failed (in which case publicationError explains why). */
  publishedApplication?: PublishedApplication;
  /** Why the Phase 9A publication did not happen, when it was attempted and failed. Never affects
   *  the workflow's own status — final/ stays authoritative and the approval stands. */
  publicationError?: string;
}

export interface StartAndExecuteResumeQualityWorkflowInput {
  candidateId: number;
  applicationId: number;
  tailoringRunId: number;
  dedupeKey: string;
  maxIterations?: number;
  resume: ResumeContent;
  coverLetter?: CoverLetterContent;
  resumeDocxPath?: string;
  coverLetterDocxPath?: string;
  jobRequirements?: RequirementUnit[];
  masterResumeProfile?: CandidateProfile;
  reviewer?: ResumeReviewerAgent;
}

export interface ExecuteResumeImprovementIterationInput {
  candidateId: number;
  workflowId: number;
  writer: ResumeWriterAgent;
  reviewer?: ResumeReviewerAgent;
  jobRequirements?: RequirementUnit[];
  masterResumeProfile?: CandidateProfile;
  resumeDocxPath?: string;
  coverLetterDocxPath?: string;
}

export interface RunResumeQualityLoopInput {
  candidateId: number;
  workflowId: number;
  initialResume?: ResumeContent;
  initialCoverLetter?: CoverLetterContent;
  initialResumeDocxPath?: string;
  initialCoverLetterDocxPath?: string;
  jobRequirements?: RequirementUnit[];
  masterResumeProfile?: CandidateProfile;
  reviewer?: ResumeReviewerAgent;
  writer?: ResumeWriterAgent;
}

export interface StartAndRunResumeQualityLoopInput {
  candidateId: number;
  applicationId: number;
  tailoringRunId: number;
  dedupeKey: string;
  maxIterations?: number;
  initialResume: ResumeContent;
  initialCoverLetter?: CoverLetterContent;
  initialResumeDocxPath?: string;
  initialCoverLetterDocxPath?: string;
  jobRequirements?: RequirementUnit[];
  masterResumeProfile?: CandidateProfile;
  reviewer?: ResumeReviewerAgent;
  writer?: ResumeWriterAgent;
}

export class ResumeQualityOrchestrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ResumeQualityOrchestrationError";
  }
}

/**
 * validateDocx() assumes a well-formed OOXML zip; a handful of tests (and, in principle, any
 * caller that hands in a placeholder/corrupt file) don't produce one. A parse failure is itself
 * useful evidence for the atsFormatting compliance check, not a reason to crash the whole review —
 * so it's downgraded to a violation entry rather than left to throw and abort the iteration.
 */
async function safeValidateDocx(filePath: string, kind: "resume" | "coverLetter") {
  try {
    return await validateDocx(filePath, kind);
  } catch (err) {
    return { valid: false, violations: [`Unable to parse DOCX file: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/**
 * Validates and drives a single resume quality iteration through deterministic review,
 * artifact generation, immutable DB persistence, and quality gate evaluation.
 */
export async function executeResumeQualityIteration(
  input: ExecuteResumeQualityIterationInput
): Promise<ResumeQualityOrchestrationResult> {
  const { candidateId, workflowId, resume } = input;

  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    throw new ResumeQualityOrchestrationError("INVALID_CANDIDATE_ID", `Invalid candidateId: ${candidateId}`);
  }
  if (!Number.isInteger(workflowId) || workflowId <= 0) {
    throw new ResumeQualityOrchestrationError("INVALID_WORKFLOW_ID", `Invalid workflowId: ${workflowId}`);
  }

  const candidate = getCandidate(candidateId);
  if (!candidate) {
    throw new ResumeQualityOrchestrationError("CANDIDATE_NOT_FOUND", `Candidate ${candidateId} not found`);
  }
  if (candidate.status !== "active") {
    throw new ResumeQualityOrchestrationError("NOT_ACTIVE_CANDIDATE", `Candidate ${candidateId} is not active`);
  }

  const workflow = getResumeQualityWorkflow(candidateId, workflowId);
  if (!workflow) {
    throw new ResumeQualityWorkflowNotFoundError(candidateId, workflowId);
  }

  // Terminal workflows can never be re-executed
  if (workflow.status === "READY" || workflow.status === "FAILED") {
    throw new ResumeQualityOrchestrationError(
      "WORKFLOW_ALREADY_TERMINAL",
      `Cannot execute quality iteration on terminal workflow ${workflowId} (status: ${workflow.status})`
    );
  }

  if (input.resumeDocxPath && !fs.existsSync(input.resumeDocxPath)) {
    throw new ResumeQualityOrchestrationError(
      "INPUT_FILE_NOT_FOUND",
      `Specified resumeDocxPath does not exist: ${input.resumeDocxPath}`
    );
  }
  if (input.coverLetterDocxPath && !fs.existsSync(input.coverLetterDocxPath)) {
    throw new ResumeQualityOrchestrationError(
      "INPUT_FILE_NOT_FOUND",
      `Specified coverLetterDocxPath does not exist: ${input.coverLetterDocxPath}`
    );
  }

  // Validate identity consistency across tailoring_run and candidate_job_state
  const tailoringRun = getTailoringRun(candidateId, workflow.tailoring_run_id);
  if (!tailoringRun) {
    throw new ResumeQualityOrchestrationError(
      "TAILORING_RUN_NOT_FOUND",
      `Tailoring run ${workflow.tailoring_run_id} not found for candidate ${candidateId}`
    );
  }
  if (tailoringRun.dedupe_key !== workflow.dedupe_key) {
    throw new ResumeQualityOrchestrationError(
      "IDENTITY_MISMATCH",
      `Tailoring run dedupe_key (${tailoringRun.dedupe_key}) does not match workflow dedupe_key (${workflow.dedupe_key})`
    );
  }

  const appState = getCandidateJobState(candidateId, workflow.dedupe_key);
  if (appState && appState.id !== workflow.application_id) {
    throw new ResumeQualityOrchestrationError(
      "APPLICATION_MISMATCH",
      `Application ID mismatch: candidate_job_state id is ${appState.id}, workflow application_id is ${workflow.application_id}`
    );
  }

  // Calculate target iteration number
  const iterationNumber = workflow.current_iteration + 1;
  if (iterationNumber > workflow.max_iterations) {
    throw new IterationExceedsMaxError(workflowId, iterationNumber, workflow.max_iterations);
  }

  // Duplicate check before doing any work (idempotency defense)
  const existingIter = getResumeQualityIteration(candidateId, workflowId, iterationNumber);
  if (existingIter) {
    throw new IterationAlreadyExistsError(workflowId, iterationNumber);
  }

  const location: QualityWorkflowLocation = {
    candidateId,
    dedupeKey: workflow.dedupe_key,
    runId: workflow.tailoring_run_id,
    workflowId: workflow.id,
  };

  const workspaceDir = getWorkspaceDirectory(location);
  const iterDir = getIterationDirectory(location, iterationNumber);

  // Transition workflow into REVIEW_RUNNING via legal state machine paths
  let currentStatus = workflow.status;
  if (currentStatus === "CREATED") {
    transitionWorkflowStatus(candidateId, workflowId, "WRITER_RUNNING");
    transitionWorkflowStatus(candidateId, workflowId, "WRITER_COMPLETED");
    transitionWorkflowStatus(candidateId, workflowId, "REVIEW_RUNNING");
    currentStatus = "REVIEW_RUNNING";
  } else if (currentStatus === "WRITER_COMPLETED") {
    transitionWorkflowStatus(candidateId, workflowId, "REVIEW_RUNNING");
    currentStatus = "REVIEW_RUNNING";
  } else if (currentStatus === "IMPROVEMENT_RUNNING") {
    transitionWorkflowStatus(candidateId, workflowId, "REVIEW_RUNNING");
    currentStatus = "REVIEW_RUNNING";
  } else if (currentStatus === "REVIEW_RUNNING") {
    // Already in REVIEW_RUNNING
  } else {
    assertValidWorkflowTransition(currentStatus, "REVIEW_RUNNING");
  }

  // Resolve Master Resume Profile and Job Requirements if not explicitly provided
  let masterResumeProfile = input.masterResumeProfile;
  if (!masterResumeProfile) {
    const profileRes = loadCandidateProfile(candidateId);
    if (profileRes.status === "ok") {
      masterResumeProfile = profileRes.profile;
    }
  }

  let jobRequirements = input.jobRequirements;
  if (!jobRequirements) {
    const extractedReqPath = path.join(workspaceDir, "extracted_job_requirements.json");
    if (fs.existsSync(extractedReqPath)) {
      try {
        const rawReqs = JSON.parse(fs.readFileSync(extractedReqPath, "utf-8"));
        if (Array.isArray(rawReqs)) {
          jobRequirements = rawReqs as RequirementUnit[];
        }
      } catch {
        // Fall back to undefined if unparseable
      }
    }
  }

  try {
    // 0. Render/copy DOCX outputs FIRST — the reviewer needs the real rendered files (when they
    // exist) to run docx-level ATS-formatting validation, and the deep-rewrite check needs the
    // prior iteration's resume, so both must be resolved before the reviewer is invoked below.
    fs.mkdirSync(iterDir, { recursive: true });

    const outputFiles: string[] = [];

    // Copy or generate Resume.docx in iteration dir
    const iterResumeDocx = path.join(iterDir, "Resume.docx");
    if (input.resumeDocxPath && fs.existsSync(input.resumeDocxPath)) {
      if (path.resolve(input.resumeDocxPath) !== path.resolve(iterResumeDocx)) {
        fs.copyFileSync(input.resumeDocxPath, iterResumeDocx);
      }
      outputFiles.unshift("Resume.docx");
    } else {
      const runDir = getTailoringArtifactDirectory({
        candidateId,
        dedupeKey: workflow.dedupe_key,
        runId: workflow.tailoring_run_id,
      });
      const runResumeDocx = path.join(runDir, "Resume.docx");
      if (fs.existsSync(runResumeDocx) && !fs.existsSync(iterResumeDocx)) {
        fs.copyFileSync(runResumeDocx, iterResumeDocx);
        outputFiles.unshift("Resume.docx");
      }
    }

    // Copy or generate CoverLetter.docx in iteration dir
    const iterCoverDocx = path.join(iterDir, "CoverLetter.docx");
    if (input.coverLetterDocxPath && fs.existsSync(input.coverLetterDocxPath)) {
      if (path.resolve(input.coverLetterDocxPath) !== path.resolve(iterCoverDocx)) {
        fs.copyFileSync(input.coverLetterDocxPath, iterCoverDocx);
      }
      outputFiles.push("CoverLetter.docx");
    } else {
      const runDir = getTailoringArtifactDirectory({
        candidateId,
        dedupeKey: workflow.dedupe_key,
        runId: workflow.tailoring_run_id,
      });
      const runCoverDocx = path.join(runDir, "CoverLetter.docx");
      if (fs.existsSync(runCoverDocx) && !fs.existsSync(iterCoverDocx)) {
        fs.copyFileSync(runCoverDocx, iterCoverDocx);
        outputFiles.push("CoverLetter.docx");
      }
    }

    // If docx files were not copied from previous run or input path, generate them directly
    if (!fs.existsSync(iterResumeDocx)) {
      try {
        const job = getJobByDedupeKey(workflow.dedupe_key);
        const company = job ? getCompany(job.company_id) : undefined;
        await generateTailoringOutputs(
          {
            company: company?.name ?? "Company",
            jobId: job?.id ?? workflow.id,
            resume,
            coverLetter: input.coverLetter ?? {
              name: resume.name,
              location: resume.location,
              email: resume.email,
              phone: resume.phone,
              salutation: "Dear Hiring Team,",
              paragraphs: ["I am excited to apply for this position."],
              closing: `Sincerely,\n${resume.name}`,
            },
          },
          { outputDir: iterDir }
        );
        if (fs.existsSync(iterResumeDocx) && !outputFiles.includes("Resume.docx")) {
          outputFiles.unshift("Resume.docx");
        }
        if (input.coverLetter && fs.existsSync(iterCoverDocx) && !outputFiles.includes("CoverLetter.docx")) {
          outputFiles.push("CoverLetter.docx");
        }
      } catch {
        // Fall back gracefully if docx generation is not possible
      }
    }

    // Validate the rendered DOCX files against the deterministic OOXML rules — this feeds the
    // canonical atsFormatting compliance check with real evidence instead of leaving it to fall
    // back to structural-only signals. Absence of a rendered file is not itself a violation (see
    // instructionCompliance.ts's atsFormatting reasoning); only genuine validator findings count.
    let docxValidation: ResumeReviewerInput["docxValidation"];
    if (fs.existsSync(iterResumeDocx) || fs.existsSync(iterCoverDocx)) {
      docxValidation = {};
      if (fs.existsSync(iterResumeDocx)) {
        docxValidation.resume = await safeValidateDocx(iterResumeDocx, "resume");
      }
      if (fs.existsSync(iterCoverDocx)) {
        docxValidation.coverLetter = await safeValidateDocx(iterCoverDocx, "coverLetter");
      }
    }

    // Load the immediately prior iteration's resume (when one exists) so the deep-rewrite check
    // can compare against genuine before/after content rather than only JD-orientation heuristics.
    let priorResume: ResumeContent | undefined;
    if (iterationNumber > 1) {
      const priorResumePath = path.join(getIterationDirectory(location, iterationNumber - 1), "resume_content.json");
      if (fs.existsSync(priorResumePath)) {
        try {
          priorResume = JSON.parse(fs.readFileSync(priorResumePath, "utf-8")) as ResumeContent;
        } catch {
          // Fall back to undefined if unparseable
        }
      }
    }

    // 1. Invoke Reviewer
    const reviewer = input.reviewer ?? new DeterministicResumeReviewer();
    const resumeDocxPath = input.resumeDocxPath ?? iterResumeDocx;
    const jobDescriptionPath = path.join(workspaceDir, "job_description.md");
    // Stage 21 — the job's OWN posted title is P0 role identity for the JD Priority Matrix/Positioning
    // Engine; never derived from jobRequirements or the resume itself (see types.ts's own doc comment
    // on ResumeReviewerInput.targetRoleTitle).
    const targetRoleTitle = getJobByDedupeKey(workflow.dedupe_key)?.title;

    const reviewerInput: ResumeReviewerInput = {
      applicationId: workflow.application_id,
      candidateId,
      workflowId: workflow.id,
      iterationNumber,
      resumePath: resumeDocxPath,
      jobDescriptionPath,
      resume,
      jobRequirements,
      masterResumeProfile,
      coverLetter: input.coverLetter,
      priorResume,
      docxValidation,
      targetRoleTitle,
    };

    const { review: rawReview } = await reviewer.review(reviewerInput);
    const review = structuredResumeReviewSchema.parse(rawReview);

    // 2. Transition REVIEW_RUNNING -> REVIEW_COMPLETED
    transitionWorkflowStatus(candidateId, workflowId, "REVIEW_COMPLETED", {
      latestOverallScore: review.overallScore,
    });

    // 3. Write remaining iteration artifacts to disk
    // Persist authoritative structured content JSON
    const resumeJsonPath = path.join(iterDir, "resume_content.json");
    fs.writeFileSync(resumeJsonPath, JSON.stringify(resume, null, 2), "utf-8");

    const reviewJsonPath = path.join(iterDir, "review.json");
    fs.writeFileSync(reviewJsonPath, JSON.stringify(review, null, 2), "utf-8");

    const feedbackMarkdown = renderReviewFeedbackMarkdown(review);
    const reviewFeedbackPath = path.join(iterDir, "review_feedback.md");
    fs.writeFileSync(reviewFeedbackPath, feedbackMarkdown, "utf-8");

    outputFiles.push("resume_content.json", "review.json", "review_feedback.md");

    if (input.coverLetter) {
      const coverJsonPath = path.join(iterDir, "cover_letter_content.json");
      fs.writeFileSync(coverJsonPath, JSON.stringify(input.coverLetter, null, 2), "utf-8");
      outputFiles.push("cover_letter_content.json");
    }

    // 4. Persist immutable iteration record in DB
    const iterationRow = createResumeQualityIteration(candidateId, workflowId, iterationNumber, {
      outputFiles,
      overallScore: review.overallScore,
      atsScore: review.atsScore,
      keywordAlignmentScore: review.keywordAlignmentScore,
      truthfulnessScore: review.truthfulnessScore,
      architectureConsistencyScore: review.architectureConsistencyScore,
      recruiterReadabilityScore: review.recruiterReadabilityScore,
      formattingScore: review.formattingScore,
      blockingIssueCount: review.blockingIssues.length,
      reviewJson: JSON.stringify(review),
    });

    // 5. Evaluate Quality Gate & Transition Workflow
    const gateOutcome = evaluateQualityGate(review, iterationNumber, workflow.max_iterations);

    if (gateOutcome === "READY") {
      const updatedWorkflow = transitionWorkflowStatus(candidateId, workflowId, "READY", {
        latestOverallScore: review.overallScore,
        finalApprovedIteration: iterationNumber,
      });

      // Populate final artifacts directory with safe candidate filenames
      const finalDir = getFinalDirectory(location);
      fs.mkdirSync(finalDir, { recursive: true });

      const firstName = candidate.first_name || "Candidate";
      const finalResumeName = finalResumeFilename(firstName);
      const finalCoverName = finalCoverLetterFilename(firstName);

      let finalResumePath: string | undefined;
      if (fs.existsSync(iterResumeDocx)) {
        finalResumePath = path.join(finalDir, finalResumeName);
        fs.copyFileSync(iterResumeDocx, finalResumePath);
      }

      let finalCoverPath: string | undefined;
      if (fs.existsSync(iterCoverDocx)) {
        finalCoverPath = path.join(finalDir, finalCoverName);
        fs.copyFileSync(iterCoverDocx, finalCoverPath);
      }

      const finalFeedbackPath = path.join(finalDir, "resume_review_feedback.md");
      fs.writeFileSync(finalFeedbackPath, feedbackMarkdown, "utf-8");

      const finalResumeJson = path.join(finalDir, "resume_content.json");
      fs.writeFileSync(finalResumeJson, JSON.stringify(resume, null, 2), "utf-8");

      if (input.coverLetter) {
        const finalCoverJson = path.join(finalDir, "cover_letter_content.json");
        fs.writeFileSync(finalCoverJson, JSON.stringify(input.coverLetter, null, 2), "utf-8");
      }

      // Machine-readable copy of the final approved review — same content as the iteration's own
      // review.json, snapshotted into final/ so a human or downstream tool never needs to reach
      // back into an iteration directory to see what was actually approved.
      fs.writeFileSync(path.join(finalDir, "careerops_review.json"), JSON.stringify(review, null, 2), "utf-8");

      // The external writer's own self-reported guardrail self-check, when one was supplied —
      // provenance/audit trail only; never consulted by evaluateQualityGate.
      if (input.writerValidation) {
        fs.writeFileSync(path.join(finalDir, "writer_validation.json"), JSON.stringify(input.writerValidation, null, 2), "utf-8");
      }

      // Snapshot of the exact canonical instruction text/version/hash this approval was reviewed
      // against, so a later change to the canonical standard can never retroactively blur what a
      // past READY approval actually satisfied.
      const instructionSnapshot = [
        `# Canonical Instruction Snapshot`,
        ``,
        `Instruction version: ${INSTRUCTION_VERSION}`,
        `Instruction hash (SHA-256): ${INSTRUCTION_HASH}`,
        `Snapshotted at approval of workflow ${workflowId}, iteration ${iterationNumber}.`,
        ``,
        `---`,
        ``,
        CANONICAL_TAILORING_INSTRUCTIONS,
      ].join("\n");
      fs.writeFileSync(path.join(finalDir, "instruction_snapshot.md"), instructionSnapshot, "utf-8");

      // Deterministic, template-based cold follow-up email — never AI-generated, never inserted
      // into the resume/cover letter, never wired to any recruiter-automation/sending feature.
      const coldEmailJob = getJobByDedupeKey(workflow.dedupe_key);
      const coldEmailCompany = coldEmailJob ? getCompany(coldEmailJob.company_id) : undefined;
      const coldFollowUpEmail = generateColdFollowUpEmail({
        resume,
        companyName: coldEmailCompany?.name ?? "the company",
        jobTitle: coldEmailJob?.title,
      });
      fs.writeFileSync(path.join(finalDir, "cold_follow_up_email.md"), coldFollowUpEmail, "utf-8");

      // Phase 9A — mirror the just-approved artifacts into the durable, human-readable applications
      // tree (data/generated/applications/<company-slug>/<position-slug>-<jobId>/). Strictly
      // derivative: it copies bytes that final/ already holds, and it is reachable only from here —
      // inside the READY branch, after evaluateQualityGate has already approved this iteration — so
      // no non-READY workflow has any path to it. Failing to publish never unwinds an approval that
      // genuinely happened: final/ remains the authoritative approved-artifact directory and the
      // workflow stays READY, so the failure is reported on the result instead of thrown.
      //
      // Stage 26 — every reason publication does not happen is now NAMED. Previously the three
      // preconditions below were a single silent `if`: when the job or company row could not be
      // resolved, publication was skipped with no publishedApplication AND no publicationError, so
      // "published successfully" and "never even attempted" were indistinguishable to every caller
      // and to the UI. A READY workflow stays READY either way — final/ remains the authoritative
      // approved-artifact directory — but the failure is now reported instead of swallowed.
      let publishedApplication: PublishedApplication | undefined;
      let publicationError: string | undefined;
      if (!finalResumePath) {
        publicationError =
          `No approved resume DOCX was rendered for iteration ${iterationNumber}; nothing to publish. ` +
          `The approved artifacts remain available in the workflow's final/ directory.`;
      } else if (!coldEmailJob) {
        publicationError =
          `Publication skipped: no job row could be resolved for dedupe_key ${workflow.dedupe_key} ` +
          `(the posting may have been deleted or archived since approval). The approved artifacts ` +
          `remain available in the workflow's final/ directory.`;
      } else if (!coldEmailCompany) {
        publicationError =
          `Publication skipped: no company row could be resolved for company_id ${coldEmailJob.company_id} ` +
          `(job ${coldEmailJob.id}). The approved artifacts remain available in the workflow's final/ directory.`;
      }
      if (finalResumePath && coldEmailJob && coldEmailCompany) {
        try {
          publishedApplication = publishFinalApplicationArtifacts({
            candidateId,
            candidateFirstName: firstName,
            candidateDisplayName: candidate.display_name,
            companyId: coldEmailCompany.id,
            companyName: coldEmailCompany.name,
            jobId: coldEmailJob.id,
            jobTitle: coldEmailJob.title,
            dedupeKey: workflow.dedupe_key,
            applicationId: workflow.application_id,
            tailoringRunId: workflow.tailoring_run_id,
            workflowId: workflow.id,
            workflowStatus: updatedWorkflow.status,
            iterationNumber,
            qualityGateOutcome: gateOutcome,
            overallScore: review.overallScore,
            instructionVersion: INSTRUCTION_VERSION,
            instructionHash: INSTRUCTION_HASH,
            sourceFinalDirectory: finalDir,
            sourceResumePath: finalResumePath,
            sourceCoverLetterPath: finalCoverPath,
            sourceReviewFeedbackPath: finalFeedbackPath,
            publishedAt: new Date().toISOString(),
          });
        } catch (error) {
          publicationError = error instanceof Error ? error.message : String(error);
        }
      }

      // Durable, truthful publication record next to the approved artifacts. The orchestration
      // result carries publishedApplication/publicationError only to its immediate caller, which is
      // gone by the time a human opens the job page — so the GET /quality-workflow route reads THIS
      // file instead of re-deriving (or worse, assuming) a publication outcome. Written for both
      // outcomes on purpose: an absent file means "this workflow predates Stage 26", never
      // "published fine". Paths are stored repo-relative so the record stays portable, matching the
      // discipline the published manifest itself already follows. Never touches finalPublication.ts
      // or anything it wrote — publication itself stays exactly-once and atomic.
      const publicationStatus = {
        schemaVersion: 1 as const,
        status: publishedApplication ? ("PUBLISHED" as const) : ("FAILED" as const),
        recordedAt: new Date().toISOString(),
        iterationNumber,
        directory: publishedApplication ? path.relative(process.cwd(), publishedApplication.directory) : null,
        resume: publishedApplication ? path.relative(process.cwd(), publishedApplication.resumePath) : null,
        coverLetter:
          publishedApplication?.coverLetterPath ? path.relative(process.cwd(), publishedApplication.coverLetterPath) : null,
        reviewFeedback:
          publishedApplication?.reviewFeedbackPath
            ? path.relative(process.cwd(), publishedApplication.reviewFeedbackPath)
            : null,
        error: publicationError ?? null,
      };
      try {
        fs.writeFileSync(path.join(finalDir, "publication_status.json"), JSON.stringify(publicationStatus, null, 2), "utf-8");
      } catch {
        // Recording the outcome must never be able to unwind a genuine approval. A missing status
        // file degrades the UI to "publication state unknown", which is still truthful.
      }

      // Informational workflow-status snapshot (see WorkflowStatusFile) — READY/COMPLETED, nothing
      // further to wait on.
      const workflowStatusFile: WorkflowStatusFile = {
        candidateId,
        applicationId: workflow.application_id,
        jobId: coldEmailJob?.id ?? null,
        tailoringRunId: workflow.tailoring_run_id,
        workflowId: workflow.id,
        currentIteration: iterationNumber,
        targetIteration: iterationNumber,
        maxIterations: workflow.max_iterations,
        workflowStatus: "READY",
        latestOverallScore: review.overallScore,
        qualityGateResult: gateOutcome,
        waitingFor: "COMPLETED",
        createdAt: workflow.created_at,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(finalDir, "workflow_status.json"), JSON.stringify(workflowStatusFile, null, 2), "utf-8");

      return {
        workflow: updatedWorkflow,
        iteration: iterationRow,
        review,
        qualityGateOutcome: gateOutcome,
        status: "READY",
        iterationNumber,
        outputFiles,
        iterationDirectory: iterDir,
        finalDirectory: finalDir,
        finalArtifacts: {
          resumePath: finalResumePath,
          coverLetterPath: finalCoverPath,
          reviewFeedbackPath: finalFeedbackPath,
        },
        publishedApplication,
        publicationError,
        requiredCorrections: review.requiredCorrections,
        failureReason: null,
      };
    }

    if (gateOutcome === "IMPROVEMENT_NEEDED") {
      const updatedWorkflow = transitionWorkflowStatus(candidateId, workflowId, "IMPROVEMENT_RUNNING", {
        latestOverallScore: review.overallScore,
      });

      return {
        workflow: updatedWorkflow,
        iteration: iterationRow,
        review,
        qualityGateOutcome: gateOutcome,
        status: "IMPROVEMENT_RUNNING",
        iterationNumber,
        outputFiles,
        iterationDirectory: iterDir,
        requiredCorrections: review.requiredCorrections,
        failureReason: null,
      };
    }

    // gateOutcome === "NEEDS_HUMAN_REVIEW"
    const failureReason = `Quality gate failed after reaching max iterations (${workflow.max_iterations}); human review required.`;
    const updatedWorkflow = transitionWorkflowStatus(candidateId, workflowId, "FAILED", {
      latestOverallScore: review.overallScore,
      failureReason,
    });

    // Best-effort: preserve the safest of the exhausted attempts for human review. The workflow's own
    // FAILED transition above is already authoritative and complete regardless of what happens here —
    // a failure generating this convenience package must never be treated as a failure of the
    // workflow itself (see humanReviewPackage.ts's own atomic-write guarantee for why a crash here
    // can't leave a half-written package either).
    let humanReviewPackage: ResumeQualityOrchestrationResult["humanReviewPackage"];
    try {
      const pkg = generateHumanReviewPackage(candidateId, workflowId);
      if (pkg) humanReviewPackage = { iterationNumber: pkg.iterationNumber, directory: pkg.directory };
    } catch {
      // Swallowed deliberately — the FAILED transition above already succeeded and remains the
      // authoritative outcome; the human-review package is a convenience, not a requirement.
    }

    // Stage 28 — a workflow that exhausted its two content attempts is not automatically unusable.
    // When every ABSOLUTE truthfulness/safety guardrail holds and only optimisation fell short, the
    // safest attempt is published as an explicitly-labelled human-review package. Phase 9A's READY
    // publication is untouched: this writes to a separate `human-review/` subdirectory and never
    // claims READY or approved. Best-effort for the same reason the human-review package above is —
    // the FAILED transition is already authoritative.
    let safeBestAttempt: ResumeQualityOrchestrationResult["safeBestAttempt"];
    try {
      const attempts = listResumeQualityIterations(candidateId, workflowId)
        .filter((it: ResumeQualityIterationRow) => Boolean(it.review_json))
        .map((it: ResumeQualityIterationRow) => ({
          iterationNumber: it.iteration_number,
          review: JSON.parse(it.review_json as string) as StructuredResumeReview,
        }));
      const disposition = determineFinalDisposition(attempts);
      const safeAttemptJob = getJobByDedupeKey(workflow.dedupe_key);
      const safeAttemptCompany = safeAttemptJob ? getCompany(safeAttemptJob.company_id) : undefined;
      if (
        disposition.disposition === "SAFE_BEST_ATTEMPT" &&
        disposition.selectedIterationNumber !== null &&
        safeAttemptJob &&
        safeAttemptCompany
      ) {
        const selectedDir = getIterationDirectory(location, disposition.selectedIterationNumber);
        const published = publishSafeBestAttempt({
          disposition,
          candidateId,
          candidateName: candidate.display_name,
          candidateFirstName: candidate.first_name || "Candidate",
          companyId: safeAttemptCompany.id,
          companyName: safeAttemptCompany.name,
          jobId: safeAttemptJob.id,
          jobTitle: safeAttemptJob.title,
          workflowId,
          tailoringRunId: workflow.tailoring_run_id,
          sourceResumePath: path.join(selectedDir, "Resume.docx"),
          sourceCoverLetterPath: path.join(selectedDir, "CoverLetter.docx"),
          sourceReviewFeedbackPath: path.join(selectedDir, "review_feedback.md"),
        });
        safeBestAttempt = {
          directory: published.directory,
          selectedIterationNumber: disposition.selectedIterationNumber,
          optimizationScore: disposition.optimizationScore,
        };
      }
    } catch {
      // Swallowed for the same reason as the human-review package: a convenience publication can
      // never unwind or alter the authoritative FAILED outcome.
    }

    return {
      workflow: updatedWorkflow,
      iteration: iterationRow,
      review,
      qualityGateOutcome: gateOutcome,
      status: "FAILED",
      iterationNumber,
      outputFiles,
      iterationDirectory: iterDir,
      requiredCorrections: review.requiredCorrections,
      failureReason,
      humanReviewPackage,
      safeBestAttempt,
    };
  } catch (err) {
    try {
      const current = getResumeQualityWorkflow(candidateId, workflowId);
      if (current && (current.status === "WRITER_RUNNING" || current.status === "REVIEW_RUNNING" || current.status === "REVIEW_COMPLETED")) {
        const failureReason = err instanceof Error ? err.message : String(err);
        transitionWorkflowStatus(candidateId, workflowId, "FAILED", { failureReason });
      }
    } catch {
      // Ignore transition error in catch block to rethrow original error
    }
    throw err;
  }
}

/** Alias for executeResumeQualityIteration */
export const runDeterministicQualityReview = executeResumeQualityIteration;

/**
 * Creates a new quality workflow in CREATED status and executes iteration 1.
 */
export async function startAndExecuteResumeQualityWorkflow(
  input: StartAndExecuteResumeQualityWorkflowInput
): Promise<ResumeQualityOrchestrationResult> {
  const workflow = createResumeQualityWorkflow({
    candidateId: input.candidateId,
    applicationId: input.applicationId,
    tailoringRunId: input.tailoringRunId,
    dedupeKey: input.dedupeKey,
    maxIterations: input.maxIterations,
  });

  return executeResumeQualityIteration({
    candidateId: input.candidateId,
    workflowId: workflow.id,
    resume: input.resume,
    coverLetter: input.coverLetter,
    resumeDocxPath: input.resumeDocxPath,
    coverLetterDocxPath: input.coverLetterDocxPath,
    jobRequirements: input.jobRequirements,
    masterResumeProfile: input.masterResumeProfile,
    reviewer: input.reviewer,
  });
}

/**
 * Assembles the authoritative ResumeWriterInput package for an improvement iteration.
 */
export function buildResumeWriterInput(candidateId: number, workflowId: number): ResumeWriterInput {
  const workflow = getResumeQualityWorkflow(candidateId, workflowId);
  if (!workflow) {
    throw new ResumeQualityWorkflowNotFoundError(candidateId, workflowId);
  }

  const tailoringRun = getTailoringRun(candidateId, workflow.tailoring_run_id);
  if (!tailoringRun) {
    throw new ResumeQualityOrchestrationError(
      "TAILORING_RUN_NOT_FOUND",
      `Tailoring run ${workflow.tailoring_run_id} not found for candidate ${candidateId}`
    );
  }
  if (tailoringRun.dedupe_key !== workflow.dedupe_key) {
    throw new ResumeQualityOrchestrationError(
      "IDENTITY_MISMATCH",
      `Tailoring run dedupe_key (${tailoringRun.dedupe_key}) does not match workflow dedupe_key (${workflow.dedupe_key})`
    );
  }

  const appState = getCandidateJobState(candidateId, workflow.dedupe_key);
  if (appState && appState.id !== workflow.application_id) {
    throw new ResumeQualityOrchestrationError(
      "APPLICATION_MISMATCH",
      `Application ID mismatch: candidate_job_state id is ${appState.id}, workflow application_id is ${workflow.application_id}`
    );
  }

  const location: QualityWorkflowLocation = {
    candidateId,
    dedupeKey: workflow.dedupe_key,
    runId: workflow.tailoring_run_id,
    workflowId: workflow.id,
  };

  const wsPkg = buildWorkspacePackage({
    candidateId,
    applicationId: workflow.application_id,
    dedupeKey: workflow.dedupe_key,
    tailoringRunId: workflow.tailoring_run_id,
    workflowId: workflow.id,
    runId: workflow.tailoring_run_id,
    selectedTrack: null,
    phase2Context: null,
  });

  let priorIteration: ResumeWriterInput["priorIteration"] = null;
  let currentResume: ResumeContent | undefined;
  let currentCoverLetter: CoverLetterContent | undefined;
  let latestReview: StructuredResumeReview | undefined;
  let requiredCorrections: RequiredCorrection[] | undefined;
  let blockingIssues: string[] | undefined;
  let blockingFailures: BlockingFailure[] | undefined;
  let complianceCorrections: RequiredCorrection[] | undefined;
  /** Stage 28 — the deterministic repair scope for this attempt, derived from the PRIOR review. */
  let repairPlan: RepairPlan | undefined;

  if (workflow.current_iteration > 0) {
    const priorIterNum = workflow.current_iteration;
    const priorIterDir = getIterationDirectory(location, priorIterNum);
    const priorResumeDocx = path.join(priorIterDir, "Resume.docx");
    const priorResumeJson = path.join(priorIterDir, "resume_content.json");
    const priorFeedbackMd = path.join(priorIterDir, "review_feedback.md");
    const priorReviewJson = path.join(priorIterDir, "review.json");
    const priorCoverJson = path.join(priorIterDir, "cover_letter_content.json");

    priorIteration = {
      iterationNumber: priorIterNum,
      resumePath: fs.existsSync(priorResumeDocx) ? priorResumeDocx : priorResumeJson,
      reviewFeedbackPath: priorFeedbackMd,
    };

    if (fs.existsSync(priorResumeJson)) {
      try {
        currentResume = JSON.parse(fs.readFileSync(priorResumeJson, "utf-8")) as ResumeContent;
      } catch {
        // Fall back to undefined if unparseable
      }
    }
    if (fs.existsSync(priorCoverJson)) {
      try {
        currentCoverLetter = JSON.parse(fs.readFileSync(priorCoverJson, "utf-8")) as CoverLetterContent;
      } catch {
        // Fall back to undefined if unparseable
      }
    }
    if (fs.existsSync(priorReviewJson)) {
      try {
        latestReview = JSON.parse(fs.readFileSync(priorReviewJson, "utf-8")) as StructuredResumeReview;
        requiredCorrections = latestReview.requiredCorrections;
        blockingIssues = latestReview.blockingIssues;
        // Stage 26 — without this the writer never learns why it was actually rejected; see
        // blockingFailuresSection in reviewFeedback.ts.
        blockingFailures = latestReview.blockingFailures;
        // Stage 26B — the same completeness problem for compliance: gate condition 6 requires ALL 22
        // checks to PASS, but only hard-gate ones ever became corrections, so a blocking soft-gate
        // REVIEW reached the writer as "None identified".
        complianceCorrections = latestReview.instructionCompliance
          ? gateBlockingComplianceCorrections(latestReview.instructionCompliance)
          : undefined;
        // Stage 28 — decided here, from CareerOps' own review, never by the writer. A narrow scope
        // means a narrower REWRITE only; the reconstructed pair is still fully re-reviewed.
        repairPlan = planRepairScope(latestReview);
      } catch {
        // Fall back to undefined if unparseable
      }
    }
  }

  let jobRequirements: RequirementUnit[] | undefined;
  if (wsPkg.extractedJobRequirementsPath && fs.existsSync(wsPkg.extractedJobRequirementsPath)) {
    try {
      const rawReqs = JSON.parse(fs.readFileSync(wsPkg.extractedJobRequirementsPath, "utf-8"));
      if (Array.isArray(rawReqs)) {
        jobRequirements = rawReqs as RequirementUnit[];
      }
    } catch {
      // Fall back to undefined if unparseable
    }
  }

  let jobDescriptionMarkdown: string | undefined;
  if (wsPkg.jobDescriptionPath && fs.existsSync(wsPkg.jobDescriptionPath)) {
    try {
      jobDescriptionMarkdown = fs.readFileSync(wsPkg.jobDescriptionPath, "utf-8");
    } catch {
      // Fall back to undefined if unparseable
    }
  }

  const profileRes = loadCandidateProfile(candidateId);
  const masterProfile = profileRes.status === "ok" ? profileRes.profile : undefined;

  return {
    applicationId: workflow.application_id,
    candidateId,
    tailoringRunId: workflow.tailoring_run_id,
    workflowId: workflow.id,
    jobDescriptionPath: wsPkg.jobDescriptionPath,
    extractedJobRequirementsPath: fs.existsSync(wsPkg.extractedJobRequirementsPath)
      ? wsPkg.extractedJobRequirementsPath
      : null,
    masterResumePath: wsPkg.masterResumePath,
    masterSkillsInventoryPath: wsPkg.masterSkillsInventoryPath,
    tailoringInstructionsPath: wsPkg.tailoringInstructionsPath,
    selectedTrack: wsPkg.selectedTrack,
    priorIteration,
    currentResume,
    currentCoverLetter,
    latestReview,
    requiredCorrections,
    blockingIssues,
    blockingFailures,
    complianceCorrections,
    repairPlan,
    // Stage 26B — the canonical contact source, never the previous resume (which, for a workflow
    // predating this, holds the fabricated placeholder values) and never a guess.
    candidateContact: resolveCandidateContact(candidateId).contact,
    dedupeKey: workflow.dedupe_key,
    iterationNumber: workflow.current_iteration + 1,
    masterProfile,
    jobRequirements,
    jobDescriptionMarkdown,
  };
}

/**
 * Executes a single resume quality improvement iteration (Stage 10).
 *
 * Reads prior iteration feedback, invokes ResumeWriterAgent to produce improved content,
 * and drives the next deterministic review & gate evaluation.
 */
export async function executeResumeImprovementIteration(
  input: ExecuteResumeImprovementIterationInput
): Promise<ResumeQualityOrchestrationResult> {
  const { candidateId, workflowId, writer } = input;

  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    throw new ResumeQualityOrchestrationError("INVALID_CANDIDATE_ID", `Invalid candidateId: ${candidateId}`);
  }
  if (!Number.isInteger(workflowId) || workflowId <= 0) {
    throw new ResumeQualityOrchestrationError("INVALID_WORKFLOW_ID", `Invalid workflowId: ${workflowId}`);
  }
  if (!writer || typeof writer.generate !== "function") {
    throw new ResumeQualityOrchestrationError("INVALID_WRITER_AGENT", "A valid ResumeWriterAgent is required");
  }

  const candidate = getCandidate(candidateId);
  if (!candidate) {
    throw new ResumeQualityOrchestrationError("CANDIDATE_NOT_FOUND", `Candidate ${candidateId} not found`);
  }
  if (candidate.status !== "active") {
    throw new ResumeQualityOrchestrationError("NOT_ACTIVE_CANDIDATE", `Candidate ${candidateId} is not active`);
  }

  const workflow = getResumeQualityWorkflow(candidateId, workflowId);
  if (!workflow) {
    throw new ResumeQualityWorkflowNotFoundError(candidateId, workflowId);
  }

  if (workflow.status === "READY" || workflow.status === "FAILED") {
    throw new ResumeQualityOrchestrationError(
      "WORKFLOW_ALREADY_TERMINAL",
      `Cannot execute improvement iteration on terminal workflow ${workflowId} (status: ${workflow.status})`
    );
  }

  if (workflow.current_iteration >= workflow.max_iterations) {
    throw new IterationExceedsMaxError(workflowId, workflow.current_iteration + 1, workflow.max_iterations);
  }

  // Stage 26 — a workflow that has never run an iteration is a legitimate writer target when, and
  // only when, it is still CREATED: that is the "human approved this, nothing has been written yet"
  // state, and the writer's output BECOMES iteration 1. (Before Stage 26 the POST route filled that
  // slot with a synthesized placeholder resume so this guard could stay absolute; that placeholder
  // fabricated contact details and bullets and consumed a genuine quality iteration.) Any OTHER
  // status at current_iteration 0 is still a real inconsistency and is still refused — and
  // executeResumeQualityIteration below independently re-validates every status transition through
  // the unchanged state machine, so this relaxation cannot open an illegal path.
  if (workflow.current_iteration === 0 && workflow.status !== "CREATED") {
    throw new ResumeQualityOrchestrationError(
      "INVALID_WORKFLOW_STATE",
      `Cannot execute improvement iteration on a workflow that has not executed iteration 1 (current status: ${workflow.status})`
    );
  }

  const writerInput = buildResumeWriterInput(candidateId, workflowId);

  if (input.jobRequirements) {
    writerInput.jobRequirements = input.jobRequirements;
  }
  if (input.masterResumeProfile) {
    writerInput.masterProfile = input.masterResumeProfile;
  }

  // 1. Invoke writer agent with error handling
  let writerOutput: ResumeWriterOutput;
  try {
    writerOutput = await writer.generate(writerInput);
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : String(err);
    transitionWorkflowStatus(candidateId, workflowId, "FAILED", { failureReason });
    throw err;
  }

  if (!writerOutput || !writerOutput.resume) {
    const failureReason = "Writer agent returned invalid or empty resume output";
    transitionWorkflowStatus(candidateId, workflowId, "FAILED", { failureReason });
    throw new ResumeQualityOrchestrationError("INVALID_WRITER_OUTPUT", failureReason);
  }

  // 2. Transition and drive next review iteration
  return executeResumeQualityIteration({
    candidateId,
    workflowId,
    resume: writerOutput.resume,
    coverLetter: writerOutput.coverLetter ?? writerInput.currentCoverLetter,
    resumeDocxPath: input.resumeDocxPath,
    coverLetterDocxPath: input.coverLetterDocxPath,
    jobRequirements: input.jobRequirements ?? writerInput.jobRequirements,
    masterResumeProfile: input.masterResumeProfile ?? writerInput.masterProfile,
    reviewer: input.reviewer,
    writerValidation: writerOutput.writerValidation,
  });
}

function buildLoopResult(
  candidateId: number,
  jobId: number | null,
  workflow: ResumeQualityWorkflowRow,
  latestResult: ResumeQualityOrchestrationResult | undefined,
  history: ResumeQualityOrchestrationResult[]
): ResumeQualityLoopResult {
  return {
    candidateId,
    applicationId: workflow.application_id,
    jobId,
    tailoringRunId: workflow.tailoring_run_id,
    workflowId: workflow.id,
    finalIteration: workflow.current_iteration,
    workflowStatus: workflow.status,
    qualityGateOutcome: latestResult ? latestResult.qualityGateOutcome : "NEEDS_HUMAN_REVIEW",
    overallScore: latestResult ? latestResult.review.overallScore : (workflow.latest_overall_score ?? 0),
    iterationsCompleted: history.length,
    requiredCorrections: latestResult ? latestResult.requiredCorrections : [],
    finalOutputFiles: latestResult?.finalArtifacts ? latestResult.outputFiles : undefined,
    finalDirectory: latestResult?.finalDirectory,
    finalArtifacts: latestResult?.finalArtifacts,
    failureReason: workflow.failure_reason,
    latestReview: latestResult ? latestResult.review : ({} as StructuredResumeReview),
    history: history.map((h) => ({
      iterationNumber: h.iterationNumber,
      overallScore: h.review.overallScore,
      status: h.status,
      qualityGateOutcome: h.qualityGateOutcome,
      outputFiles: h.outputFiles,
    })),
  };
}

/**
 * Runs the end-to-end multi-iteration resume quality improvement loop (Stage 10).
 *
 * Drives initial review (iteration 1), checks the quality gate, and if improvements are needed,
 * invokes the ResumeWriterAgent to generate and review subsequent iterations up to max_iterations.
 */
export async function runResumeQualityLoop(
  input: RunResumeQualityLoopInput
): Promise<ResumeQualityLoopResult> {
  const { candidateId, workflowId } = input;

  let workflow = getResumeQualityWorkflow(candidateId, workflowId);
  if (!workflow) {
    throw new ResumeQualityWorkflowNotFoundError(candidateId, workflowId);
  }

  const tailoringRun = getTailoringRun(candidateId, workflow.tailoring_run_id);
  if (!tailoringRun) {
    throw new ResumeQualityOrchestrationError(
      "TAILORING_RUN_NOT_FOUND",
      `Tailoring run ${workflow.tailoring_run_id} not found for candidate ${candidateId}`
    );
  }

  const history: ResumeQualityOrchestrationResult[] = [];

  // Step A: Iteration 1 execution if starting from CREATED
  if (workflow.current_iteration === 0) {
    if (!input.initialResume) {
      throw new ResumeQualityOrchestrationError(
        "INVALID_INPUT",
        "initialResume is required to execute iteration 1 of resume quality workflow"
      );
    }

    const iter1Res = await executeResumeQualityIteration({
      candidateId,
      workflowId,
      resume: input.initialResume,
      coverLetter: input.initialCoverLetter,
      resumeDocxPath: input.initialResumeDocxPath,
      coverLetterDocxPath: input.initialCoverLetterDocxPath,
      jobRequirements: input.jobRequirements,
      masterResumeProfile: input.masterResumeProfile,
      reviewer: input.reviewer,
    });

    history.push(iter1Res);
    workflow = iter1Res.workflow;

    if (iter1Res.status === "READY" || iter1Res.status === "FAILED") {
      return buildLoopResult(candidateId, tailoringRun.job_id, workflow, iter1Res, history);
    }
  }

  // Step B: Improvement loops (iterations 2..max)
  if (workflow.status === "IMPROVEMENT_RUNNING") {
    if (!input.writer) {
      const latestRes = history[history.length - 1];
      return buildLoopResult(candidateId, tailoringRun.job_id, workflow, latestRes, history);
    }

    while (workflow.status === "IMPROVEMENT_RUNNING" && workflow.current_iteration < workflow.max_iterations) {
      const improvementRes = await executeResumeImprovementIteration({
        candidateId,
        workflowId,
        writer: input.writer,
        reviewer: input.reviewer,
        jobRequirements: input.jobRequirements,
        masterResumeProfile: input.masterResumeProfile,
        resumeDocxPath: input.initialResumeDocxPath,
        coverLetterDocxPath: input.initialCoverLetterDocxPath,
      });

      history.push(improvementRes);
      workflow = improvementRes.workflow;

      if (improvementRes.status === "READY" || improvementRes.status === "FAILED") {
        break;
      }
    }
  }

  const latestRes = history[history.length - 1];
  return buildLoopResult(candidateId, tailoringRun.job_id, workflow, latestRes, history);
}

/**
 * Creates a new quality workflow and drives the full improvement loop to completion.
 */
export async function startAndRunResumeQualityLoop(
  input: StartAndRunResumeQualityLoopInput
): Promise<ResumeQualityLoopResult> {
  const workflow = createResumeQualityWorkflow({
    candidateId: input.candidateId,
    applicationId: input.applicationId,
    tailoringRunId: input.tailoringRunId,
    dedupeKey: input.dedupeKey,
    maxIterations: input.maxIterations,
  });

  return runResumeQualityLoop({
    candidateId: input.candidateId,
    workflowId: workflow.id,
    initialResume: input.initialResume,
    initialCoverLetter: input.initialCoverLetter,
    initialResumeDocxPath: input.initialResumeDocxPath,
    initialCoverLetterDocxPath: input.initialCoverLetterDocxPath,
    jobRequirements: input.jobRequirements,
    masterResumeProfile: input.masterResumeProfile,
    reviewer: input.reviewer,
    writer: input.writer,
  });
}
