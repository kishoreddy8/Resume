import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { archiveJob } from "@/db/queries/jobs";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { requireActiveCandidate } from "@/db/queries/candidates";

const BODY_SCHEMA = z.object({ reason: z.string().optional() });

/**
 * Manually archives a job. Blocked (409) while the job's pipeline_status is Applied or Interview —
 * see src/lib/jobLifecycle.ts's canArchive() for why; archiveJob() enforces the same rule automatic
 * archiving uses during a scan, so it can't be bypassed from either path.
 *
 * ADMIN-SEC-1.1 — that data-layer check, not this route's guard, is what protects one candidate from
 * another: `jobs.is_archived` is a single shared column with no per-candidate scoping, so no route
 * guard at any strictness could make one candidate's archive invisible to the rest. The guard here
 * establishes WHO is asking; isProtectedForAnyCandidate decides whether the shared corpus may change.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  /* ADMIN-SEC-1 — CANDIDATE_MUTATION. This writes to the shared `jobs` corpus, so it is not
   * candidate-OWNED data, but it is reached from the candidate product and must not require the
   * operator boundary: doing so would break the feature for every non-owner profile and for any
   * install without a PIN. The boundary this closes is the real one — it was callable by anyone who
   * could reach the port. candidateId is an explicit query parameter, never inferred, so the request
   * names the profile whose unlocked session is authorising the write. */
  const candidateId = Number(req.nextUrl.searchParams.get("candidateId"));
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  }
  if (!requireActiveCandidate(candidateId)) {
    return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  }
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

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
