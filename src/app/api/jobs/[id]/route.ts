import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getJob, setJobPinned, updateJobPipeline } from "@/db/queries/jobs";
import { generatedFilesDir } from "@/lib/generatedFiles";
import type { PipelineStatus } from "@/types";

const PATCH_SCHEMA = z.object({
  pipelineStatus: z
    .enum(["New", "Interested", "Applied", "Interviewing", "Offer", "Employer Rejected"])
    .optional(),
  markedForTailoring: z.boolean().optional(),
  notes: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  pinned: z.boolean().optional(),
});

/** Tailored output lives at data/generated/<company-slug>/<job-id>/ — written by the tailor-resume
 * skill's engine (.claude/skills/tailor-resume/engine/generate.ts), not by this app. */
function listGeneratedFiles(companyName: string, jobId: number): string[] {
  const dir = generatedFilesDir(companyName, jobId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    // Hidden dotfiles and Office/OS lock artifacts (e.g. "~$Resume.docx" from an app that had the
    // file open) aren't real deliverables — don't surface them as if they were.
    .filter((f) => !f.startsWith(".") && !f.startsWith("~$"))
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

  return NextResponse.json({ job, generatedFiles: listGeneratedFiles(job.company_name, jobId) });
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

  let job = updateJobPipeline(jobId, {
    pipelineStatus: parsed.data.pipelineStatus as PipelineStatus | undefined,
    markedForTailoring: parsed.data.markedForTailoring,
    notes: parsed.data.notes,
    tags: parsed.data.tags,
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  if (parsed.data.pinned !== undefined) {
    job = setJobPinned(jobId, parsed.data.pinned) ?? job;
  }

  return NextResponse.json({ job });
}
