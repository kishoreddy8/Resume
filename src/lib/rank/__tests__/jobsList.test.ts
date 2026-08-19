import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareJobsBestFirst,
  decisionRank,
  evidenceRank,
  LIST_DECISION_RANK,
  matchesDecisionFilter,
  postedAtKey,
  rankJobsBestFirst,
  scoreKey,
  UNEVALUATED_DECISION_RANK,
  type ListMatchSummary,
} from "../jobsList";
import type { JobWithCompany } from "@/types";

/**
 * The Jobs-page ranking contract, frozen.
 *
 * This comparator used to live inline in JobList.tsx. It was moved here so the rule has one
 * testable home rather than being restated wherever it is next needed. These tests exist to make
 * that move provably behaviour-preserving, and to keep it that way: the ORIGINAL inline
 * implementation is reproduced verbatim below and the extracted module is required to agree with
 * it on adversarial data, so any future edit to the ranking has to break a test on purpose.
 *
 * Pure functions only — no database, no network, no AI.
 */

// ------------------------------------------------------------------------------------------------
// The pre-extraction implementation, copied verbatim from JobList.tsx. Do not "tidy" this: its
// value is that it is the old code, character for character.
// ------------------------------------------------------------------------------------------------
const ORIGINAL_RANK: Record<string, number> = { READY_FOR_TAILORING: 0, NEEDS_REVIEW: 1, BLOCKED: 3 };

function originalCompare(
  a: JobWithCompany,
  b: JobWithCompany,
  decisions: Record<string, ListMatchSummary>
): number {
  const am = decisions[a.dedupe_key];
  const bm = decisions[b.dedupe_key];

  const aDecision = am ? ORIGINAL_RANK[am.decision] : 2;
  const bDecision = bm ? ORIGINAL_RANK[bm.decision] : 2;
  if (aDecision !== bDecision) return aDecision - bDecision;

  const aEvidence = am ? (am.insufficientJdSignal ? 1 : 0) : 2;
  const bEvidence = bm ? (bm.insufficientJdSignal ? 1 : 0) : 2;
  if (aEvidence !== bEvidence) return aEvidence - bEvidence;

  const aScore = am && !am.insufficientJdSignal ? am.overallScore : -1;
  const bScore = bm && !bm.insufficientJdSignal ? bm.overallScore : -1;
  if (aScore !== bScore) return bScore - aScore;

  const aPosted = a.posted_at ? new Date(a.posted_at).getTime() : 0;
  const bPosted = b.posted_at ? new Date(b.posted_at).getTime() : 0;
  if (aPosted !== bPosted) return bPosted - aPosted;

  return b.id - a.id;
}

function originalFilter(
  job: JobWithCompany,
  decisions: Record<string, ListMatchSummary>,
  filter: string
): boolean {
  if (filter === "All") return true;
  const entry = decisions[job.dedupe_key];
  if (filter === "Not Evaluated") return !entry;
  return entry?.decision === filter;
}

// ------------------------------------------------------------------------------------------------

function job(id: number, dedupeKey: string, postedAt: string | null): JobWithCompany {
  return { id, dedupe_key: dedupeKey, posted_at: postedAt } as JobWithCompany;
}

/** Deterministic PRNG so a failure is reproducible rather than "it went red once in CI". */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
}

const DECISIONS = ["READY_FOR_TAILORING", "NEEDS_REVIEW", "BLOCKED"] as const;
/** Includes the null/empty cases and "12-Aug-2026", which SQLite cannot parse but JS can. */
const DATES = [null, "", "2026-08-12", "2026-08-12", "2026-08-12T10:00:00Z", "12-Aug-2026", "2026-01-01"];
const FILTERS = ["All", "READY_FOR_TAILORING", "NEEDS_REVIEW", "BLOCKED", "Not Evaluated"] as const;

