import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePublishedApplicationTarget, type PublishedApplicationTarget } from "./finalPublication";
import { finalCoverLetterFilename, finalResumeFilename } from "./workspace";
import type { FinalDispositionResult } from "./finalDisposition";

/**
 * Stage 28 — publication for a SAFE BEST ATTEMPT.
 *
 * WHAT THIS IS NOT. It is not Phase 9A. Phase 9A publishes a workflow the quality gate APPROVED, and
 * none of its semantics, paths, filenames, manifest fields, or byte-match guarantees are touched by
 * this module — that code is untouched and its acceptance harness still runs against it unchanged.
 *
 * WHAT THIS IS. A workflow can now finish truthful but not perfect: every absolute guardrail holds
 * (no fabrication, no employer contradiction, no cross-artifact contradiction, no placeholder
 * contact, truthfulness and architecture intact) while optimisation sits below the READY bar. Before
 * Stage 28 that outcome produced nothing a human could actually use — the documents existed only
 * inside an iteration directory named by numeric ids. This publishes them where the READY artifacts
 * for the same job would go, in a clearly-labelled `human-review/` subdirectory, so one job's outputs
 * stay together without any chance of being mistaken for approved ones.
 *
 * THE LABELLING RULE IS ABSOLUTE. Nothing written here ever says READY, or PUBLISHED-as-approved. The
 * status file and the manifest both state SAFE_BEST_ATTEMPT and HUMAN_REVIEW_REQUIRED, and the
 * manifest deliberately does NOT reuse PublishedApplicationManifest's `workflowStatus: "READY"`
 * shape, so the two can never be confused by a reader or by code.
 *
 * REFUSES to publish unless the disposition is genuinely SAFE_BEST_ATTEMPT, an attempt was actually
 * selected, and both documents exist on disk (a package that cannot render is not an application
 * package). An unsafe or blocked attempt never becomes usable application artifacts.
 */

export const SAFE_ATTEMPT_SUBDIRECTORY = "human-review";
export const SAFE_ATTEMPT_STATUS_FILENAME = "publication_status.json";
export const SAFE_ATTEMPT_MANIFEST_FILENAME = "manifest.json";

export type SafeAttemptPublicationErrorCode =
  | "NOT_SAFE_BEST_ATTEMPT"
  | "NO_SELECTED_ATTEMPT"
  | "MISSING_RESUME"
  | "MISSING_COVER_LETTER";

export class SafeAttemptPublicationError extends Error {
  constructor(
    public readonly code: SafeAttemptPublicationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SafeAttemptPublicationError";
  }
}

export interface SafeAttemptManifest {
  schemaVersion: 1;
  /** Never "READY". The only two values this file can carry. */
  status: "SAFE_BEST_ATTEMPT";
  humanReviewRequired: true;
  publishedAt: string;
  candidateId: number;
  candidateName: string;
  /** Derived exactly as Phase 9A derives it, so both manifests describe naming the same way. */
  candidateFilePrefix: string;
  companyName: string;
  jobId: number;
  jobTitle: string;
  workflowId: number;
  tailoringRunId: number;
  selectedIterationNumber: number;
  selectionReason: string | null;
  /** Explicitly the OPTIMISATION score, never a pass/fail threshold. */
  optimizationScore: number | null;
  /** True by construction — this file is only ever written when every absolute guardrail passed. */
  safetyPassed: true;
  /** Truthful-but-non-critical findings a human should skim before sending. */
  remainingFindings: string[];
  files: { resume: string; coverLetter: string; reviewFeedback: string | null; manifest: string };
  checksums: { resume: string; coverLetter: string };
}

export interface SafeAttemptPublication {
  directory: string;
  resumePath: string;
  coverLetterPath: string;
  reviewFeedbackPath: string | null;
  manifestPath: string;
  statusPath: string;
  manifest: SafeAttemptManifest;
}

