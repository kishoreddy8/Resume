import { z } from "zod";
import type { CoverLetterContent, ResumeContent } from "../../../tools/tailoring-engine/types";

/**
 * Phase 3 Stage 7 — data contracts for the future multi-stage AI resume quality pipeline
 * (Application → Tailoring Run → AI Writer → AI Reviewer → Improvement → Reviewer → Final Approved
 * Resume). FOUNDATION ONLY: nothing in this module calls an AI provider, and nothing in this module
 * is wired into src/lib/tailoringExecution.ts or the execution bridge — see resume_quality_workflows'
 * own schema.sql comment for the full identity/lifecycle design record.
 *
 * The existing Resume Tailoring System Instructions (SKILL.md) remain the sole authority on tailoring
 * methodology. This pipeline evaluates and iterates on OUTPUT quality against those instructions —
 * it never redefines or replaces them.
 */

// --- Workflow status ------------------------------------------------------------------------------

/** Mirrors resume_quality_workflows.status exactly — see stateMachine.ts for the legal transition
 *  graph between these. No "execute the AI" step exists yet; this is the state shape only. */
export type WorkflowStatus =
  | "CREATED"
  | "WRITER_RUNNING"
  | "WRITER_COMPLETED"
  | "REVIEW_RUNNING"
  | "REVIEW_COMPLETED"
  | "IMPROVEMENT_RUNNING"
  | "READY"
  | "FAILED";

export const WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  "CREATED",
  "WRITER_RUNNING",
  "WRITER_COMPLETED",
  "REVIEW_RUNNING",
  "REVIEW_COMPLETED",
  "IMPROVEMENT_RUNNING",
  "READY",
  "FAILED",
] as const;

/** A workflow that hasn't met the quality gate after DEFAULT_MAX_ITERATIONS lands in FAILED with a
 *  failure_reason explaining it needs human review — there is no separate terminal status for that
 *  case; the 8 statuses above are the complete, deliberately-fixed set (see the Stage 7 spec). */
export const DEFAULT_MAX_ITERATIONS = 3;

// --- Structured review contract (Section 6) --------------------------------------------------------

export const CORRECTION_PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export type CorrectionPriority = (typeof CORRECTION_PRIORITIES)[number];

export interface RequiredCorrection {
  priority: CorrectionPriority;
  description: string;
}

/** The authoritative machine-readable review format a future ResumeReviewerAgent produces. A
 *  human-readable resume_review_feedback.md is rendered FROM this, never the other way around — this
 *  is deliberately the source of truth, matching "Prefer structured JSON as the authoritative
 *  machine-readable review format" from the Stage 7 spec. A numeric score alone can never imply
 *  READY — see qualityGate.ts, which also requires zero blockingIssues and perfect
 *  truthfulness/architecture scores regardless of overallScore. */
export interface StructuredResumeReview {
  overallScore: number; // 0-100
  atsScore: number;
  keywordAlignmentScore: number;
  truthfulnessScore: number;
  architectureConsistencyScore: number;
  recruiterReadabilityScore: number;
  formattingScore: number;

  missingRequiredSkills: string[];
  incorrectTechnologyUsage: string[];
  genericBullets: string[];
  missingImpactEvidence: string[];
  summaryIssues: string[];
  skillsOrderingIssues: string[];
  truthfulnessIssues: string[];
  blockingIssues: string[];
  requiredCorrections: RequiredCorrection[];
}

const scoreSchema = z.number().min(0).max(100);

export const structuredResumeReviewSchema = z
  .object({
    overallScore: scoreSchema,
    atsScore: scoreSchema,
    keywordAlignmentScore: scoreSchema,
    truthfulnessScore: scoreSchema,
    architectureConsistencyScore: scoreSchema,
    recruiterReadabilityScore: scoreSchema,
    formattingScore: scoreSchema,
    missingRequiredSkills: z.array(z.string()),
    incorrectTechnologyUsage: z.array(z.string()),
    genericBullets: z.array(z.string()),
    missingImpactEvidence: z.array(z.string()),
    summaryIssues: z.array(z.string()),
    skillsOrderingIssues: z.array(z.string()),
    truthfulnessIssues: z.array(z.string()),
    blockingIssues: z.array(z.string()),
    requiredCorrections: z.array(
      z.object({
        priority: z.enum(CORRECTION_PRIORITIES),
        description: z.string().min(1),
      })
    ),
  })
  .strict();

// --- Provider-independent agent contracts (Section 8) -----------------------------------------------
//
// No Anthropic/OpenAI/Codex SDK import anywhere in this file. Future implementations
// (ClaudeResumeWriter, OpenAIResumeWriter, LocalResumeWriter, ...) live elsewhere and import a real
// provider SDK there — this file only defines the shape every implementation must satisfy.

export interface ResumeWriterInput {
  applicationId: number;
  candidateId: number;
  tailoringRunId: number;
  workflowId: number;
  /** Filesystem references, not duplicated content — see ResumeTailoringWorkspacePackage below. */
  jobDescriptionPath: string;
  extractedJobRequirementsPath: string | null;
  masterResumePath: string;
  masterSkillsInventoryPath: string;
  tailoringInstructionsPath: string;
  selectedTrack: string | null;
  /** Present only on an improvement cycle (iteration > 1) — the prior iteration's output and the
   *  reviewer's feedback on it, so the writer can address specific required corrections. */
  priorIteration: { iterationNumber: number; resumePath: string; reviewFeedbackPath: string } | null;
}

export interface ResumeWriterOutput {
  resume: ResumeContent;
  coverLetter: CoverLetterContent;
}

export interface ResumeWriterAgent {
  generate(input: ResumeWriterInput): Promise<ResumeWriterOutput>;
}

export interface ResumeReviewerInput {
  applicationId: number;
  candidateId: number;
  workflowId: number;
  iterationNumber: number;
  resumePath: string;
  jobDescriptionPath: string;
  resume: ResumeContent;
}

export interface ResumeReviewerOutput {
  review: StructuredResumeReview;
}

export interface ResumeReviewerAgent {
  review(input: ResumeReviewerInput): Promise<ResumeReviewerOutput>;
}

// --- Workspace package contract (Section 9) ---------------------------------------------------------

/** Everything a future ResumeWriterAgent/ResumeReviewerAgent implementation needs to do its job,
 *  assembled from EXISTING sources of truth (candidate manifest, tailoring_runs, Phase 2 match
 *  result) — never a copy of large source documents. See workspace.ts's buildWorkspacePackage() for
 *  how this gets constructed from real identity. */
export interface ResumeTailoringWorkspacePackage {
  candidateId: number;
  applicationId: number;
  dedupeKey: string;
  tailoringRunId: number;
  workflowId: number;
  selectedTrack: string | null;
  phase2Context: {
    decision: string;
    recommendedTrack: string | null;
    overallScore: number;
  } | null;
  jobDescriptionPath: string;
  extractedJobRequirementsPath: string;
  masterResumePath: string;
  masterSkillsInventoryPath: string;
  tailoringInstructionsPath: string;
}
