import { NextRequest, NextResponse } from "next/server";
import { restoreJob } from "@/db/queries/jobs";

/** Restores an archived job back to the active jobs view (unconditional — no guardrail blocks this). */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) {
    return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  }

  const job = restoreJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  return NextResponse.json({ job });
}
