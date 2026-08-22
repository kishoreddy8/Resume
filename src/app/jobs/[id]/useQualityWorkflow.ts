"use client";

import { useEffect, useState } from "react";

/**
 * The resume quality record for one job — fetched only by the steps that need it.
 *
 * ONE REQUEST, AND ONLY WHEN A STEP ASKS. The payload carries every iteration, the latest review
 * and the publication record; it measured 4.5KB for one job and 29KB for another. So it is gated on
 * `enabled` and is never pulled while someone is reading Match or Resume Studio.
 *
 * IT INTERPRETS NOTHING. The fields below are passed through exactly as the pipeline returned them.
 * The three authorities it exposes are deliberately kept separate rather than collapsed into one
 * "is it ok" boolean, because on real data they disagree: a workflow can read READY with every
 * dimension at 100 while the quality gate has NOT passed and readiness is BLOCKED. Flattening them
 * would pick a winner in the UI, which is precisely the decision the UI must not make.
 */

export interface ReviewScores {
  overallScore: number | null;
  atsScore: number | null;
  keywordAlignmentScore: number | null;
  truthfulnessScore: number | null;
  architectureConsistencyScore: number | null;
  recruiterReadabilityScore: number | null;
  formattingScore: number | null;
  missingRequiredSkills: string[];
  truthfulnessIssues: string[];
  blockingIssues: string[];
  requiredCorrections: Array<{ priority?: string; description: string }>;
}

export interface QualityWorkflowData {
  workflowStatus: string | null;
  review: ReviewScores | null;
  gate: { passed: boolean; outcome: string | null } | null;
  /** The authority on whether a person may send this package. Never inferred from the score. */
  readiness: { readiness: string; blockingReasons: string[]; improvementReasons: string[]; humanMaySend: boolean } | null;
  iterations: { iteration: number; overall: number | null; ats: number | null; blocking: number }[];
  /** The one blocking condition a candidate can act on: a review written before today's checks. */
  revalidation: { isLegacyMissingAnalysis: boolean; canRevalidate: boolean } | null;
}

export type QualityWorkflowState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "none" }
  | { state: "error" }
  | { state: "ready"; data: QualityWorkflowData };

export function useQualityWorkflow(
  candidateId: number | null,
  jobId: number,
  enabled: boolean,
  /** Changing this re-reads the record — used after an explicit re-validation, never on a timer. */
  refreshKey = 0
): QualityWorkflowState {
  const [value, setValue] = useState<QualityWorkflowState>({ state: "idle" });

  useEffect(() => {
    if (!enabled || candidateId === null) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue({ state: "loading" });
    fetch(`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        if (!body || !body.workflow) return setValue({ state: "none" });
        const r = body.latestReview ?? null;
        setValue({
          state: "ready",
          data: {
            workflowStatus: body.workflow.status ?? null,
            review: r
              ? {
                  overallScore: r.overallScore ?? null,
                  atsScore: r.atsScore ?? null,
                  keywordAlignmentScore: r.keywordAlignmentScore ?? null,
                  truthfulnessScore: r.truthfulnessScore ?? null,
                  architectureConsistencyScore: r.architectureConsistencyScore ?? null,
                  recruiterReadabilityScore: r.recruiterReadabilityScore ?? null,
                  formattingScore: r.formattingScore ?? null,
                  missingRequiredSkills: r.missingRequiredSkills ?? [],
                  truthfulnessIssues: r.truthfulnessIssues ?? [],
                  blockingIssues: r.blockingIssues ?? [],
                  requiredCorrections: r.requiredCorrections ?? [],
                }
              : null,
            gate: body.qualityGate
              ? { passed: Boolean(body.qualityGate.passed), outcome: body.qualityGate.outcome ?? null }
              : null,
            readiness: body.applicationReadiness
              ? {
                  readiness: body.applicationReadiness.readiness ?? "UNKNOWN",
                  blockingReasons: body.applicationReadiness.blockingReasons ?? [],
                  improvementReasons: body.applicationReadiness.improvementReasons ?? [],
                  humanMaySend: Boolean(body.applicationReadiness.humanMaySend),
                }
              : null,
            iterations: (body.iterations ?? []).map(
              (i: {
                iteration_number: number;
                overall_score: number | null;
                ats_score: number | null;
                blocking_issue_count: number;
              }) => ({
                iteration: i.iteration_number,
                overall: i.overall_score,
                ats: i.ats_score,
                blocking: i.blocking_issue_count ?? 0,
              })
            ),
            revalidation: body.revalidation ?? null,
          },
        });
      })
      .catch(() => {
        if (!cancelled) setValue({ state: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [candidateId, jobId, enabled, refreshKey]);

  return value;
}
