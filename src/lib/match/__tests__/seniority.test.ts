import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateCandidateSeniority, seniorityAlignmentScore } from "../seniority";
import type { CandidateExperienceEntry } from "../types";

function entry(overrides: Partial<CandidateExperienceEntry>): CandidateExperienceEntry {
  return { employer: "Acme", title: "Data Engineer", startDate: "2020-01", endDate: null, technologies: [], ...overrides };
}

test("a title with a recognizable seniority keyword resolves from the most recent (current) role", () => {
  const estimate = estimateCandidateSeniority([
    entry({ title: "Data Engineer", endDate: "2019-01" }),
    entry({ title: "Senior Data Engineer", endDate: null }),
  ]);
  assert.equal(estimate.level, "Senior");
  assert.equal(estimate.derivedFrom, "most_recent_title");
});

test("a plain title with no seniority keyword resolves to Unknown, never guessed from tenure", () => {
  const estimate = estimateCandidateSeniority([entry({ title: "Data Engineer", endDate: null })]);
  assert.equal(estimate.level, "Unknown");
  assert.equal(estimate.derivedFrom, "unknown");
});

test("no experience history at all -> Unknown", () => {
  const estimate = estimateCandidateSeniority([]);
  assert.equal(estimate.level, "Unknown");
});

test("the uncertainty note is always populated, honestly describing this as a V1 heuristic", () => {
  const estimate = estimateCandidateSeniority([entry({ title: "Senior Data Engineer", endDate: null })]);
  assert.match(estimate.note, /heuristic/i);
});

test("seniorityAlignmentScore: exact match scores full credit", () => {
  assert.equal(seniorityAlignmentScore("Senior", "Senior"), 1.0);
});

test("seniorityAlignmentScore: candidate more senior than required is never penalized", () => {
  assert.equal(seniorityAlignmentScore("Mid", "Senior"), 1.0);
});

test("seniorityAlignmentScore: one level under gets partial credit", () => {
  assert.equal(seniorityAlignmentScore("Senior", "Mid"), 0.6);
});

test("seniorityAlignmentScore: two+ levels under gets low credit", () => {
  assert.equal(seniorityAlignmentScore("Principal", "Junior"), 0.2);
});

test("seniorityAlignmentScore: either side Unknown is inapplicable (null), never guessed", () => {
  assert.equal(seniorityAlignmentScore("Unknown", "Senior"), null);
  assert.equal(seniorityAlignmentScore("Senior", "Unknown"), null);
});
