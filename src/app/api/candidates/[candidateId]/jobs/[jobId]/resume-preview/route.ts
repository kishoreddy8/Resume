import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { getJob } from "@/db/queries/jobs";
import { getLatestResumeQualityWorkflowForJob } from "@/db/queries/resumeQualityWorkflows";
import {
  getFinalDirectory,
  getHumanReviewDirectory,
  type QualityWorkflowLocation,
} from "@/lib/resumeQuality/workspace";

/**
 * The tailored resume as readable content, so it can be looked at before it is downloaded.
 *
 * WHY THIS IS NOT THE ARTIFACTS ROUTE. That route streams the .docx, and a browser cannot render a
 * .docx — following it just downloads the file, which is the thing a preview is meant to avoid.
 * Converting Word to HTML server-side would mean adding a document-parsing dependency to look at
 * something the pipeline already has in a structured form: `resume_content.json` is written beside
 * the .docx and IS what the generator rendered, so reading it shows the same content without
 * inventing a second rendering path or trusting a converter.
 *
 * WHICH PACKAGE IT READS, AND WHY THAT IS STATED. A READY workflow has an approved package under
 * `final/`. A FAILED one has the preserved best attempt under `human-review/` — real content that
 * did NOT clear the gate. Both are previewable, because seeing what went wrong is exactly when a
 * person wants to look before re-tailoring, but the response says which one it is so the UI can
 * never present a best attempt as an approved document.
 *
 * IT GRANTS NOTHING. Read-only, no state change, no sendability implication: `packageKind` is
 * reported, never interpreted, and this route cannot mark anything approved.
 */

const DOCS = ["resume", "coverLetter"] as const;
type Doc = (typeof DOCS)[number];

const FILENAME: Record<Doc, string> = {
  resume: "resume_content.json",
  coverLetter: "cover_letter_content.json",
};

export type ResumePreviewPackage = "final" | "best-attempt";

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Reject anything that is not a plain JSON object, so a malformed file cannot reach the client. */
function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    /* Bounded on purpose: these files measure a few kilobytes, and a preview endpoint should not be
     * a way to stream an arbitrarily large file out of the workspace. */
    const stat = fs.statSync(file);
    if (stat.size > 512_000) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ candidateId: string; jobId: string }> }
): Promise<NextResponse> {
  const { candidateId: candidateIdParam, jobId: jobIdParam } = await params;

  const candidateId = parsePositiveInt(candidateIdParam);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) {
    return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  }
  const denial = requireCandidateAccess(req, candidateId);
  if (denial) return denial;

  const jobId = parsePositiveInt(jobIdParam);
  if (jobId === null) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const docParam = req.nextUrl.searchParams.get("doc") ?? "resume";
  if (!DOCS.includes(docParam as Doc)) {
    return NextResponse.json({ error: `Invalid doc. Allowed: ${DOCS.join(", ")}` }, { status: 400 });
  }
  const doc = docParam as Doc;

  const workflow = getLatestResumeQualityWorkflowForJob(candidateId, job.dedupe_key);
  if (!workflow) return NextResponse.json({ error: "No quality workflow found for this job" }, { status: 404 });

  const location: QualityWorkflowLocation = {
    candidateId,
    dedupeKey: workflow.dedupe_key,
    runId: workflow.tailoring_run_id,
    workflowId: workflow.id,
  };

  /* Approved package first, preserved best attempt second. The order mirrors the artifacts route:
   * a human-review document is never served in place of an approved one. */
  const candidates: { dir: string; kind: ResumePreviewPackage }[] = [
    { dir: getFinalDirectory(location), kind: "final" },
    { dir: getHumanReviewDirectory(location), kind: "best-attempt" },
  ];

  for (const { dir, kind } of candidates) {
    const content = readJsonObject(path.join(dir, FILENAME[doc]));
    if (content) {
      return NextResponse.json({
        doc,
        packageKind: kind,
        workflowStatus: workflow.status,
        iteration: workflow.current_iteration,
        content,
      });
    }
  }

  return NextResponse.json({ error: "No readable content for this document" }, { status: 404 });
}
