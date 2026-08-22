import fs from "node:fs";
import path from "node:path";
import {
  getResumeQualityWorkflow,
  listResumeQualityIterations,
  listResumeQualityWorkflowsForJob,
} from "@/db/queries/resumeQualityWorkflows";
import { selectBestResumeQualityAttempt } from "./bestAttemptSelection";
import { extractRootRepairFindings } from "./repairScope";
import type { StructuredResumeReview } from "./types";
import {
  getIterationDirectory,
  getWorkspaceDirectory,
  type QualityWorkflowLocation,
} from "./workspace";

export const RETRY_LINEAGE_FILENAME = "retry_lineage.json";

export interface RetryLineage {
  schemaVersion: 1;
  parentWorkflowId: number;
  parentIterationNumber: number;
  baselineReviewPath: string;
  resolvedFindingKeys: string[];
  createdAt: string;
}

export interface RetryBaselineSelection {
  lineage: RetryLineage;
  parentLocation: QualityWorkflowLocation;
}

interface ReviewedAttempt {
  workflowId: number;
  iterationNumber: number;
  review: StructuredResumeReview;
  location: QualityWorkflowLocation;
}

function parseReview(raw: string | null): StructuredResumeReview | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StructuredResumeReview;
  } catch {
    return null;
  }
}

function hasUsableArtifacts(attempt: ReviewedAttempt): boolean {
  const dir = getIterationDirectory(attempt.location, attempt.iterationNumber);
  return fs.existsSync(path.join(dir, "resume_content.json")) && fs.existsSync(path.join(dir, "review.json"));
}

/** Selects the safest reviewed package across prior workflows for the same candidate/job. No row or
 * historical artifact is changed. Workflows are flattened oldest-to-newest so the existing best-
 * attempt authority's later-attempt tiebreak remains deterministic across workflow boundaries. */
export function selectRetryBaseline(
  candidateId: number,
  dedupeKey: string,
  excludeWorkflowId?: number
): RetryBaselineSelection | null {
  const workflows = listResumeQualityWorkflowsForJob(candidateId, dedupeKey)
    .filter((workflow) => workflow.id !== excludeWorkflowId)
    .reverse();
  const attempts: ReviewedAttempt[] = [];
  for (const workflow of workflows) {
    const location: QualityWorkflowLocation = {
      candidateId,
      dedupeKey,
      runId: workflow.tailoring_run_id,
      workflowId: workflow.id,
    };
    for (const iteration of listResumeQualityIterations(candidateId, workflow.id)) {
      const review = parseReview(iteration.review_json);
      if (!review) continue;
      const attempt = { workflowId: workflow.id, iterationNumber: iteration.iteration_number, review, location };
      if (hasUsableArtifacts(attempt)) attempts.push(attempt);
    }
  }
  if (attempts.length === 0) return null;

  const ranked = attempts.map((attempt, index) => ({ iterationNumber: index + 1, review: attempt.review }));
  const selection = selectBestResumeQualityAttempt(ranked);
  if (!selection) return null;
  const winner = attempts[selection.iterationNumber - 1]!;
  const allFindingKeys = new Set(attempts.flatMap((attempt) => extractRootRepairFindings(attempt.review).map((finding) => finding.key)));
  const unresolvedKeys = new Set(extractRootRepairFindings(winner.review).map((finding) => finding.key));
  const resolvedFindingKeys = [...allFindingKeys].filter((key) => !unresolvedKeys.has(key)).sort();

  return {
    parentLocation: winner.location,
    lineage: {
      schemaVersion: 1,
      parentWorkflowId: winner.workflowId,
      parentIterationNumber: winner.iterationNumber,
      baselineReviewPath: `quality/${winner.workflowId}/iterations/${winner.iterationNumber}/review.json`,
      resolvedFindingKeys,
      createdAt: new Date().toISOString(),
    },
  };
}

export function writeRetryLineage(location: QualityWorkflowLocation, selection: RetryBaselineSelection): string {
  const workspace = getWorkspaceDirectory(location);
  fs.mkdirSync(workspace, { recursive: true });
  const target = path.join(workspace, RETRY_LINEAGE_FILENAME);
  fs.writeFileSync(target, `${JSON.stringify(selection.lineage, null, 2)}\n`, { flag: "wx" });
  return target;
}

export function readRetryLineage(location: QualityWorkflowLocation): RetryBaselineSelection | null {
  const lineagePath = path.join(getWorkspaceDirectory(location), RETRY_LINEAGE_FILENAME);
  if (!fs.existsSync(lineagePath)) return null;
  try {
    const lineage = JSON.parse(fs.readFileSync(lineagePath, "utf-8")) as RetryLineage;
    if (
      lineage.schemaVersion !== 1 ||
      !Number.isInteger(lineage.parentWorkflowId) || lineage.parentWorkflowId <= 0 ||
      !Number.isInteger(lineage.parentIterationNumber) || lineage.parentIterationNumber <= 0 ||
      !Array.isArray(lineage.resolvedFindingKeys)
    ) return null;
    const parent = getResumeQualityWorkflow(location.candidateId, lineage.parentWorkflowId);
    if (!parent || parent.dedupe_key !== location.dedupeKey) return null;
    return {
      lineage,
      parentLocation: {
        candidateId: location.candidateId,
        dedupeKey: parent.dedupe_key,
        runId: parent.tailoring_run_id,
        workflowId: parent.id,
      },
    };
  } catch {
    return null;
  }
}
