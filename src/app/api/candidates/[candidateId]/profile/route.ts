import { NextResponse, type NextRequest } from "next/server";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";
import { getJobSkillCorpusSize, getJobSkillSignal } from "@/db/queries/jobSkillSignal";

/**
 * GET /api/candidates/:candidateId/profile
 *
 * Read-only. Serves the derived candidate profile that already backs Phase 2 matching, plus the
 * corpus skill signal, so the Candidate Intelligence page can render evidence the browser
 * previously had no way to reach.
 *
 * Deliberate properties:
 *  - It REUSES loadCandidateProfile rather than reading the file itself, so the missing/stale/
 *    invalid contract that protects matching is the same contract here. A stale profile is
 *    reported as stale and its contents are NOT returned; the page must not present evidence
 *    derived from a resume the user has since replaced.
 *  - It computes nothing. No scoring, no ranking, no inference — the profile is passed through and
 *    the signal is a GROUP BY.
 *  - It writes nothing.
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

  const loaded = loadCandidateProfile(candidateId);
  const signal = getJobSkillSignal();
  const corpusJobs = getJobSkillCorpusSize();

  if (loaded.status !== "ok") {
    // Never return partial profile contents for a stale/invalid profile — the reason is the answer.
    return NextResponse.json({
      status: loaded.status,
      error: loaded.status === "invalid" ? loaded.error : null,
      profile: null,
      signal,
      corpusJobs,
    });
  }

  return NextResponse.json({ status: "ok", error: null, profile: loaded.profile, signal, corpusJobs });
}
