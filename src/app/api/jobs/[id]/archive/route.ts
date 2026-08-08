import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { archiveJob } from "@/db/queries/jobs";

const BODY_SCHEMA = z.object({ reason: z.string().optional() });

/**
 * Manually archives a job. Blocked (409) while the job's pipeline_status is Applied or Interview —
 * see src/lib/jobLifecycle.ts's canArchive() for why; archiveJob() enforces the same rule automatic
 * archiving uses during a scan, so it can't be bypassed from either path.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) {
    return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result = archiveJob(jobId, parsed.data.reason);
  if (!result.ok) {
    const status = result.blockedReason === "Job not found" ? 404 : 409;
    return NextResponse.json({ error: result.blockedReason }, { status });
  }

  return NextResponse.json({ job: result.job });
}
