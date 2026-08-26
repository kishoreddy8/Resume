import { NextResponse, type NextRequest } from "next/server";
import { requireActiveCandidate, getCandidate } from "@/db/queries/candidates";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { listWaitingRuns } from "@/db/queries/applicationRuns";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";
import { getDb } from "@/db";
import { FRESHNESS_PRIMARY_MAX_DAYS, FRESHNESS_SECONDARY_MAX_DAYS } from "@/lib/rank/forYou";

/**
 * GET — everything the home screen states, in one request.
 *
 * ONE ENDPOINT, ALL AGGREGATES. Home exists to answer "what should I do next", so it must cost less
 * than the pages it points at. Counts come from tallies the database already computes; the
 * recommended jobs themselves are read from the same match-decision + For You feed the Jobs page
 * uses (fetched separately by the client, not recomputed here — see UI-H's audit note below), and no
 * resume body, application history or job description crosses this boundary.
 *
 * EVERY FIGURE IS REAL. There is no profile strength, no readiness score, no market signal, no
 * confidence number. The app does not know those things, and a home screen is exactly where an
 * invented one would be most believed. Where nothing is known, the field is empty and the UI says
 * so rather than filling the space.
 *
 * UI-H — REMOVED THREE UNUSED QUERIES. This route previously also computed a second, unused set of
 * "recommended" jobs directly from job_match_results, a match-decision tally
 * (readyForTailoring/needsReview/evaluated), and a resume-workflow completion tally
 * (resumesCreated/resumesThisWeek) — none of which the candidate-facing page has ever read (grep
 * confirmed zero references in src/app/home/page.tsx). Home's own recommended-jobs card reuses the
 * client's existing For You fetch instead (see Part 6 of the UI-H spec: reuse the real feed, never a
 * second ranking path), so this route computing its own competing set was dead weight, not a second
 * source of truth anything depended on. Removed rather than left to rot, per "cost less than the
 * pages it points at."
 *
 * UI-H.1 — ADDED THEN REMOVED A FOURTH FIELD. This route briefly also returned an
 * `answerMemoryCount` for a "saved answers" card under Home's "Ready for you" section. On checkpoint
 * review that card didn't answer "what is ready for me to ACT on" — a saved answer is a passive,
 * always-available resource with no pending task attached, not a completed work product like a
 * ready resume — so the card was removed from src/app/home/page.tsx, and the query removed here
 * with it rather than left to become a fifth unused field the next audit would have to rediscover.
 */

interface ActivityItem {
  at: string;
  /** The notification's own type. The UI titles the row from this rather than parsing prose. */
  type: string;
  /** The recorded title, verbatim. Never rewritten here — the UI shortens the display only. */
  text: string;
}

/** A run that has stopped for a person, named by the job it is for. */
interface WaitingRun {
  id: number;
  status: string;
  title: string | null;
  company: string | null;
}

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

  const db = getDb();
  const candidate = getCandidate(candidateId);
  const waiting = listWaitingRuns(candidateId);
  const profile = loadCandidateProfile(candidateId);

  /* Recent activity, from events that were actually recorded. Notifications are already written for
   * a person to read, so they are used verbatim rather than re-worded into something vaguer. */
  const activity: ActivityItem[] = (
    db
      .prepare(
        `SELECT type, title, created_at FROM notifications
          WHERE candidate_id = ? ORDER BY id DESC LIMIT 6`
      )
      .all(candidateId) as { type: string; title: string; created_at: string }[]
  ).map((n) => ({ at: n.created_at, type: n.type, text: n.title }));

  /* NEW OPPORTUNITIES — what is worth opening right now.
   *
   * Three conditions, all of them the app's own: the engine cleared the job's evidence bar, the
   * posting is still live, and the candidate has not dismissed it. Freshness reuses For You's
   * exported thresholds rather than a number invented here, so "fresh" means the same thing on the
   * home screen as it does in the ranking (see src/lib/rank/forYou.ts — imported, never modified).
   *
   * It is deliberately NOT the raw ready-for-tailoring tally: on the active profile that tally is
   * 19 and this is 15, because four are stale or dismissed. Counting every non-blocked pair instead
   * returned 11,049 in 4.7s — true, useless to read, and far too slow for this endpoint. */
  const opportunities = db
    .prepare(
      `SELECT
         COUNT(*) AS fresh,
         SUM(CASE WHEN j.posted_at IS NOT NULL
                   AND julianday('now') - julianday(j.posted_at) <= @primaryDays
                  THEN 1 ELSE 0 END) AS recent
         FROM job_match_results m
         JOIN jobs j ON j.dedupe_key = m.dedupe_key
    LEFT JOIN candidate_job_state s
           ON s.candidate_id = m.candidate_id AND s.dedupe_key = m.dedupe_key
        WHERE m.candidate_id = @candidateId
          AND m.status = 'active'
          AND m.decision = 'READY_FOR_TAILORING'
          AND j.is_active = 1 AND j.is_archived = 0
          AND COALESCE(s.not_interested, 0) = 0
          AND (j.posted_at IS NULL
               OR julianday('now') - julianday(j.posted_at) <= @secondaryDays)`
    )
    .get({
      candidateId,
      primaryDays: FRESHNESS_PRIMARY_MAX_DAYS,
      secondaryDays: FRESHNESS_SECONDARY_MAX_DAYS,
    }) as { fresh: number; recent: number | null };

  /* The waiting runs, named by the job they are for. `listWaitingRuns` already decided WHICH states
   * count as waiting — that set is not restated here — and only the first three are titled, since
   * the rail shows three. */
  const shortlist = waiting.slice(0, 3);
  const titles = new Map<number, { title: string; company: string | null }>();
  if (shortlist.length > 0) {
    const placeholders = shortlist.map(() => "?").join(",");
    for (const r of db
      .prepare(
        `SELECT j.id AS id, j.title AS title, c.name AS company
           FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
          WHERE j.id IN (${placeholders})`
      )
      .all(...shortlist.map((r) => r.job_id)) as { id: number; title: string; company: string | null }[]) {
      titles.set(r.id, { title: r.title, company: r.company });
    }
  }
  const waitingRuns: WaitingRun[] = shortlist.map((r) => ({
    id: r.id,
    status: r.status,
    title: titles.get(r.job_id)?.title ?? null,
    company: titles.get(r.job_id)?.company ?? null,
  }));

  return NextResponse.json({
    candidateId,
    firstName: candidate?.first_name ?? null,
    jobs: {
      /* Candidate-facing: fresh, relevant, undismissed. See the query above. */
      newOpportunities: opportunities.fresh,
      newOpportunitiesRecent: opportunities.recent ?? 0,
    },
    applications: {
      waitingOnYou: waiting.length,
      /* The single most pressing one, for the primary action card. */
      first: waiting[0]
        ? { id: waiting[0].id, status: waiting[0].status, question: waiting[0].blocking_question }
        : null,
      waiting: waitingRuns,
    },
    profile: {
      status: profile.status,
    },
    activity,
  });
}