export interface PublishSafeAttemptInput {
  disposition: FinalDispositionResult;
  candidateId: number;
  candidateName: string;
  /**
   * The candidate's first name, exactly as Phase 9A receives it. Filenames are derived from it via
   * the SAME finalResumeFilename/finalCoverLetterFilename helpers the READY publication uses, so the
   * two publications cannot drift apart. Passing a pre-formatted prefix here was the Stage 28 bug:
   * a first name of "Sai Kishore" produced "Sai Kishore_Resume.docx" while READY produced
   * "SaiKishore_Resume.docx", because only Phase 9A ran it through sanitizeNameSegment().
   */
  candidateFirstName: string;
  companyId: number;
  companyName: string;
  jobId: number;
  jobTitle: string;
  workflowId: number;
  tailoringRunId: number;
  /** The selected iteration's own directory — the source of the bytes published here. */
  sourceResumePath: string;
  sourceCoverLetterPath: string;
  sourceReviewFeedbackPath: string | null;
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** The `human-review/` folder beside where this job's READY artifacts would be published. */
export function resolveSafeAttemptTarget(input: {
  companyId: number;
  companyName: string;
  jobId: number;
  jobTitle: string;
}): PublishedApplicationTarget & { safeAttemptDirectory: string } {
  const target = resolvePublishedApplicationTarget(input);
  return { ...target, safeAttemptDirectory: path.join(target.directory, SAFE_ATTEMPT_SUBDIRECTORY) };
}

export function publishSafeBestAttempt(input: PublishSafeAttemptInput): SafeAttemptPublication {
  // Gate first, before any path is computed or any byte is read — publication is a consequence of the
  // verdict, never a way to reach one.
  if (input.disposition.disposition !== "SAFE_BEST_ATTEMPT") {
    throw new SafeAttemptPublicationError(
      "NOT_SAFE_BEST_ATTEMPT",
      `Refusing to publish a human-review package for workflow ${input.workflowId}: disposition is ${input.disposition.disposition}, not SAFE_BEST_ATTEMPT.`
    );
  }
  if (input.disposition.selectedIterationNumber === null) {
    throw new SafeAttemptPublicationError("NO_SELECTED_ATTEMPT", `No attempt was selected for workflow ${input.workflowId}.`);
  }
  // A package whose documents did not render is not an application package.
  if (!fs.existsSync(input.sourceResumePath)) {
    throw new SafeAttemptPublicationError("MISSING_RESUME", `Selected attempt has no rendered resume at ${input.sourceResumePath}.`);
  }
  if (!fs.existsSync(input.sourceCoverLetterPath)) {
    throw new SafeAttemptPublicationError(
      "MISSING_COVER_LETTER",
      `Selected attempt has no rendered cover letter at ${input.sourceCoverLetterPath}.`
    );
  }

  const target = resolveSafeAttemptTarget(input);
  const directory = target.safeAttemptDirectory;
  fs.mkdirSync(directory, { recursive: true });

  // Reuses Phase 9A's own filename helpers — one naming algorithm for both publications, always
  // derived from the candidate, never hardcoded.
  const resumeName = finalResumeFilename(input.candidateFirstName);
  const coverName = finalCoverLetterFilename(input.candidateFirstName);
  const feedbackName = "resume_review_feedback.md";

  const resumePath = path.join(directory, resumeName);
  const coverLetterPath = path.join(directory, coverName);
  fs.copyFileSync(input.sourceResumePath, resumePath);
  fs.copyFileSync(input.sourceCoverLetterPath, coverLetterPath);

  let reviewFeedbackPath: string | null = null;
  if (input.sourceReviewFeedbackPath && fs.existsSync(input.sourceReviewFeedbackPath)) {
    reviewFeedbackPath = path.join(directory, feedbackName);
    fs.copyFileSync(input.sourceReviewFeedbackPath, reviewFeedbackPath);
  }

  const manifest: SafeAttemptManifest = {
    schemaVersion: 1,
    status: "SAFE_BEST_ATTEMPT",
    humanReviewRequired: true,
    publishedAt: new Date().toISOString(),
    candidateId: input.candidateId,
    candidateName: input.candidateName,
    candidateFilePrefix: resumeName.replace(/_Resume\.docx$/, ""),
    companyName: input.companyName,
    jobId: input.jobId,
    jobTitle: input.jobTitle,
    workflowId: input.workflowId,
    tailoringRunId: input.tailoringRunId,
    selectedIterationNumber: input.disposition.selectedIterationNumber,
    selectionReason: input.disposition.selectionReason,
    optimizationScore: input.disposition.optimizationScore,
    safetyPassed: true,
    remainingFindings: input.disposition.optimizationFindings,
    files: { resume: resumeName, coverLetter: coverName, reviewFeedback: reviewFeedbackPath ? feedbackName : null, manifest: SAFE_ATTEMPT_MANIFEST_FILENAME },
    checksums: { resume: sha256File(resumePath), coverLetter: sha256File(coverLetterPath) },
  };

  const manifestPath = path.join(directory, SAFE_ATTEMPT_MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  // A second, deliberately blunt file so the state is obvious without parsing the manifest.
  const statusPath = path.join(directory, SAFE_ATTEMPT_STATUS_FILENAME);
  fs.writeFileSync(
    statusPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: "SAFE_BEST_ATTEMPT",
        humanReviewRequired: true,
        approved: false,
        note:
          "This package passed every absolute truthfulness and safety check but did NOT pass the full quality gate. " +
          "It is not an approved READY publication. A human must review it before applying, and CareerOps never submits an application.",
        recordedAt: new Date().toISOString(),
        selectedIterationNumber: input.disposition.selectedIterationNumber,
        optimizationScore: input.disposition.optimizationScore,
      },
      null,
      2
    )}\n`,
    "utf-8"
  );

  return { directory, resumePath, coverLetterPath, reviewFeedbackPath, manifestPath, statusPath, manifest };
}
