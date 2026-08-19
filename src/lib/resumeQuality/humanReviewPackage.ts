import fs from "node:fs";
import path from "node:path";
import { getCandidate } from "@/db/queries/candidates";
import { getJobByDedupeKey } from "@/db/queries/jobs";
import { getResumeQualityWorkflow, listResumeQualityIterations } from "@/db/queries/resumeQualityWorkflows";
import { selectBestResumeQualityAttempt, type ResumeQualityAttemptSummary } from "./bestAttemptSelection";
import { CANONICAL_TAILORING_INSTRUCTIONS, INSTRUCTION_HASH, INSTRUCTION_VERSION } from "./canonicalInstructions";
import { HARD_GATE_CHECKS } from "./instructionCompliance";
import type { StructuredResumeReview, WorkflowStatusFile } from "./types";
import { getHumanReviewDirectory, getIterationDirectory, sanitizeNameSegment, type QualityWorkflowLocation } from "./workspace";

/**
 * Stage 13 — generates the "best attempt, preserved for human review" package once a workflow reaches
 * terminal FAILED (HUMAN_REVIEW_REQUIRED) after exhausting its quality iterations. This is NEVER an
 * approved/final package — see best_attempt.json's hardcoded `approved: false` below, which no caller
 * of this module can override (the field is not a parameter anywhere in this file).
 *
 * Selection is delegated entirely to bestAttemptSelection.ts's selectBestResumeQualityAttempt — the
 * SINGLE authority for ranking attempts. This module never re-derives or second-guesses that ranking.
 *
 * Atomicity: every file is written into a temporary sibling directory first
 * (human-review.tmp-<random>/) and only rf.renameSync'd into the real human-review/ path once every
 * required write has succeeded — the same atomic-rename idiom already used elsewhere in this codebase
 * (e.g. the resume-writer worker's own report-file writing) rather than a new mechanism. A crash or
 * throw partway through leaves only an orphaned .tmp directory, never a human-review/ that looks
 * complete but isn't.
 */

export interface HumanReviewPackageResult {
  workflowId: number;
  iterationNumber: number;
  directory: string;
  files: string[];
}

/** Best-effort file copy — some artifacts (e.g. cover letter) are legitimately optional per iteration
 *  (a candidate/job may never have had a cover letter generated); a missing source file is not an
 *  error, it's simply omitted from the package. */
function copyIfExists(srcPath: string, destPath: string, files: string[], label: string): void {
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
    files.push(label);
  }
}

/**
 * Builds the human-review package for the given workflow's already-persisted iteration history.
 * Returns null (and writes nothing) when the workflow has no iterations at all — never fabricates a
 * package for a workflow with no evidence to preserve. Throws only on a genuine filesystem error;
 * callers (orchestrator.ts) are responsible for treating that as non-fatal to the workflow's own
 * FAILED transition, which must already have completed before this is ever called.
 */