function randomCase(rnd: () => number, size: number) {
  const jobs: JobWithCompany[] = [];
  const decisions: Record<string, ListMatchSummary> = {};
  for (let i = 0; i < size; i++) {
    const key = `k${i}`;
    // Ids drawn from a small pool so duplicates-by-value force the id tie-break to matter.
    jobs.push(job(Math.floor(rnd() * size * 2), key, DATES[Math.floor(rnd() * DATES.length)]));
    // A quarter of jobs deliberately have NO match row at all.
    if (rnd() > 0.25) {
      decisions[key] = {
        decision: DECISIONS[Math.floor(rnd() * DECISIONS.length)],
        // Few distinct scores, so score ties are common and the date/id tail is exercised.
        overallScore: Math.floor(rnd() * 5) * 25,
        insufficientJdSignal: rnd() > 0.6,
      };
    }
  }
  return { jobs, decisions };
}

// --- The frozen contract ------------------------------------------------------------------------

test("JR-01 the decision ranks are exactly the ones the list has always used", () => {
  assert.deepEqual(LIST_DECISION_RANK, { READY_FOR_TAILORING: 0, NEEDS_REVIEW: 1, BLOCKED: 3 });
  // 2 is deliberately not a decision: it is the rank of a job with no match row, which therefore
  // sorts ABOVE BLOCKED and BELOW NEEDS_REVIEW. Changing this changes what users see first.
  assert.equal(UNEVALUATED_DECISION_RANK, 2);
  assert.equal(decisionRank(undefined), 2);
  assert.ok(decisionRank(undefined) > LIST_DECISION_RANK.NEEDS_REVIEW);
  assert.ok(decisionRank(undefined) < LIST_DECISION_RANK.BLOCKED);
});

test("JR-02 evidence rank: trusted 0, insufficient 1, no match row 2", () => {
  assert.equal(evidenceRank({ decision: "NEEDS_REVIEW", overallScore: 50, insufficientJdSignal: false }), 0);
  assert.equal(evidenceRank({ decision: "NEEDS_REVIEW", overallScore: 50, insufficientJdSignal: true }), 1);
  assert.equal(evidenceRank(undefined), 2);
});

test("JR-03 an untrusted or missing score collapses to -1 rather than being ranked", () => {
  assert.equal(scoreKey({ decision: "NEEDS_REVIEW", overallScore: 97, insufficientJdSignal: false }), 97);
  assert.equal(scoreKey({ decision: "NEEDS_REVIEW", overallScore: 97, insufficientJdSignal: true }), -1);
  assert.equal(scoreKey(undefined), -1);
});

test("JR-04 the date key maps null and empty to 0, and parses the formats the corpus contains", () => {
  assert.equal(postedAtKey(null), 0);
  assert.equal(postedAtKey(undefined), 0);
  assert.equal(postedAtKey(""), 0, "empty string is falsy — it must not become an epoch");
  assert.equal(postedAtKey("2026-08-12"), new Date("2026-08-12").getTime());
  assert.equal(postedAtKey("2026-08-12T10:00:00Z"), new Date("2026-08-12T10:00:00Z").getTime());
  // Non-ISO: JS parses this; SQLite's julianday() does not. Recorded here because any future
  // attempt to reproduce this ordering in SQL has to handle it.
  assert.ok(postedAtKey("12-Aug-2026") > 0);
});

test("JR-05 the comparator applies its five keys in order", () => {
  const d: Record<string, ListMatchSummary> = {
    ready: { decision: "READY_FOR_TAILORING", overallScore: 0, insufficientJdSignal: false },
    review: { decision: "NEEDS_REVIEW", overallScore: 100, insufficientJdSignal: false },
    blocked: { decision: "BLOCKED", overallScore: 100, insufficientJdSignal: false },
    weak: { decision: "NEEDS_REVIEW", overallScore: 100, insufficientJdSignal: true },
    strong: { decision: "NEEDS_REVIEW", overallScore: 60, insufficientJdSignal: false },
  };
  const at = (key: string, id = 1, posted: string | null = "2026-08-12") => job(id, key, posted);

  // 1. decision beats score: a 0-scoring READY outranks a 100-scoring NEEDS_REVIEW.
  assert.ok(compareJobsBestFirst(at("ready"), at("review"), d) < 0);
  // …and an unevaluated job outranks a BLOCKED one.
  assert.ok(compareJobsBestFirst(at("none"), at("blocked"), d) < 0);
  // 2. evidence beats score: a trusted 60 outranks an untrusted 100 within the same decision.
  assert.ok(compareJobsBestFirst(at("strong"), at("weak"), d) < 0);
  // 3. score, descending.
  assert.ok(compareJobsBestFirst(at("review"), at("strong"), d) < 0);
  // 4. date, descending, when everything above ties.
  assert.ok(compareJobsBestFirst(at("review", 1, "2026-08-12"), at("review", 2, "2026-01-01"), d) < 0);
  // 5. id, descending, as the final tie-break.
  assert.ok(compareJobsBestFirst(at("review", 9, "2026-08-12"), at("review", 4, "2026-08-12"), d) < 0);
});

