import { NextResponse, type NextRequest } from "next/server";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { getJob } from "@/db/queries/jobs";
import { deserializeJobMatchResult, getLatestJobMatchResult } from "@/db/queries/jobMatches";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";
import { buildTailoringPlan } from "@/lib/tailoringIntelligence/plan";

/**
 * GET — the Tailoring Intelligence plan for one candidate/job pair.
 *
 * READ-ONLY AND RE-USED. This never evaluates a match. It reads the result Phase 2 already
 * persisted, so the plan cannot disagree with the decision the rest of the app shows, and opening
 * this screen costs no evaluation. When no evaluation exists yet it says so rather than quietly
 * running one — a page load is not consent to recompute, and a plan built from a match the user
 * has never seen would be the first thing on screen that nothing else agrees with.
 *
 * It writes nothing, touches no `jobs.*` column, and adds no new projection: every field comes from
 * job_match_results and the validated candidate profile, both of which are already loaded elsewhere
 * in this app for other reasons.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ candidateId: string; jobId: string }> }
) {
  const { candidateId: rawCandidate, jobId: rawJob } = await ctx.params;
  const candidateId = Number(rawCandidate);
  const jobId = Number(rawJob);

  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  }
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  }
  if (!requireActiveCandidate(candidateId)) {
    return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  }
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const row = getLatestJobMatchResult(candidateId, job.dedupe_key);
  if (!row) {
    /* Not an error: this job simply has not been evaluated for this candidate yet. Saying so lets
     * the UI point at the real next step instead of rendering an empty plan that looks like a
     * finding of "no evidence". */
    return NextResponse.json({ status: "not_evaluated", candidateId, jobId }, { status: 200 });
  }

  const result = deserializeJobMatchResult(row);
  const loaded = loadCandidateProfile(candidateId);
  /* Only an accepted profile is used. A missing, stale or invalid one yields a plan without
   * employer emphasis rather than emphasis derived from data the loader rejected. */
  const profile = loaded.status === "ok" ? loaded.profile : null;

  return NextResponse.json({
    status: "ok",
    profileStatus: loaded.status,
    job: { id: job.id, title: job.title, company: job.company_name ?? null },
    plan: buildTailoringPlan(result, profile),
  });
}
