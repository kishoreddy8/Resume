import { NextRequest, NextResponse } from "next/server";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { setNotInterested } from "@/db/queries/candidateJobState";
import { getJob } from "@/db/queries/jobs";

/**
 * Phase 2.5: candidate-personal, NOT global — see CAREER_OPS_HANDOFF.md's Phase 2.5 design record
 * §2/13. This NO LONGER deletes the job row, touches `suppressed_jobs`, or removes generated files —
 * it only records THIS candidate's disinterest in candidate_job_state, keyed on dedupe_key. The job
 * stays fully intact and visible to every other candidate. Reversible (unlike the old delete-based
 * behavior): a second call with `notInterested: false` clears the flag.
 *
 * The OLD global semantics (jobs.ts's markNotInterested — permanent delete + suppressed_jobs
 * fingerprint, used only by the system-generated age-based sweep) are completely untouched and still
 * exist for that purpose; this route simply no longer calls them.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) {
    return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const candidateId = typeof body?.candidateId === "number" ? body.candidateId : null;
  if (candidateId === null) return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });

  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const notInterested = typeof body?.notInterested === "boolean" ? body.notInterested : true;
  const reason = typeof body?.reason === "string" ? body.reason : null;
  const state = setNotInterested(candidateId, job.dedupe_key, notInterested, reason);

  return NextResponse.json({ ok: true, state });
}
