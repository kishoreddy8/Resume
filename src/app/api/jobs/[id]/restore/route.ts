import { NextRequest, NextResponse } from "next/server";
import { restoreJob } from "@/db/queries/jobs";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { requireActiveCandidate } from "@/db/queries/candidates";

/**
 * Restores an archived job back to the active jobs view (unconditional — no guardrail blocks this).
 *
 * ADMIN-SEC-1 — deliberately the SAME boundary as its inverse in ../archive. An asymmetry would be
 * the hole: guarding one and leaving the other open lets a caller undo every decision the other
 * made.
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

  const job = restoreJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  return NextResponse.json({ job });
}
