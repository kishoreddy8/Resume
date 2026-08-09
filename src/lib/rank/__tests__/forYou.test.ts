import assert from "node:assert/strict";
import { test } from "node:test";
import { computeFreshnessTier, rankForYou, type ForYouJobInput } from "../forYou";

const NOW = new Date("2026-08-09T00:00:00Z");
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

function job(overrides: Partial<ForYouJobInput> & { jobId: number }): ForYouJobInput {
  return {
    dedupeKey: `key-${overrides.jobId}`,
    title: "Data Engineer",
    postedAt: daysAgo(5),
    h1bCombinedConfidence: "Unknown",
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    notInterested: false,
    roleFamilyTier: "PRIMARY",
    ...overrides,
  };
}

function match(decision: ForYouJobInput["match"] & object) {
  return decision;
}

// --- computeFreshnessTier ------------------------------------------------------------------------

test("freshness: 0-10 days -> PRIMARY, 11-20 -> SECONDARY, >20 -> STALE, null -> UNKNOWN_DATE, never fabricated from another date", () => {
  assert.equal(computeFreshnessTier(daysAgo(0), NOW), "PRIMARY");
  assert.equal(computeFreshnessTier(daysAgo(10), NOW), "PRIMARY");
  assert.equal(computeFreshnessTier(daysAgo(11), NOW), "SECONDARY");
  assert.equal(computeFreshnessTier(daysAgo(20), NOW), "SECONDARY");
  assert.equal(computeFreshnessTier(daysAgo(21), NOW), "STALE");
  assert.equal(computeFreshnessTier(daysAgo(40), NOW), "STALE");
  assert.equal(computeFreshnessTier(null, NOW), "UNKNOWN_DATE");
});

// --- Worked examples from the approved plan (Revision 2 §24) --------------------------------------

test("A vs B: same ~90s band, A has explicit positive sponsorship, B only historical strong -> A ranks above B despite B's higher raw score", () => {
  const a = job({
    jobId: 1, title: "Data Engineer", roleFamilyTier: "PRIMARY", postedAt: daysAgo(4),
    sponsorshipMentioned: true, sponsorshipPolarity: "positive", h1bCombinedConfidence: "Very High",
    match: match({ decision: "READY_FOR_TAILORING", overallScore: 92, employerEvidencedShare: 0.8, requirementCoverage: 0.9 }),
  });
  const b = job({
    jobId: 2, title: "Data Engineer", roleFamilyTier: "PRIMARY", postedAt: daysAgo(8),
    sponsorshipMentioned: false, sponsorshipPolarity: "none", h1bCombinedConfidence: "Very High",
    match: match({ decision: "READY_FOR_TAILORING", overallScore: 95, employerEvidencedShare: 0.8, requirementCoverage: 0.9 }),
  });
  const ranked = rankForYou([b, a]); // insert B first to prove sort actually reorders
  assert.deepEqual(ranked.map((j) => j.jobId), [1, 2], "A (explicit sponsorship) must rank above B within the same score band");
});

test("92% strong fit + historical sponsor beats 55% poor fit + Very High historical sponsor (different bands, fit dominates)", () => {
  const strongFitWeakerSponsor = job({
    jobId: 1, h1bCombinedConfidence: "Medium",
    match: match({ decision: "READY_FOR_TAILORING", overallScore: 92, employerEvidencedShare: 0.7, requirementCoverage: 0.9 }),
  });
  const poorFitStrongSponsor = job({
    jobId: 2, h1bCombinedConfidence: "Very High",
    match: match({ decision: "NEEDS_REVIEW", overallScore: 55, employerEvidencedShare: 0.3, requirementCoverage: 0.5 }),
  });
  const ranked = rankForYou([poorFitStrongSponsor, strongFitWeakerSponsor]);
  assert.deepEqual(ranked.map((j) => j.jobId), [1, 2], "fit must dominate a large gap regardless of sponsorship strength");
});

test("C vs D: C is READY (92, historical strong, 17d old) beats D NEEDS_REVIEW (64, explicit positive, 2d old) — decision rank dominates freshness/H1B", () => {
  const c = job({
    jobId: 1, postedAt: daysAgo(17), h1bCombinedConfidence: "Very High",
    match: match({ decision: "READY_FOR_TAILORING", overallScore: 92, employerEvidencedShare: 0.8, requirementCoverage: 0.9 }),
  });
  const d = job({
    jobId: 2, postedAt: daysAgo(2), sponsorshipMentioned: true, sponsorshipPolarity: "positive", h1bCombinedConfidence: "Very High",
    match: match({ decision: "NEEDS_REVIEW", overallScore: 64, employerEvidencedShare: 0.4, requirementCoverage: 0.6 }),
  });
  const ranked = rankForYou([d, c]);
  assert.deepEqual(ranked.map((j) => j.jobId), [1, 2], "READY must outrank NEEDS_REVIEW regardless of D's fresher posting or better sponsorship signal");
});

