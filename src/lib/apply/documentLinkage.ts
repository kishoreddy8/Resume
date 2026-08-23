import fs from "node:fs";
import path from "node:path";
import { getLatestResumeQualityWorkflowForJob } from "@/db/queries/resumeQualityWorkflows";
import { getHumanApprovalForWorkflow } from "@/db/queries/resumeQualityHumanApprovals";
import { getJob } from "@/db/queries/jobs";
import { resolvePublishedApplicationTarget } from "@/lib/resumeQuality/finalPublication";
import { resolveSafeAttemptTarget, type SafeAttemptManifest } from "@/lib/resumeQuality/safeAttemptPublication";
import type { PublishedApplicationManifest } from "@/lib/resumeQuality/finalPublication";

/**
 * Which documents an application run is allowed to upload.
 *
 * THE RULE. Two paths lead here, and both are provable, never inferred:
 *
 *   CASE A — AUTONOMOUS READY. workflow.status === "READY": the quality gate itself cleared this
 *   resume (qualityGate.ts). Documents are read from the SAME publication tree
 *   resolvePublishedApplicationTarget() computes and finalPublication.ts already writes to on READY —
 *   this module used to read a different, unpopulated legacy directory (generatedFilesDir), which
 *   meant a READY workflow could never actually produce a sendable document; this was a real bug,
 *   fixed here because correctness of CASE A is a precondition for CASE B meaning anything.
 *
 *   CASE B — HUMAN-APPROVED SAFE ATTEMPT. workflow.status === "FAILED" but the candidate explicitly
 *   approved this EXACT workflow's best attempt (resume_quality_human_approvals, one row per
 *   workflow_id). Documents are read from safeAttemptPublication.ts's human-review/ subdirectory of
 *   the same target. The approval's workflow_id must equal the CURRENT latest workflow for this job —
 *   an older workflow's approval can never authorize a newer, unapproved workflow's resume, and the
 *   manifest actually on disk must still name the approved workflow/iteration, so a later re-tailor
 *   that silently overwrote the shared human-review/ directory can never be mistaken for the approved
 *   content.
 *
 * There is no "best available" fallback and no reaching for an older file in either case: a resume
 * that has not passed validation, or been explicitly approved, for THIS job is not a document to send
 * under someone's name.
 *
 * This module DECIDES NOTHING about resume quality or safety. It never re-implements
 * evaluateSafety()/evaluateQualityGate() — it only reads the decisions those authorities (and the
 * approval endpoint, which calls them) already recorded, plus the files those pipelines wrote. It
 * cannot make a resume acceptable.
 */

export type DocumentReadinessSource = "AUTONOMOUS_READY" | "HUMAN_APPROVED_SAFE_ATTEMPT";

export type DocumentReadiness =
  | { ready: true; resumePath: string; coverLetterPath: string | null; workflowId: number; source: DocumentReadinessSource }
  | { ready: false; reason: string; workflowStatus: string | null };

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function resolveApplicationDocuments(input: {
  candidateId: number;
  dedupeKey: string;
  jobId: number;
  companyName: string | null;
}): DocumentReadiness {
  const workflow = getLatestResumeQualityWorkflowForJob(input.candidateId, input.dedupeKey);

  if (!workflow) {
    return {
      ready: false,
      workflowStatus: null,
      reason: "No resume has been generated for this job yet. Open Resume Studio to tailor one.",
    };
  }

  const job = getJob(input.jobId);
  if (!job) {
    return { ready: false, workflowStatus: workflow.status, reason: "The job for this application could not be found." };
  }

  // CASE A — AUTONOMOUS READY. Unchanged semantics: only workflow.status === "READY" ever qualifies,
  // and only when the published manifest actually names THIS workflow.
  if (workflow.status === "READY") {
    const target = resolvePublishedApplicationTarget({
      companyId: job.company_id,
      companyName: job.company_name,
      jobId: job.id,
      jobTitle: job.title,
    });
    const manifest = readJsonFile<PublishedApplicationManifest>(path.join(target.directory, "manifest.json"));
    if (!manifest || manifest.workflowId !== workflow.id) {
      return {
        ready: false,
        workflowStatus: workflow.status,
        reason: "The resume passed validation but its published files are missing. Re-export from Resume Studio.",
      };
    }
    const resumePath = path.join(target.directory, manifest.files.resume);
    if (!fs.existsSync(resumePath)) {
      return { ready: false, workflowStatus: workflow.status, reason: "No generated resume document was found for this job." };
    }
    const coverLetterPath = manifest.files.coverLetter ? path.join(target.directory, manifest.files.coverLetter) : null;
    return {
      ready: true,
      resumePath,
      coverLetterPath: coverLetterPath && fs.existsSync(coverLetterPath) ? coverLetterPath : null,
      workflowId: workflow.id,
      source: "AUTONOMOUS_READY",
    };
  }

  // CASE B — HUMAN-APPROVED SAFE ATTEMPT. Only a terminal FAILED workflow can carry an approval at
  // all (see the approval endpoint, which refuses to approve anything else). The approval lookup is
  // keyed to THIS EXACT workflow_id — a prior job workflow's approval is a different row entirely and
  // is never found here for a newer workflow.id.
  if (workflow.status === "FAILED") {
    const approval = getHumanApprovalForWorkflow(input.candidateId, workflow.id);
    if (approval) {
      const target = resolveSafeAttemptTarget({
        companyId: job.company_id,
        companyName: job.company_name,
        jobId: job.id,
        jobTitle: job.title,
      });
      const manifest = readJsonFile<SafeAttemptManifest>(path.join(target.safeAttemptDirectory, "manifest.json"));
      // The manifest on disk must still describe THIS approved workflow/iteration. A later workflow
      // for the same job that also reached SAFE_BEST_ATTEMPT would overwrite this shared directory —
      // if that happened, the manifest now names a different workflow/iteration than what was
      // approved, and this approval must not be honored against someone else's content.
      if (
        manifest &&
        manifest.workflowId === approval.workflow_id &&
        manifest.selectedIterationNumber === approval.selected_iteration_number
      ) {
        const resumePath = path.join(target.safeAttemptDirectory, manifest.files.resume);
        if (fs.existsSync(resumePath)) {
          const coverLetterPath = path.join(target.safeAttemptDirectory, manifest.files.coverLetter);
          return {
            ready: true,
            resumePath,
            coverLetterPath: fs.existsSync(coverLetterPath) ? coverLetterPath : null,
            workflowId: workflow.id,
            source: "HUMAN_APPROVED_SAFE_ATTEMPT",
          };
        }
      }
      return {
        ready: false,
        workflowStatus: workflow.status,
        reason: "The approved resume's published files could not be verified. Re-review and re-approve in Resume Studio.",
      };
    }
    return {
      ready: false,
      workflowStatus: workflow.status,
      reason: "The resume for this job did not pass validation. Review it in Resume Studio before applying.",
    };
  }

  return {
    ready: false,
    workflowStatus: workflow.status,
    reason: `The resume for this job is still being worked on (${workflow.status.replace(/_/g, " ").toLowerCase()}).`,
  };
}
