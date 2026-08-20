import { NextRequest, NextResponse } from "next/server";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { z } from "zod";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { getJob } from "@/db/queries/jobs";
import { getLatestResumeQualityWorkflowForJob } from "@/db/queries/resumeQualityWorkflows";
import { exportExternalWriterPackage } from "@/lib/resumeQuality/handoff/exporter";
import { ResumeQualityOrchestrationError } from "@/lib/resumeQuality/orchestrator";

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const EXPORT_SCHEMA = z.object({
  overwrite: z.boolean().optional(),
  targetIterationNumber: z.number().int().positive().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ candidateId: string; jobId: string }> }
): Promise<NextResponse> {
  const { candidateId: candidateIdParam, jobId: jobIdParam } = await params;
  const candidateId = parsePositiveInt(candidateIdParam);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

  const jobId = parsePositiveInt(jobIdParam);
  if (jobId === null) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const workflow = getLatestResumeQualityWorkflowForJob(candidateId, job.dedupe_key);
  if (!workflow) {
    return NextResponse.json({ error: "No quality workflow found for this job" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = EXPORT_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const exportResult = exportExternalWriterPackage({
      candidateId,
      workflowId: workflow.id,
      targetIterationNumber: parsed.data.targetIterationNumber,
      overwriteExisting: parsed.data.overwrite ?? true,
    });

    return NextResponse.json({ ok: true, exportResult });
  } catch (err: unknown) {
    if (err instanceof ResumeQualityOrchestrationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "Failed to export external writer package";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
