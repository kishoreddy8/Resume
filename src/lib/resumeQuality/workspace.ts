import path from "node:path";
import { getTailoringArtifactDirectory } from "@/lib/tailoringArtifacts";

/**
 * Phase 3 Stage 7 storage layout — an ADDITIVE extension of Stage 4's existing candidate/job/run
 * hierarchy, not a second competing artifact root:
 *
 *   data/generated/candidates/<candidateId>/jobs/<jobIdentityHash>/runs/<runId>/   (Stage 4, unchanged)
 *     Resume.docx                     (Stage 5's own tailoring-run output, unchanged)
 *     CoverLetter.docx
 *     quality/<workflowId>/           (Stage 7, new)
 *       workspace/                    (writer inputs: job_description.md, extracted requirements, ...)
 *       iterations/<n>/                (immutable per-iteration snapshots — never overwritten)
 *         Resume.docx
 *         CoverLetter.docx
 *         review.json
 *         review_feedback.md
 *       final/                        (only populated once a workflow reaches READY)
 *         <FirstName>_Resume.docx
 *         <FirstName>_CoverLetter.docx
 *         resume_review_feedback.md
 *
 * Every path below is built on top of getTailoringArtifactDirectory() (Stage 4), which already
 * validates candidateId/runId/dedupeKey and asserts the result stays inside GENERATED_ROOT — this
 * module does not re-derive or duplicate that safety check. workflowId/iterationNumber are validated
 * here the same way Stage 4 validates candidateId/runId (positive integers only), which by
 * construction makes path traversal through those segments impossible.
 */

export interface QualityWorkflowLocation {
  candidateId: number;
  dedupeKey: string;
  runId: number;
  workflowId: number;
}

function validatePositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}

/** The root directory for one quality workflow, nested under its tailoring run's own Stage 4
 *  directory. Does not create anything on disk. */
export function getQualityWorkflowDirectory(location: QualityWorkflowLocation): string {
  validatePositiveInt("workflowId", location.workflowId);
  const runDir = getTailoringArtifactDirectory({
    candidateId: location.candidateId,
    dedupeKey: location.dedupeKey,
    runId: location.runId,
  });
  return path.join(runDir, "quality", String(location.workflowId));
}

export function getWorkspaceDirectory(location: QualityWorkflowLocation): string {
  return path.join(getQualityWorkflowDirectory(location), "workspace");
}

/** One immutable per-iteration directory. iterationNumber must be a positive integer — callers
 *  (the future orchestrator, not built in Stage 7) are responsible for never re-using a number that
 *  already has a resume_quality_iterations row (enforced at the query layer, see
 *  resumeQualityWorkflows.ts's createResumeQualityIteration). */
export function getIterationDirectory(location: QualityWorkflowLocation, iterationNumber: number): string {
  validatePositiveInt("iterationNumber", iterationNumber);
  return path.join(getQualityWorkflowDirectory(location), "iterations", String(iterationNumber));
}

/** One immutable per-iteration handoff directory for external subscription agents (Stage 11). */
export function getHandoffDirectory(location: QualityWorkflowLocation, iterationNumber: number): string {
  validatePositiveInt("iterationNumber", iterationNumber);
  return path.join(getQualityWorkflowDirectory(location), "handoffs", `iteration-${iterationNumber}`);
}

export function getFinalDirectory(location: QualityWorkflowLocation): string {
  return path.join(getQualityWorkflowDirectory(location), "final");
}

/** Stage 13 — the best-attempt preservation package for a workflow that reached terminal FAILED
 *  (HUMAN_REVIEW_REQUIRED) after exhausting its quality iterations. Never populated for a workflow
 *  that reaches READY — final/ remains the sole authoritative approved-artifact directory. */
export function getHumanReviewDirectory(location: QualityWorkflowLocation): string {
  return path.join(getQualityWorkflowDirectory(location), "human-review");
}

/** Strips everything but letters/digits so a candidate's first name is always a safe, single path
 *  segment/filename component — no spaces, punctuation, or path separators can survive. Falls back to
 *  "Candidate" rather than producing an empty/unsafe filename if the name sanitizes to nothing. */
function sanitizeNameSegment(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9]+/g, "");
  return cleaned.length > 0 ? cleaned : "Candidate";
}

/** e.g. sanitizeNameSegment("Saikishore") -> "Saikishore_Resume.docx". Never hardcodes a candidate
 *  name globally — always derived from whatever first name the caller passes in (the candidate's own
 *  profile, at call time in a later stage). */
export function finalResumeFilename(candidateFirstName: string): string {
  return `${sanitizeNameSegment(candidateFirstName)}_Resume.docx`;
}

export function finalCoverLetterFilename(candidateFirstName: string): string {
  return `${sanitizeNameSegment(candidateFirstName)}_CoverLetter.docx`;
}
