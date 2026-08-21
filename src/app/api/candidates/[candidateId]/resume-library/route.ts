import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { getCandidate, requireActiveCandidate } from "@/db/queries/candidates";
import { getJobByDedupeKey } from "@/db/queries/jobs";
import { getCompany } from "@/db/queries/companies";
import {
  listAllLatestResumeQualityWorkflowsForCandidate,
  listResumeQualityIterations,
} from "@/db/queries/resumeQualityWorkflows";
import { evaluateQualityGate } from "@/lib/resumeQuality/qualityGate";
import { evaluateApplicationReadiness } from "@/lib/resumeQuality/applicationReadiness";
import { canRevalidate, isLegacyReviewMissingTypedSafetyAnalysis } from "@/lib/resumeQuality/legacyReview";
import {
  finalCoverLetterFilename,
  finalResumeFilename,
  getFinalDirectory,
  getHumanReviewDirectory,
  type QualityWorkflowLocation,
} from "@/lib/resumeQuality/workspace";
import type { StructuredResumeReview } from "@/lib/resumeQuality/types";

/**
 * Every tailored resume this candidate has, as a list.
 *
 * WHY A NEW ROUTE. There was no way to ask "what resumes do I have". The only read path was
 * per-job — /jobs/<id>/quality-workflow — which returns every iteration, the full review JSON and
 * the publication record, measured between 4.5KB and 29KB for ONE job. Asking it eleven times to
 * draw a library would move roughly a quarter of a megabyte to render eleven rows.
 *
 * WHAT IT RETURNS. One bounded row per workflow: who the job was, what state the resume is in, and
 * whether the two documents exist on disk. It never returns a review, an iteration list, an
 * instruction-compliance block, a document body, or a filesystem path.
 *
 * IT DECIDES NOTHING NEW. Gate, readiness and the legacy-review test are the same four functions
 * the per-job route calls, given the same inputs; this route is an iteration over them, not a
 * second opinion. In particular `humanMaySend` is passed through untouched and no branch here can
 * turn a workflow status of READY into a sendable package — that distinction is exactly what the
 * legacy fail-closed behaviour depends on.
 */

export interface ResumeLibraryEntry {
  jobId: number | null;
  dedupeKey: string;
  company: string | null;
  title: string | null;
  location: string | null;
  ats: string | null;
  workflowId: number;
  workflowStatus: string;
  iteration: number;
  updatedAt: string | null;
  /** Engine output, passed through. */
  readiness: import("@/lib/resumeQuality/applicationReadiness").ApplicationReadiness | null;
  humanMaySend: boolean | null;
  blockingReason: string | null;
  qualityGatePassed: boolean | null;
  overallScore: number | null;
  isLegacyMissingAnalysis: boolean;
  canRevalidate: boolean;
  /**
   * Presence only — never a path, never contents.
   *
   * `packageKind` distinguishes an APPROVED package under final/ from the preserved best attempt a
   * FAILED workflow leaves under human-review/. Both are real documents worth looking at — seeing
   * what went wrong is when you most want to before re-tailoring — but they must never be presented
   * as the same thing, so which one it is travels with the flags rather than being guessed from the
   * workflow status downstream.
   */
  documents: { resume: boolean; coverLetter: boolean; packageKind: "final" | "best-attempt" | null };
}

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Which documents exist, and which package they belong to. Existence only — no file is opened.
 *
 * The approved package is checked first so a preserved best attempt can never be reported in place
 * of an approved one, matching the artifacts route's own ordering.
 */
