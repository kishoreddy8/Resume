import { NextResponse, type NextRequest } from "next/server";
import { requireActiveCandidate, getCandidate } from "@/db/queries/candidates";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { getCandidateMatchDecisionCounts } from "@/db/queries/operations";
import { listWaitingRuns } from "@/db/queries/applicationRuns";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";
import { deserializeJobMatchResult, type JobMatchResultRow } from "@/db/queries/jobMatches";
import { getDb } from "@/db";
import { FRESHNESS_PRIMARY_MAX_DAYS, FRESHNESS_SECONDARY_MAX_DAYS } from "@/lib/rank/forYou";

/**
 * GET — everything the home screen states, in one request.
 *
 * ONE ENDPOINT, ALL AGGREGATES. Home exists to answer "what should I do next", so it must cost less
 * than the pages it points at. Counts come from tallies the database already computes; the three
 * recommended jobs are three rows, not a ranked page; and no resume, no application history and no
 * job description crosses this boundary.
 *
 * EVERY FIGURE IS REAL. There is no profile strength, no readiness score, no market signal, no
 * confidence number. The app does not know those things, and a home screen is exactly where an
 * invented one would be most believed. Where nothing is known, the field is empty and the UI says
 * so rather than filling the space.
 *
 * NOTHING IS RE-RANKED HERE. The recommended jobs are read from the decisions the matching engine
 * already persisted, ordered by the score it already assigned. This route computes no relevance of
 * its own and changes no ranking contract.
 *
 * THE EXTRA FIELDS ARE PRESENTATION, NOT NEW KNOWLEDGE. `score`, `postedAt`, the requirement tallies
 * and the waiting-run titles are all columns and buckets that were already persisted and already
 * read on this path — they are returned so the card can show a job the way the job pages show it,
 * instead of the client fetching a job detail per row to learn the same facts. No value here is
 * derived, weighted or recomputed.
 */

