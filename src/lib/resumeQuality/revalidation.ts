import fs from "node:fs";
import path from "node:path";
import type { CoverLetterContent, ResumeContent } from "../../../tools/tailoring-engine/types";
import {
  createResumeQualityIteration,
  getResumeQualityWorkflow,
  listResumeQualityIterations,
} from "@/db/queries/resumeQualityWorkflows";
import { getIterationDirectory, type QualityWorkflowLocation } from "./workspace";
import { resolveDeterministicReviewContext } from "./reviewInputContext";
import { reviewResumeDeterministically } from "./reviewers/deterministicReviewer";
import { structuredResumeReviewSchema } from "./types";
import { isLegacyReviewMissingTypedSafetyAnalysis, canRevalidate } from "./legacyReview";
import type { StructuredResumeReview } from "./types";

/**
 * Re-running validation on a resume that was reviewed before today's safety analyses existed.
 *
 * WHAT THIS IS FOR. Some reviews in this database were written before `blockingFailures`,
 * `instructionCompliance` and `recruiterQualityAssessment` were produced. Everything that reads
 * them treats absence as failure — correctly — so those packages are permanently unsendable with no
 * way forward. This is the way forward: review the resume that already exists, with today's checks.
 *
 * IT REVIEWS; IT DOES NOT WRITE. The tailored resume is not regenerated. The document on disk is
 * already the approved artifact, and the only thing missing is analysis OF it, so no writer runs,
 * the writer-concurrency rule is untouched, and no model is called — `reviewResumeDeterministically`
 * is pure and deterministic.
 *
 * IT CANNOT CLEAR ANYTHING. This module produces a review and persists it. It never computes a
 * gate, never sets readiness, and never writes an application state. Whether the package becomes
 * sendable is decided afterwards by evaluateQualityGate and evaluateApplicationReadiness reading
 * the new review, exactly as they read every other review. A re-run that fails leaves the package
 * as blocked as it was, with the new reason.
 *
 * HISTORY IS APPEND-ONLY. The result is persisted as a NEW iteration through the same
 * `createResumeQualityIteration` used by the loop. No earlier `review_json` is touched, so the
 * evidence that a package was once un-analysed survives the recovery.
 *
 * IT SHARES THE ORCHESTRATOR'S CONTEXT, IT DOES NOT COPY IT. The candidate's master evidence, this
 * job's extracted requirements, the prior iteration's resume and the job's posted title all come
 * from resolveDeterministicReviewContext — the same function the normal iteration calls. The two
 * paths cannot disagree about what a review is of, because there is only one assembly.
 */

export type RevalidationRefusal =
  | "NO_WORKFLOW"
  | "NO_REVIEW"
  | "NOT_LEGACY"
  | "BUDGET_EXHAUSTED"
  | "NO_RESUME_ARTIFACT"
  | "IN_PROGRESS";

export type RevalidationResult =
  | { ok: true; iterationNumber: number; review: StructuredResumeReview }
  | { ok: false; refusal: RevalidationRefusal; message: string };

/** Workflow statuses during which another pass must not be started. */
const RUNNING_STATUSES: ReadonlySet<string> = new Set([
  "WRITER_RUNNING",
  "REVIEW_RUNNING",
  "IMPROVEMENT_RUNNING",
]);

function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Re-reviews the latest iteration's resume and persists the result as the next iteration.
 *
 * Every refusal below is a real condition, reported rather than worked around.
 */
