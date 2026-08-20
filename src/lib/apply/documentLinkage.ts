import fs from "node:fs";
import path from "node:path";
import { getLatestResumeQualityWorkflowForJob } from "@/db/queries/resumeQualityWorkflows";
import { generatedFilesDir } from "@/lib/generatedFiles";

/**
 * Which documents an application run is allowed to upload.
 *
 * THE RULE. Only a resume the existing quality pipeline has actually taken to READY may be sent. A
 * run with anything less pauses and points at Resume Studio. There is no "best available" fallback
 * and no reaching for an older file: a resume that has not passed validation for THIS job is not a
 * document to send under someone's name, and a near-miss here is a real application containing
 * claims the validators rejected.
 *
 * This module DECIDES NOTHING about resume quality. It reads the workflow status the existing
 * pipeline recorded and the files that pipeline wrote. It cannot make a resume acceptable.
 */

export type DocumentReadiness =
  | { ready: true; resumePath: string; coverLetterPath: string | null; workflowId: number }
  | { ready: false; reason: string; workflowStatus: string | null };

/** Filenames the existing generator writes. Matched case-insensitively, never invented. */
const RESUME_PATTERN = /resume.*\.docx$/i;
const COVER_PATTERN = /cover.*\.docx$/i;

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

  /* READY is the only acceptable status. The pipeline's other terminal state carries a resume that
   * did not clear the gate, and a human deciding to keep it is not the same as it having passed —
   * that decision belongs in Resume Studio, not in an upload. */
  if (workflow.status !== "READY") {
    return {
      ready: false,
      workflowStatus: workflow.status,
      reason:
        workflow.status === "FAILED"
          ? "The resume for this job did not pass validation. Review it in Resume Studio before applying."
          : `The resume for this job is still being worked on (${workflow.status.replace(/_/g, " ").toLowerCase()}).`,
    };
  }

  const dir = generatedFilesDir(input.companyName ?? "", input.jobId);
  if (!fs.existsSync(dir)) {
    return {
      ready: false,
      workflowStatus: workflow.status,
      reason: "The resume passed validation but its generated files are missing. Re-export from Resume Studio.",
    };
  }

  const files = fs.readdirSync(dir).filter((f) => !f.startsWith("."));
  const resume = files.find((f) => RESUME_PATTERN.test(f));
  if (!resume) {
    return {
      ready: false,
      workflowStatus: workflow.status,
      reason: "No generated resume document was found for this job.",
    };
  }

  const cover = files.find((f) => COVER_PATTERN.test(f));

  return {
    ready: true,
    resumePath: path.join(dir, resume),
    /* A cover letter is genuinely optional — its absence is not a reason to stop an application. */
    coverLetterPath: cover ? path.join(dir, cover) : null,
    workflowId: workflow.id,
  };
}
