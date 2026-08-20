import path from "node:path";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { getJob } from "@/db/queries/jobs";
import { completeTailoringRun, failTailoringRun, getTailoringRun, TailoringRunNotFoundError, TailoringRunNotStartedError } from "@/db/queries/tailoringRuns";

/**
 * Complete or fail a tailoring run — the only two legal transitions out of 'started'
 * (see tailoringRuns.ts's two-phase lifecycle doc comment). A 'completed' or 'failed' run is
 * immutable: any further PATCH attempt is rejected by the query layer (TailoringRunNotStartedError),
 * not silently accepted.
 *
 * Stage 4 (not built yet) is what actually writes tailored output files to a run-scoped directory —
 * this route only records METADATA about output files after the fact, so output_files here are
 * plain relative filenames, never real filesystem paths. Absolute paths and any ".." path-traversal
 * segment are rejected.
 */

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isSafeRelativeFilename(filename: string): boolean {
  if (typeof filename !== "string" || filename.length === 0) return false;
  if (filename.includes("\0")) return false;
  if (path.isAbsolute(filename)) return false;
  const normalized = path.normalize(filename);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`) || normalized.endsWith(`${path.sep}..`)) {
    return false;
  }
  return true;
}

// candidate_id, dedupe_key, approval provenance, source hashes, and decision_at_approval are
// structurally absent from this schema — there is no field here through which a PATCH could change
// any of them, regardless of what a client sends. Unknown keys are silently stripped by zod's
// default non-strict parsing.
const PATCH_SCHEMA = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    validationPassed: z.boolean(),
    outputFiles: z
      .array(z.string())
      .optional()
      .refine((files) => !files || files.every(isSafeRelativeFilename), {
        message: "output_files must be relative filenames with no absolute paths or '..' path traversal",
      }),
    jobFitClassification: z.string().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    failureReason: z.string().min(1),
  }),
]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ candidateId: string; jobId: string; runId: string }> }
): Promise<NextResponse> {
  const { candidateId: candidateIdParam, jobId: jobIdParam, runId: runIdParam } = await params;

  const candidateId = parsePositiveInt(candidateIdParam);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

  const jobId = parsePositiveInt(jobIdParam);
  if (jobId === null) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const runId = parsePositiveInt(runIdParam);
  if (runId === null) return NextResponse.json({ error: "Invalid run id" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const parsed = PATCH_SCHEMA.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  // getTailoringRun already scopes by candidate_id — a run belonging to another candidate is
  // undefined here, not merely hidden. The dedupe_key check on top of that rejects cross-job PATCH
  // attempts (same candidate, wrong job) with the same 404, never leaking which case applied.
  const run = getTailoringRun(candidateId, runId);
  if (!run || run.dedupe_key !== job.dedupe_key) {
    return NextResponse.json({ error: "Tailoring run not found for this candidate/job" }, { status: 404 });
  }

  try {
    if (parsed.data.status === "completed") {
      const updated = completeTailoringRun(candidateId, runId, {
        outputFiles: parsed.data.outputFiles ?? [],
        validationPassed: parsed.data.validationPassed,
        jobFitClassification: parsed.data.jobFitClassification,
      });
      return NextResponse.json({ run: updated });
    }

    const updated = failTailoringRun(candidateId, runId, parsed.data.failureReason);
    return NextResponse.json({ run: updated });
  } catch (err) {
    if (err instanceof TailoringRunNotStartedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof TailoringRunNotFoundError) {
      return NextResponse.json({ error: "Tailoring run not found" }, { status: 404 });
    }
    throw err;
  }
}