interface RecommendedJob {
  id: number;
  title: string;
  company: string | null;
  location: string | null;
  source: string | null;
  /** The engine's own weighted score, 0-100, rounded exactly as the jobs list rounds it. */
  score: number;
  /** When the employer published it. Null for boards that do not state one — then `firstSeenAt`
   *  is used and the UI says "seen", never "posted", because those are different claims. */
  postedAt: string | null;
  firstSeenAt: string;
  /** Requirements THIS candidate can evidence at a named employer. Read, never derived. */
  evidence: string[];
  /** Tallies behind the chips: how many requirements are employer-evidenced, and how many the
   *  engine found in the description at all. */
  evidenced: number;
  requirements: number;
}

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
  const counts = getCandidateMatchDecisionCounts(candidateId);
  const waiting = listWaitingRuns(candidateId);
  const profile = loadCandidateProfile(candidateId);

  /* Three jobs the engine already decided are ready, in the order it already scored them. Selected
   * with a LIMIT so this stays three rows even against 150,000 evaluated pairs.
   *
   * status = 'active' IS LOAD-BEARING. job_match_results keeps every snapshot it has ever written
   * for a job and marks the outdated ones 'superseded' — one job here had seven rows across four
   * engine versions. Without this filter the "top three" were three copies of the SAME job: three
   * identical cards, one priority (the dedupe there hid half of it), and three React children
   * sharing a key. getCandidateMatchDecisionCounts filters on exactly this column for exactly this
   * reason; this query simply has to agree with it.
   *
   * It is a correctness filter, not a ranking change: the ordering is still the engine's own
   * overall_score, and the row chosen per job is the one the engine currently considers true. */
  const topRows = db
    .prepare(
      `SELECT m.*, j.id AS j_id, j.title AS j_title, j.location AS j_location,
              j.source_type AS j_source, j.posted_at AS j_posted, j.first_seen_at AS j_seen,
              c.name AS c_name
         FROM job_match_results m
         JOIN jobs j ON j.dedupe_key = m.dedupe_key
    LEFT JOIN companies c ON c.id = j.company_id
        WHERE m.candidate_id = ?
          AND m.status = 'active'
          AND m.decision = 'READY_FOR_TAILORING'
          AND j.is_active = 1 AND j.is_archived = 0
     ORDER BY m.overall_score DESC
        LIMIT 3`
    )
    .all(candidateId) as (JobMatchResultRow & {
    j_id: number;
    j_title: string;
    j_location: string | null;
    j_source: string | null;
    j_posted: string | null;
    j_seen: string;
    c_name: string | null;
  })[];

  const recommended: RecommendedJob[] = topRows.map((row) => {
    let evidence: string[] = [];
    let evidenced = 0;
    let requirements = 0;
    try {
      /* The engine's own employer-evidenced matches. Not a keyword list and not re-derived — if the
       * card names a skill, the resume can support it at a named employer. */
      const result = deserializeJobMatchResult(row);
      evidence = result.employerEvidencedMatches.slice(0, 4).map((m) => m.requirement.label);
      evidenced = result.employerEvidencedMatches.length;
      /* Every requirement the engine extracted, whichever bucket it landed in. The denominator has
       * to be the whole set or "4 of 4" would be true of a job with eight unmet requirements. */
      requirements =
        result.employerEvidencedMatches.length +
        result.inventoryOnlyMatches.length +
        result.transferableMatches.length +
        result.missingRequirements.length +
        result.unresolvedRequirements.length;
    } catch {
      evidence = [];
    }
    return {
      id: row.j_id,
      title: row.j_title,
      company: row.c_name,
      location: row.j_location,
      source: row.j_source,
      score: Math.round(row.overall_score),
      postedAt: row.j_posted,
      firstSeenAt: row.j_seen,
      evidence,
      evidenced,
      requirements,
    };
  });

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

  /* Resume workflows that actually produced something, and how many of those landed in the last
   * seven days. `completed_at` is set only when a workflow reaches READY, so "this week" is the
   * real completion date, not the date the run was queued. */
  const resumes = db
    .prepare(
      `SELECT COUNT(*) AS ready,
              SUM(CASE WHEN completed_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS thisWeek
         FROM resume_quality_workflows WHERE candidate_id = ? AND status = 'READY'`
    )
    .get(candidateId) as { ready: number; thisWeek: number | null };
  const resumesCreated = resumes.ready;

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

  /* How many applications exist at all, and how many reached the end. Two tallies, not a list —
   * the applications page owns the list. */
  /* APPLICATIONS TRACKING — runs JobHunt is still carrying through the lifecycle. Cancelled runs
   * are excluded: an application the candidate called off is not being tracked, and counting it
   * would make the number grow every time someone changed their mind. */
  const runTotals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status <> 'CANCELLED' THEN 1 ELSE 0 END) AS tracking,
              SUM(CASE WHEN status = 'SUBMITTED' THEN 1 ELSE 0 END) AS submitted
         FROM application_runs WHERE candidate_id = ?`
    )
    .get(candidateId) as { total: number; tracking: number | null; submitted: number | null };

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
      readyForTailoring: counts.readyForTailoring,
      needsReview: counts.needsReview,
      evaluated: counts.readyForTailoring + counts.needsReview + counts.blocked,
    },
    applications: {
      waitingOnYou: waiting.length,
      total: runTotals.total,
      tracking: runTotals.tracking ?? 0,
      submitted: runTotals.submitted ?? 0,
      /* What they are waiting for, so home can name it rather than say "3 things". */
      reasons: [...new Set(waiting.map((r) => r.status))],
      /* The single most pressing one, for the primary action card. */
      first: waiting[0]
        ? { id: waiting[0].id, status: waiting[0].status, question: waiting[0].blocking_question }
        : null,
      waiting: waitingRuns,
    },
    profile: {
      status: profile.status,
      skills: profile.status === "ok" ? profile.profile.skills.length : 0,
      employers: profile.status === "ok" ? profile.profile.experience.length : 0,
    },
    resumesCreated,
    resumesThisWeek: resumes.thisWeek ?? 0,
    recommended,
    activity,
  });
}