function documentPresence(
  location: QualityWorkflowLocation,
  firstName: string
): { resume: boolean; coverLetter: boolean; packageKind: "final" | "best-attempt" | null } {
  try {
    const finalDir = getFinalDirectory(location);
    const finalResume = fs.existsSync(path.join(finalDir, finalResumeFilename(firstName)));
    const finalCover = fs.existsSync(path.join(finalDir, finalCoverLetterFilename(firstName)));
    if (finalResume || finalCover) {
      return { resume: finalResume, coverLetter: finalCover, packageKind: "final" };
    }

    /* Stage 13's preservation package. A FAILED workflow keeps its best attempt here, and the
     * library used to report those rows as having no documents at all — which read as "nothing was
     * produced" when in fact a resume exists and is the very thing worth re-tailoring from. */
    const hrDir = getHumanReviewDirectory(location);
    const hrResume = fs.existsSync(path.join(hrDir, "resume_content.json"));
    const hrCover = fs.existsSync(path.join(hrDir, "cover_letter_content.json"));
    if (hrResume || hrCover) {
      return { resume: hrResume, coverLetter: hrCover, packageKind: "best-attempt" };
    }

    return { resume: false, coverLetter: false, packageKind: null };
  } catch {
    /* A workspace that cannot be read is reported as having no documents rather than failing the
     * whole library — one unreadable directory should not blank the page. */
    return { resume: false, coverLetter: false, packageKind: null };
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ candidateId: string }> }
): Promise<NextResponse> {
  const { candidateId: raw } = await params;
  const candidateId = parsePositiveInt(raw);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) {
    return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  }
  const denial = requireCandidateAccess(req, candidateId);
  if (denial) return denial;

  const candidate = getCandidate(candidateId);
  const firstName = candidate?.first_name ?? "Candidate";

  const workflows = listAllLatestResumeQualityWorkflowsForCandidate(candidateId);
  const entries: ResumeLibraryEntry[] = [];

  for (const [dedupeKey, workflow] of Object.entries(workflows)) {
    const job = getJobByDedupeKey(dedupeKey);

    let readiness: import("@/lib/resumeQuality/applicationReadiness").ApplicationReadiness | null = null;
    let humanMaySend: boolean | null = null;
    let blockingReason: string | null = null;
    let qualityGatePassed: boolean | null = null;
    let overallScore: number | null = null;
    let isLegacy = false;

    const iterations = listResumeQualityIterations(candidateId, workflow.id);
    const latest = iterations[iterations.length - 1];
    if (latest?.review_json) {
      try {
        const review = JSON.parse(latest.review_json) as StructuredResumeReview;
        overallScore = review.overallScore ?? null;
        qualityGatePassed =
          evaluateQualityGate(review, latest.iteration_number, workflow.max_iterations) === "READY";
        const result = evaluateApplicationReadiness(review, latest.iteration_number, workflow.max_iterations);
        readiness = result.readiness;
        humanMaySend = result.humanMaySend;
        blockingReason = result.blockingReasons[0] ?? result.improvementReasons[0] ?? null;
        isLegacy = isLegacyReviewMissingTypedSafetyAnalysis(review);
      } catch {
        /* An unparseable review is treated as no review: the row shows "Not validated yet" rather
         * than a guess, and nothing about it becomes sendable. */
      }
    }

    entries.push({
      jobId: job?.id ?? null,
      dedupeKey,
      company: job ? (getCompany(job.company_id)?.name ?? null) : null,
      title: job?.title ?? null,
      location: job?.location ?? null,
      ats: job?.source_type ?? null,
      workflowId: workflow.id,
      workflowStatus: workflow.status,
      iteration: workflow.current_iteration,
      updatedAt: workflow.updated_at ?? null,
      readiness,
      humanMaySend,
      blockingReason,
      qualityGatePassed,
      overallScore,
      isLegacyMissingAnalysis: isLegacy,
      canRevalidate: canRevalidate(workflow),
      documents: documentPresence(
        { candidateId, dedupeKey, runId: workflow.tailoring_run_id, workflowId: workflow.id },
        firstName
      ),
    });
  }

  /* Newest first. A stable secondary key so equal timestamps do not reshuffle between requests. */
  entries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || b.workflowId - a.workflowId);

  return NextResponse.json({ candidateId, entries });
}
