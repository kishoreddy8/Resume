import { NextRequest, NextResponse } from "next/server";
import { getJob, getJobHistory } from "@/db/queries/jobs";

/** Full pipeline-status + lifecycle (Active/Closed/Archived) audit trail for one job, newest first. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) {
    return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  }
  if (!getJob(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  return NextResponse.json({ history: getJobHistory(jobId) });
}