test("E vs F: candidate's preferred-role-family job (88 READY) ranks above a stronger off-preference job (94 READY) — preference is evaluated before score, per the approved key order", () => {
  const inFamily = job({
    jobId: 1, title: "Java Developer", roleFamilyTier: "PRIMARY",
    match: match({ decision: "READY_FOR_TAILORING", overallScore: 88, employerEvidencedShare: 0.7, requirementCoverage: 0.85 }),
  });
  const offFamily = job({
    jobId: 2, title: "Data Engineer", roleFamilyTier: "NONE",
    match: match({ decision: "READY_FOR_TAILORING", overallScore: 94, employerEvidencedShare: 0.9, requirementCoverage: 0.95 }),
  });
  const ranked = rankForYou([offFamily, inFamily]);
  assert.deepEqual(ranked.map((j) => j.jobId), [1, 2]);
  // Critically: preference never touched the underlying score — both numbers are exactly as given.
  assert.equal(ranked[0].match?.overallScore, 88);
  assert.equal(ranked[1].match?.overallScore, 94, "the off-preference job's honest higher score is preserved, not modified, even though it ranks lower");
});

test("G: a candidate-not-interested job is excluded entirely from that candidate's ranked list", () => {
  const visible = job({ jobId: 1, notInterested: false });
  const hidden = job({ jobId: 2, notInterested: true });
  const ranked = rankForYou([visible, hidden]);
  assert.deepEqual(ranked.map((j) => j.jobId), [1]);
});

test("NOT_EVALUATED jobs (no match yet) are never fabricated a score and fall back to freshness-only ordering within their tier", () => {
  const notEvaluatedFresh = job({ jobId: 1, postedAt: daysAgo(2), match: undefined });
  const notEvaluatedOlder = job({ jobId: 2, postedAt: daysAgo(9), match: undefined });
  const needsReview = job({
    jobId: 3, match: match({ decision: "NEEDS_REVIEW", overallScore: 50, employerEvidencedShare: 0.2, requirementCoverage: 0.4 }),
  });
  const ranked = rankForYou([notEvaluatedOlder, needsReview, notEvaluatedFresh]);
  // NEEDS_REVIEW (decisionRank 1) outranks NOT_EVALUATED (decisionRank 2) outright.
  assert.equal(ranked[0].jobId, 3);
  // Within NOT_EVALUATED, freshest first.
  assert.deepEqual(ranked.slice(1).map((j) => j.jobId), [1, 2]);
  assert.equal(ranked[1].match, undefined, "no fabricated score");
});

test("BLOCKED jobs rank below READY/NEEDS_REVIEW/NOT_EVALUATED regardless of their raw score", () => {
  const blocked = job({ jobId: 1, match: match({ decision: "BLOCKED", overallScore: 99, employerEvidencedShare: 1, requirementCoverage: 1 }) });
  const notEvaluated = job({ jobId: 2, match: undefined });
  const ranked = rankForYou([blocked, notEvaluated]);
  assert.deepEqual(ranked.map((j) => j.jobId), [2, 1]);
});

test("stale (>20 day) jobs are excluded by default but included when includeStale is passed (All Jobs view)", () => {
  const stale = job({ jobId: 1, postedAt: daysAgo(30) });
  const fresh = job({ jobId: 2, postedAt: daysAgo(1) });
  const defaultView = rankForYou([stale, fresh]);
  assert.deepEqual(defaultView.map((j) => j.jobId), [2], "stale job excluded from default For You");

  const allJobsView = rankForYou([stale, fresh], { includeStale: true });
  assert.deepEqual(allJobsView.map((j) => j.jobId), [2, 1], "stale job included, but still ranked after the fresh one");
});

test("explicit no-sponsorship never gets premium placement even at a high raw score (still sorted, just via the weakest sponsorship tier)", () => {
  const noSponsor = job({
    jobId: 1, h1bCombinedConfidence: "Not Sponsoring",
    match: match({ decision: "READY_FOR_TAILORING", overallScore: 90, employerEvidencedShare: 0.8, requirementCoverage: 0.9 }),
  });
  const unknownSponsor = job({
    jobId: 2, h1bCombinedConfidence: "Unknown",
    match: match({ decision: "READY_FOR_TAILORING", overallScore: 90, employerEvidencedShare: 0.8, requirementCoverage: 0.9 }),
  });
  const ranked = rankForYou([noSponsor, unknownSponsor]);
  assert.deepEqual(ranked.map((j) => j.jobId), [2, 1], "within the identical band, unknown sponsorship still outranks explicit non-sponsorship");
});

test("deterministic tie-break: identical everything else falls back to posted_at then id, never random order", () => {
  const a = job({ jobId: 5, postedAt: daysAgo(3) });
  const b = job({ jobId: 3, postedAt: daysAgo(3) });
  const ranked1 = rankForYou([a, b]);
  const ranked2 = rankForYou([b, a]);
  assert.deepEqual(ranked1.map((j) => j.jobId), ranked2.map((j) => j.jobId), "sort order must not depend on input order");
  assert.deepEqual(ranked1.map((j) => j.jobId), [5, 3], "identical dates fall back to higher id first, deterministically");
});
