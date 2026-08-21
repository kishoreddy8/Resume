import type { StructuredResumeReview } from "./types";

/**
 * Is this review blocked ONLY because it predates the current safety analyses?
 *
 * WHY A STRUCTURAL TEST, NEVER A DATE. Reviews written before the typed analyses existed happen to
 * cluster in a date range, but the date is a symptom. What actually matters is that the review
 * carries no typed analysis at all AND recorded no failure of its own — a review that genuinely
 * failed a check is not legacy, it is failing, and offering to "refresh" it would misrepresent a
 * real defect as a schema problem.
 *
 * THIS FUNCTION CANNOT CLEAR ANYTHING. It answers one question — "would re-running today's checks
 * be meaningful for this review?" — and is used only to decide whether to offer that action. The
 * verdict still comes from evaluateApplicationReadiness reading whatever the re-run produces, and a
 * re-run that fails leaves the package exactly as blocked as it was.
 *
 * The three analyses are treated as one set on purpose. A review holding some but not all of them
 * is not a legacy shape — it is a review that ran under a different version of the pipeline, and
 * guessing which half to trust is precisely the inference this whole gate exists to prevent.
 */
export function isLegacyReviewMissingTypedSafetyAnalysis(review: StructuredResumeReview): boolean {
  const missingAll =
    review.blockingFailures === undefined &&
    review.instructionCompliance === undefined &&
    review.recruiterQualityAssessment === undefined;
  if (!missingAll) return false;

  /* A recorded failure of any kind means the review DID find something, so its blocking state is
   * about the resume rather than about the schema. Those stay in the normal fix-and-review flow. */
  const recordedItsOwnFailure =
    review.blockingIssues.length > 0 ||
    review.truthfulnessIssues.length > 0 ||
    review.truthfulnessScore !== 100 ||
    review.architectureConsistencyScore !== 100;

  return !recordedItsOwnFailure;
}

/**
 * Whether a re-run can even be attempted, given how many iterations this workflow has left.
 *
 * A re-review is persisted as a NEW iteration — the existing convention, which keeps every earlier
 * review intact as historical evidence rather than rewriting one. That means it consumes a slot,
 * and a workflow that has used its budget cannot take another. Refusing plainly is the honest
 * outcome; silently overwriting the last iteration to make room would destroy the evidence the
 * fail-closed gate depends on.
 */
export function canRevalidate(workflow: { current_iteration: number; max_iterations: number }): boolean {
  return workflow.current_iteration + 1 <= workflow.max_iterations;
}
