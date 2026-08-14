import fs from "node:fs";
import path from "node:path";
import { getCandidate } from "@/db/queries/candidates";
import { getCandidateJobState } from "@/db/queries/candidateJobState";
import { getTailoringRun } from "@/db/queries/tailoringRuns";
import {
  createResumeQualityIteration,
  createResumeQualityWorkflow,
  getResumeQualityIteration,
  getResumeQualityWorkflow,
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
import { evaluateQualityGate, type QualityGateOutcome } from "./qualityGate";
import { renderReviewFeedbackMarkdown } from "./reviewFeedback";
import { DeterministicResumeReviewer } from "./reviewers/deterministicReviewer";
import { assertValidWorkflowTransition } from "./stateMachine";
import type { CoverLetterContent, ResumeContent } from "../../../tools/tailoring-engine/types";
import {
  structuredResumeReviewSchema,
  type RequiredCorrection,
  type ResumeReviewerAgent,
  type ResumeReviewerInput,
  type StructuredResumeReview,
  type WorkflowStatus,
} from "./types";
import {
  finalCoverLetterFilename,
  finalResumeFilename,
  getFinalDirectory,
  getIterationDirectory,
  getWorkspaceDirectory,
  type QualityWorkflowLocation,
} from "./workspace";

/**
 * Phase 3 Stage 9 — Deterministic Resume Quality Pipeline Orchestrator.
 *
 * Connects the completed Stage 6 tailoring output, Stage 7 quality workflow state machine & persistence,
 * and Stage 8 deterministic reviewer into a fully-validated, reproducible quality orchestration pipeline:
 *
 *   Input Resume (Stage 6)
 *          ↓
 *   State Transition: CREATED -> WRITER_RUNNING -> WRITER_COMPLETED -> REVIEW_RUNNING
 *          ↓
 *   Deterministic Resume Reviewer (Stage 8)
 *          ↓
 *   State Transition: REVIEW_RUNNING -> REVIEW_COMPLETED
 *          ↓
 *   Persist Iteration Artifacts (review.json, review_feedback.md, docx)
 *          ↓
 *   Persist Immutable DB Iteration (resume_quality_iterations)
 *          ↓
 *   Evaluate Quality Gate (evaluateQualityGate)
 *          ↓
 *   Branch:
 *     - READY: Finalize approved artifacts (<FirstName>_Resume.docx, feedback) -> status: READY
 *     - IMPROVEMENT_NEEDED: Transition to IMPROVEMENT_RUNNING -> report required corrections
 *     - NEEDS_HUMAN_REVIEW: Transition to FAILED (with human-review failureReason)
 *
 * Zero external AI provider calls (no Anthropic, OpenAI, or Gemini SDK).
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
 * Validates and drives a resume quality iteration through the deterministic review and quality gate pipeline.
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
    // 1. Invoke Deterministic Reviewer
    const reviewer = input.reviewer ?? new DeterministicResumeReviewer();
    const resumeDocxPath = input.resumeDocxPath ?? path.join(iterDir, "Resume.docx");
    const jobDescriptionPath = path.join(workspaceDir, "job_description.md");

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
    };

    const { review: rawReview } = await reviewer.review(reviewerInput);
    const review = structuredResumeReviewSchema.parse(rawReview);

    // 2. Transition REVIEW_RUNNING -> REVIEW_COMPLETED
    transitionWorkflowStatus(candidateId, workflowId, "REVIEW_COMPLETED", {
      latestOverallScore: review.overallScore,
    });

    // 3. Write iteration artifacts to disk
    fs.mkdirSync(iterDir, { recursive: true });

    const reviewJsonPath = path.join(iterDir, "review.json");
    fs.writeFileSync(reviewJsonPath, JSON.stringify(review, null, 2), "utf-8");

    const feedbackMarkdown = renderReviewFeedbackMarkdown(review);
    const reviewFeedbackPath = path.join(iterDir, "review_feedback.md");
    fs.writeFileSync(reviewFeedbackPath, feedbackMarkdown, "utf-8");

    const outputFiles: string[] = ["review.json", "review_feedback.md"];

    // Copy Resume.docx into iteration dir if available
    const iterResumeDocx = path.join(iterDir, "Resume.docx");
    if (input.resumeDocxPath && fs.existsSync(input.resumeDocxPath)) {
      if (path.resolve(input.resumeDocxPath) !== path.resolve(iterResumeDocx)) {
        fs.copyFileSync(input.resumeDocxPath, iterResumeDocx);
      }
      outputFiles.unshift("Resume.docx");
    } else {
      // Check parent run directory
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

    // Copy CoverLetter.docx into iteration dir if available
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
    };
  } catch (err) {
    // If the workflow was moved to a non-terminal running state, record failure safely
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