export function revalidateLatestReview(candidateId: number, workflowId: number): RevalidationResult {
  const workflow = getResumeQualityWorkflow(candidateId, workflowId);
  if (!workflow) {
    return { ok: false, refusal: "NO_WORKFLOW", message: "No quality workflow exists for this job." };
  }

  /* Server-side concurrency guard. A second click, or two tabs, must not produce two iterations —
   * and `createResumeQualityIteration` itself refuses an out-of-sequence number, so this is the
   * readable refusal in front of a hard one. */
  if (RUNNING_STATUSES.has(workflow.status)) {
    return { ok: false, refusal: "IN_PROGRESS", message: "This resume is already being worked on." };
  }

  const iterations = listResumeQualityIterations(candidateId, workflowId);
  const latest = iterations[iterations.length - 1];
  if (!latest) {
    return { ok: false, refusal: "NO_REVIEW", message: "This resume has not been reviewed yet." };
  }

  const previousReview = safeParseReview(latest.review_json);
  if (!previousReview) {
    return { ok: false, refusal: "NO_REVIEW", message: "The previous review could not be read." };
  }

  /* Only the legacy shape is recoverable this way. A review that ran today's checks and failed them
   * is a resume problem, and offering to "refresh" it would misreport a real defect. */
  if (!isLegacyReviewMissingTypedSafetyAnalysis(previousReview)) {
    return {
      ok: false,
      refusal: "NOT_LEGACY",
      message: "This review already ran the current checks, so re-running them would change nothing.",
    };
  }

  if (!canRevalidate(workflow)) {
    return {
      ok: false,
      refusal: "BUDGET_EXHAUSTED",
      message: "This resume has used all of its review passes, so another cannot be recorded.",
    };
  }

  const location: QualityWorkflowLocation = {
    candidateId,
    dedupeKey: workflow.dedupe_key,
    runId: workflow.tailoring_run_id,
    workflowId: workflow.id,
  };

  const latestDir = getIterationDirectory(location, latest.iteration_number);
  const resume = readJson<ResumeContent>(path.join(latestDir, "resume_content.json"));
  if (!resume) {
    return {
      ok: false,
      refusal: "NO_RESUME_ARTIFACT",
      message: "The tailored resume for this review is no longer on disk, so it cannot be re-checked.",
    };
  }
  const coverLetter = readJson<CoverLetterContent>(path.join(latestDir, "cover_letter_content.json"));

  const iterationNumber = latest.iteration_number + 1;

  /* The SAME helper the orchestrator uses, keyed on the iteration being written. Nothing about the
   * candidate's evidence, this job's requirements or its posted title is resolved differently here.
   *
   * Keying on the new iteration also fixes what a hand-rolled version got wrong: `priorResume` is
   * the iteration BEFORE the one being written, which for a re-review is the very document being
   * re-reviewed. The deep-rewrite check then correctly sees that nothing was rewritten, instead of
   * comparing against an older resume and attributing a previous pass's rewrite to this one. */
  const context = resolveDeterministicReviewContext({
    candidateId,
    location,
    iterationNumber,
    dedupeKey: workflow.dedupe_key,
  });

  const raw = reviewResumeDeterministically({
    resume,
    jobRequirements: context.jobRequirements,
    masterResumeProfile: context.masterResumeProfile,
    coverLetter,
    priorResume: context.priorResume,
    /* Not re-validating the DOCX: this pass re-analyses the content that already exists, and a
     * missing docx-validation input is reported by the reviewer's own checks rather than assumed. */
    docxValidation: undefined,
    targetRoleTitle: context.targetRoleTitle,
  });
  const review = structuredResumeReviewSchema.parse(raw);

  const iterDir = getIterationDirectory(location, iterationNumber);
  fs.mkdirSync(iterDir, { recursive: true });
  /* The resume is copied forward unchanged — this iteration is a new review OF the same document,
   * and a later reader must be able to see exactly what was reviewed. */
  fs.writeFileSync(path.join(iterDir, "resume_content.json"), JSON.stringify(resume, null, 2), "utf-8");
  if (coverLetter) {
    fs.writeFileSync(
      path.join(iterDir, "cover_letter_content.json"),
      JSON.stringify(coverLetter, null, 2),
      "utf-8"
    );
  }
  fs.writeFileSync(path.join(iterDir, "review.json"), JSON.stringify(review, null, 2), "utf-8");

  createResumeQualityIteration(candidateId, workflowId, iterationNumber, {
    outputFiles: JSON.parse(latest.output_files ?? "[]") as string[],
    reviewJson: JSON.stringify(review),
    overallScore: review.overallScore,
    atsScore: review.atsScore,
    keywordAlignmentScore: review.keywordAlignmentScore,
    truthfulnessScore: review.truthfulnessScore,
    architectureConsistencyScore: review.architectureConsistencyScore,
    recruiterReadabilityScore: review.recruiterReadabilityScore,
    formattingScore: review.formattingScore,
    blockingIssueCount: review.blockingIssues.length,
  });

  return { ok: true, iterationNumber, review };
}

function safeParseReview(json: string | null): StructuredResumeReview | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as StructuredResumeReview;
  } catch {
    return undefined;
  }
}