export function generateHumanReviewPackage(candidateId: number, workflowId: number): HumanReviewPackageResult | null {
  const workflow = getResumeQualityWorkflow(candidateId, workflowId);
  if (!workflow) return null;

  const iterationRows = listResumeQualityIterations(candidateId, workflowId);
  if (iterationRows.length === 0) return null;

  const attempts: ResumeQualityAttemptSummary[] = [];
  for (const row of iterationRows) {
    if (!row.review_json) continue;
    try {
      const review = JSON.parse(row.review_json) as StructuredResumeReview;
      attempts.push({ iterationNumber: row.iteration_number, review });
    } catch {
      // Skip an unparseable legacy row rather than let it crash selection for the whole workflow.
    }
  }
  if (attempts.length === 0) return null;

  const selection = selectBestResumeQualityAttempt(attempts);
  if (!selection) return null;

  const selectedReview = attempts.find((a) => a.iterationNumber === selection.iterationNumber)!.review;

  const candidate = getCandidate(candidateId);
  const job = getJobByDedupeKey(workflow.dedupe_key);
  const jobId = job?.id ?? null;

  const location: QualityWorkflowLocation = {
    candidateId,
    dedupeKey: workflow.dedupe_key,
    runId: workflow.tailoring_run_id,
    workflowId,
  };

  const selectedIterDir = getIterationDirectory(location, selection.iterationNumber);
  const finalDir = getHumanReviewDirectory(location);
  const tmpDir = path.join(path.dirname(finalDir), `human-review.tmp-${process.pid}-${Date.now()}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const files: string[] = [];
  // Stage 31.1 — sanitised exactly as the READY publication does, so a first name with a space
  // cannot produce a filename with a space in one path and without one in the other.
  const firstName = sanitizeNameSegment(candidate?.first_name || "Candidate");

  try {
    copyIfExists(
      path.join(selectedIterDir, "Resume.docx"),
      path.join(tmpDir, `${firstName}_Resume_HumanReview.docx`),
      files,
      `${firstName}_Resume_HumanReview.docx`
    );
    copyIfExists(
      path.join(selectedIterDir, "CoverLetter.docx"),
      path.join(tmpDir, `${firstName}_CoverLetter_HumanReview.docx`),
      files,
      `${firstName}_CoverLetter_HumanReview.docx`
    );
    copyIfExists(path.join(selectedIterDir, "resume_content.json"), path.join(tmpDir, "resume_content.json"), files, "resume_content.json");
    copyIfExists(
      path.join(selectedIterDir, "cover_letter_content.json"),
      path.join(tmpDir, "cover_letter_content.json"),
      files,
      "cover_letter_content.json"
    );

    fs.writeFileSync(path.join(tmpDir, "careerops_review.json"), JSON.stringify(selectedReview, null, 2), "utf-8");
    files.push("careerops_review.json");

    copyIfExists(path.join(selectedIterDir, "review_feedback.md"), path.join(tmpDir, "review_feedback.md"), files, "review_feedback.md");

    const instructionSnapshot = [
      "# Canonical Instruction Snapshot",
      "",
      `Instruction version: ${INSTRUCTION_VERSION}`,
      `Instruction hash (SHA-256): ${INSTRUCTION_HASH}`,
      `Snapshotted for the human-review package of workflow ${workflowId}, best attempt iteration ${selection.iterationNumber}.`,
      "",
      "---",
      "",
      CANONICAL_TAILORING_INSTRUCTIONS,
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "instruction_snapshot.md"), instructionSnapshot, "utf-8");
    files.push("instruction_snapshot.md");

    const compliance = selectedReview.instructionCompliance;
    const passCount = compliance ? HARD_GATE_CHECKS.filter((n) => compliance.checks[n] === "PASS").length : 0;
    const hardGateFailures = compliance ? HARD_GATE_CHECKS.filter((n) => compliance.checks[n] !== "PASS") : [...HARD_GATE_CHECKS];

    const bestAttemptFile = {
      workflowId,
      iterationNumber: selection.iterationNumber,
      selectedAt: new Date().toISOString(),
      selectionReason: selection.selectionReason,
      overallScore: selectedReview.overallScore,
      atsScore: selectedReview.atsScore,
      truthfulnessScore: selectedReview.truthfulnessScore,
      architectureConsistencyScore: selectedReview.architectureConsistencyScore,
      instructionCompliance: compliance
        ? {
            passCount: Object.values(compliance.checks).filter((s) => s === "PASS").length,
            failCount: Object.values(compliance.checks).filter((s) => s === "FAIL").length,
            reviewCount: Object.values(compliance.checks).filter((s) => s === "REVIEW").length,
            hardGatePassCount: passCount,
            hardGateTotal: HARD_GATE_CHECKS.length,
          }
        : null,
      hardGateFailures,
      blockingIssues: selectedReview.blockingIssues,
      qualityGateDecision: "NEEDS_HUMAN_REVIEW" as const,
      approved: false as const,
    };
    fs.writeFileSync(path.join(tmpDir, "best_attempt.json"), JSON.stringify(bestAttemptFile, null, 2), "utf-8");
    files.push("best_attempt.json");

    const workflowStatusFile: WorkflowStatusFile = {
      candidateId,
      applicationId: workflow.application_id,
      jobId,
      tailoringRunId: workflow.tailoring_run_id,
      workflowId,
      currentIteration: workflow.current_iteration,
      targetIteration: workflow.current_iteration,
      maxIterations: workflow.max_iterations,
      workflowStatus: "FAILED",
      latestOverallScore: workflow.latest_overall_score,
      qualityGateResult: "NEEDS_HUMAN_REVIEW",
      waitingFor: "HUMAN_REVIEW",
      createdAt: workflow.created_at,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tmpDir, "workflow_status.json"), JSON.stringify(workflowStatusFile, null, 2), "utf-8");
    files.push("workflow_status.json");

    // Atomic hand-off: only now, with every required file already successfully written, does the
    // real human-review/ path start to exist — never a partially-written directory at that path.
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }

  return { workflowId, iterationNumber: selection.iterationNumber, directory: finalDir, files };
}
