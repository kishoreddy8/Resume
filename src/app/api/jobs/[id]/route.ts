import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { setMarkedForTailoring, setNotesAndTags, setPinned, setPipelineStatus } from "@/db/queries/candidateJobState";
import { getJob } from "@/db/queries/jobs";
import { getJobCertifications, getJobSkills } from "@/db/queries/jobIntel";
import { generatedFilesDir } from "@/lib/generatedFiles";
import type { PipelineStatus } from "@/types";

const PATCH_SCHEMA = z.object({
  candidateId: z.number().int().positive(),
  pipelineStatus: z
    .enum(["New", "Interested", "Applied", "Interviewing", "Offer", "Employer Rejected"])
    .optional(),
  markedForTailoring: z.boolean().optional(),
  notes: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  pinned: z.boolean().optional(),
});

/** Tailored output lives at data/generated/<company-slug>/<job-id>/ — written by the tailor-resume
 * skill's engine (tools/tailoring-engine/generate.ts), not by this app. */
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

function parseCandidateId(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const candidateId = Number(raw);
  return Number.isInteger(candidateId) && candidateId > 0 ? candidateId : undefined;
}

/** candidateId is optional here (unlike PATCH) — a job can still be viewed without one, it just
 *  won't show candidate-scoped pipeline/pinned/notes/tags overlaid (falls back to the frozen legacy
 *  snapshot). Every real UI call passes it via the active-candidate selector. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) {
    return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  }
  const candidateId = parseCandidateId(req.nextUrl.searchParams.get("candidateId"));
  const job = getJob(jobId, candidateId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  return NextResponse.json({
    job,
    generatedFiles: listGeneratedFiles(job.company_name, jobId),
    skills: getJobSkills(jobId),
    certifications: getJobCertifications(jobId),
  });
}

/**
 * Phase 2.5: every field this route mutates (pipelineStatus/markedForTailoring/notes/tags/pinned) is
 * now candidate-personal workflow state — writes go through candidate_job_state, never the legacy
 * jobs.* columns (see CAREER_OPS_HANDOFF.md's Phase 2.5 design record §1). candidateId is required.
 */
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
  if (!requireActiveCandidate(parsed.data.candidateId)) {
    return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  }

  const existing = getJob(jobId);
  if (!existing) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const dedupeKey = existing.dedupe_key;
  const candidateId = parsed.data.candidateId;

  if (parsed.data.pipelineStatus !== undefined) {
    setPipelineStatus(candidateId, dedupeKey, parsed.data.pipelineStatus as PipelineStatus);
  }
  if (parsed.data.markedForTailoring !== undefined) {
    setMarkedForTailoring(candidateId, dedupeKey, parsed.data.markedForTailoring);
  }
  if (parsed.data.notes !== undefined || parsed.data.tags !== undefined) {
    const currentState = getJob(jobId, candidateId)!;
    setNotesAndTags(
      candidateId,
      dedupeKey,
      parsed.data.notes !== undefined ? parsed.data.notes : currentState.notes,
      parsed.data.tags !== undefined ? parsed.data.tags : currentState.tags ? JSON.parse(currentState.tags) : null
    );
  }
  if (parsed.data.pinned !== undefined) {
    setPinned(candidateId, dedupeKey, parsed.data.pinned);
  }

  const job = getJob(jobId, candidateId);
  return NextResponse.json({ job });
}
