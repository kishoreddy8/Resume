import type { QualityWorkflowData } from "./useQualityWorkflow";

/**
 * Flattens the review's existing issue fields for display. Historical reviews store required
 * corrections as objects, while the other issue collections are strings. No issue is inferred or
 * reclassified here; malformed historical entries are simply omitted from the candidate summary.
 */
export function validationIssues(data: QualityWorkflowData): string[] {
  const candidates: unknown[] = [
    ...(data.readiness?.blockingReasons ?? []),
    ...(data.review?.blockingIssues ?? []),
    ...(data.review?.truthfulnessIssues ?? []),
    ...(data.review?.requiredCorrections ?? []).map((correction) => correction?.description),
  ];

  return candidates.filter(
    (issue, index, all): issue is string =>
      typeof issue === "string" && issue.trim().length > 0 && all.indexOf(issue) === index
  );
}
