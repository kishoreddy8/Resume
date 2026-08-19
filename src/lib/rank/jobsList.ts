import type { JobWithCompany } from "@/types";

/**
 * Stage 33 — THE JOBS-LIST RANKING CONTRACT.
 *
 * This is the single definition of "best first" for the Jobs page. It was extracted verbatim from
 * JobList.tsx, which had it inline, so that the rule lives in one testable place instead of being
 * restated wherever it is next needed — two independent implementations of an ordering rule is
 * exactly how orderings silently diverge. JobList imports these; the tests alongside this file pin
 * the behaviour against the original inline implementation.
 *
 * Stage 24B (Phase 13) originally introduced this ordering for the All Jobs view, which until then
 * rendered listJobs()' raw SQL order and could show an unevaluated or insufficient-signal posting
 * above a strong fresh match. Same key philosophy as src/lib/rank/forYou.ts, applied to the facts
 * this view actually has: decision, evidence quality, score, then recency, then a stable id
 * tie-break. Display-only — it does not touch listJobs' SQL or its filters.
 *
 * Nothing here is new behaviour. Every constant, comparison and fallback below is what the browser
 * already did, including the parts that look surprising:
 *
 *   - a job with NO match row ranks 2 — BETWEEN NEEDS_REVIEW (1) and BLOCKED (3). An unevaluated
 *     job is deliberately shown above one the engine actively blocked.
 *   - a job whose evidence the engine distrusts (insufficientJdSignal) scores -1, so every such job
 *     ties on score and falls through to the date, rather than being ordered by a number the engine
 *     itself says is untrustworthy.
 *   - the date key is `new Date(posted_at).getTime()`, with null/empty mapped to 0. That is JS
 *     parsing, not SQLite's, and the two genuinely disagree: SQLite's julianday() returns NULL for
 *     "12-Aug-2026", a format JS parses happily, and 16 active jobs carry exactly that. Anything
 *     that ever tries to reproduce this ordering in SQL has to account for it.
 */

export type ListDecision = "READY_FOR_TAILORING" | "NEEDS_REVIEW" | "BLOCKED";

export interface ListMatchSummary {
  decision: ListDecision;
  overallScore: number;
  insufficientJdSignal: boolean;
}

export type DecisionFilter = "All" | ListDecision | "Not Evaluated";

/** Lower sorts first. 2 is deliberately absent — it is the rank of a job with no match row at all. */
export const LIST_DECISION_RANK: Record<ListDecision, number> = {
  READY_FOR_TAILORING: 0,
  NEEDS_REVIEW: 1,
  BLOCKED: 3,
};

/** The rank a job with no match row receives: above BLOCKED, below NEEDS_REVIEW. */
export const UNEVALUATED_DECISION_RANK = 2;

export function decisionRank(match: ListMatchSummary | undefined): number {
  return match ? LIST_DECISION_RANK[match.decision] : UNEVALUATED_DECISION_RANK;
}

/** 0 = trustworthy evidence, 1 = engine flagged the JD signal as insufficient, 2 = no match row. */
export function evidenceRank(match: ListMatchSummary | undefined): number {
  return match ? (match.insufficientJdSignal ? 1 : 0) : 2;
}

/** -1 for "no usable score", so untrusted and unevaluated jobs tie and fall through to the date. */
export function scoreKey(match: ListMatchSummary | undefined): number {
  return match && !match.insufficientJdSignal ? match.overallScore : -1;
}

/** Exactly the browser's expression, including the falsy-check on posted_at. */
export function postedAtKey(postedAt: string | null | undefined): number {
  return postedAt ? new Date(postedAt).getTime() : 0;
}

/**
 * The comparator, in its original order:
 *   1. decision rank ASC
 *   2. evidence rank ASC
 *   3. score DESC
 *   4. posted_at DESC
 *   5. id DESC
 *
 * Step 5 makes the ordering TOTAL — ids are unique — so the result never depends on sort stability
 * or on the order rows arrived from SQL.
 */
export function compareJobsBestFirst(
  a: JobWithCompany,
  b: JobWithCompany,
  decisions: Record<string, ListMatchSummary>
): number {
  const am = decisions[a.dedupe_key];
  const bm = decisions[b.dedupe_key];

  const aDecision = decisionRank(am);
  const bDecision = decisionRank(bm);
  if (aDecision !== bDecision) return aDecision - bDecision;

  const aEvidence = evidenceRank(am);
  const bEvidence = evidenceRank(bm);
  if (aEvidence !== bEvidence) return aEvidence - bEvidence;

  const aScore = scoreKey(am);
  const bScore = scoreKey(bm);
  if (aScore !== bScore) return bScore - aScore;

  const aPosted = postedAtKey(a.posted_at);
  const bPosted = postedAtKey(b.posted_at);
  if (aPosted !== bPosted) return bPosted - aPosted;

  return b.id - a.id;
}

/** The Match-decision dropdown's filter, exactly as the browser applies it. */
export function matchesDecisionFilter(
  job: JobWithCompany,
  decisions: Record<string, ListMatchSummary>,
  filter: DecisionFilter
): boolean {
  if (filter === "All") return true;
  const entry = decisions[job.dedupe_key];
  if (filter === "Not Evaluated") return !entry;
  return entry?.decision === filter;
}

/** Filter then sort — the browser's whole pipeline, in one place. */
export function rankJobsBestFirst(
  jobs: JobWithCompany[],
  decisions: Record<string, ListMatchSummary>,
  filter: DecisionFilter = "All"
): JobWithCompany[] {
  return jobs
    .filter((job) => matchesDecisionFilter(job, decisions, filter))
    .slice()
    .sort((a, b) => compareJobsBestFirst(a, b, decisions));
}
