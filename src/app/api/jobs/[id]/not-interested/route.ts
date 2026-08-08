import { NextRequest, NextResponse } from "next/server";
import { markNotInterested } from "@/db/queries/jobs";
import { deleteGeneratedFiles } from "@/lib/generatedFiles";

/**
 * "Not Interested" is an action, not a settable pipeline_status (see the PipelineStatus doc
 * comment in src/types/index.ts) — it immediately and permanently deletes the job record, safely
 * removes any generated resume/cover-letter/report files for it, and leaves a lightweight
 * suppression fingerprint (src/db/queries/jobs.ts's markNotInterested) so the exact same requisition
 * never silently reappears on a later scan. Irreversible — unlike Archive, there is no restore.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) {
    return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  }

  const deleted = markNotInterested(jobId);
  if (!deleted) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  deleteGeneratedFiles(deleted.companyName, deleted.jobId);

  return NextResponse.json({ ok: true, deleted });
}
