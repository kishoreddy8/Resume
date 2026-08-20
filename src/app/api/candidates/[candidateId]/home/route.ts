import { NextResponse, type NextRequest } from "next/server";
import { requireActiveCandidate, getCandidate } from "@/db/queries/candidates";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { getCandidateMatchDecisionCounts } from "@/db/queries/operations";
import { listWaitingRuns } from "@/db/queries/applicationRuns";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";

/**
 * GET — the handful of numbers the home screen states, and nothing else.
 *
 * ONE REQUEST, ALL AGGREGATES. The home screen exists to answer "what should I do next", so it must
 * not cost more than the page it replaces. Every figure here is a COUNT the database already
 * computes; no job rows, no match payloads, no resume content crosses this boundary.
 *
 * EVERY NUMBER IS REAL. Counts come from the match engine's own decision tallies and from runs the
 * user actually has. There is no "profile strength", no readiness percentage, no streak — the app
 * does not know those things, and a home screen is exactly where an invented number would be most
 * believed.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await ctx.params;
  const candidateId = Number(raw);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  }
  if (!requireActiveCandidate(candidateId)) {
    return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  }
  const denial = requireCandidateAccess(req, candidateId);
  if (denial) return denial;

  const candidate = getCandidate(candidateId);
  const counts = getCandidateMatchDecisionCounts(candidateId);
  const waiting = listWaitingRuns(candidateId);
  const profile = loadCandidateProfile(candidateId);

  return NextResponse.json({
    candidateId,
    firstName: candidate?.first_name ?? null,
    /* The engine's own decision tallies, passed through unchanged. */
    jobs: {
      readyForTailoring: counts.readyForTailoring,
      needsReview: counts.needsReview,
      evaluated: counts.readyForTailoring + counts.needsReview + counts.blocked,
    },
    applications: {
      waitingOnYou: waiting.length,
      /* What they are waiting for, so the home screen can name it rather than say "3 things". */
      reasons: [...new Set(waiting.map((r) => r.status))],
    },
    profile: {
      status: profile.status,
      skills: profile.status === "ok" ? profile.profile.skills.length : 0,
      employers: profile.status === "ok" ? profile.profile.experience.length : 0,
    },
  });
}