test("JR-06 the ordering is TOTAL — two different jobs never compare equal", () => {
  const rnd = makeRandom(4242);
  const { jobs, decisions } = randomCase(rnd, 40);
  const unique = jobs.filter((j, i) => jobs.findIndex((o) => o.id === j.id) === i);
  for (const a of unique) {
    for (const b of unique) {
      if (a.id === b.id) continue;
      assert.notEqual(compareJobsBestFirst(a, b, decisions), 0, `${a.id} vs ${b.id} tied — order would be ambiguous`);
    }
  }
});

// --- Equivalence with the pre-extraction implementation ------------------------------------------

test("JR-07 the extracted comparator matches the original inline one over adversarial data", () => {
  const rnd = makeRandom(20260819);
  for (let trial = 0; trial < 400; trial++) {
    const { jobs, decisions } = randomCase(rnd, 25);
    const expected = [...jobs].sort((x, y) => originalCompare(x, y, decisions)).map((j) => `${j.id}:${j.dedupe_key}`);
    const actual = [...jobs].sort((x, y) => compareJobsBestFirst(x, y, decisions)).map((j) => `${j.id}:${j.dedupe_key}`);
    assert.deepEqual(actual, expected, `trial ${trial} diverged from the original ordering`);
  }
});

test("JR-08 the extracted filter matches the original inline one, for every filter value", () => {
  const rnd = makeRandom(777);
  for (let trial = 0; trial < 200; trial++) {
    const { jobs, decisions } = randomCase(rnd, 20);
    for (const filter of FILTERS) {
      const expected = jobs.filter((j) => originalFilter(j, decisions, filter)).map((j) => j.dedupe_key);
      const actual = jobs.filter((j) => matchesDecisionFilter(j, decisions, filter)).map((j) => j.dedupe_key);
      assert.deepEqual(actual, expected, `trial ${trial}, filter ${filter}`);
    }
  }
});

test("JR-09 filter-then-sort as a whole matches the original pipeline", () => {
  const rnd = makeRandom(31337);
  for (let trial = 0; trial < 200; trial++) {
    const { jobs, decisions } = randomCase(rnd, 30);
    for (const filter of FILTERS) {
      const expected = jobs
        .filter((j) => originalFilter(j, decisions, filter))
        .slice()
        .sort((x, y) => originalCompare(x, y, decisions))
        .map((j) => `${j.id}:${j.dedupe_key}`);
      const actual = rankJobsBestFirst(jobs, decisions, filter).map((j) => `${j.id}:${j.dedupe_key}`);
      assert.deepEqual(actual, expected, `trial ${trial}, filter ${filter}`);
    }
  }
});

test("JR-10 ranking never adds, drops, or mutates a job", () => {
  const rnd = makeRandom(99);
  const { jobs, decisions } = randomCase(rnd, 30);
  const before = jobs.map((j) => j.id);
  const ranked = rankJobsBestFirst(jobs, decisions, "All");
  assert.equal(ranked.length, jobs.length);
  assert.deepEqual([...ranked.map((j) => j.id)].sort((a, b) => a - b), [...before].sort((a, b) => a - b));
  assert.deepEqual(jobs.map((j) => j.id), before, "the input array must not be sorted in place");
});
