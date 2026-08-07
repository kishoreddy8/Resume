import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getJob, updateJobPipeline } from "@/db/queries/jobs";
import type { PipelineStatus } from "@/types";

const PATCH_SCHEMA = z.object({
  pipelineStatus: z
    .enum(["New", "Interested", "Applied", "Interview", "Rejected", "Offer"])
    .optional(),
  markedForTailoring: z.boolean().optional(),
});

function listGeneratedFiles(jobId: number): string[] {
  const dir = path.join(process.cwd(), "data", "generated", String(jobId));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith("."))
    .sort();
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) {
    return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  }
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  return NextResponse.json({ job, generatedFiles: listGeneratedFiles(jobId) });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) {
    return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = PATCH_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const job = updateJobPipeline(jobId, {
    pipelineStatus: parsed.data.pipelineStatus as PipelineStatus | undefined,
    markedForTailoring: parsed.data.markedForTailoring,
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  return NextResponse.json({ job });
}
