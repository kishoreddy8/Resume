import assert from "node:assert/strict";
import { test } from "node:test";
import { computeTotalYearsExperience } from "../experienceDuration";
import type { CandidateExperienceEntry } from "../types";

function entry(overrides: Partial<CandidateExperienceEntry>): CandidateExperienceEntry {
  return { employer: "Acme", title: "Engineer", startDate: null, endDate: null, technologies: [], ...overrides };
}

test("non-overlapping roles sum normally", () => {
  const years = computeTotalYearsExperience([
    entry({ startDate: "2018-01", endDate: "2020-01" }), // 2 years
    entry({ startDate: "2020-01", endDate: "2022-01" }), // 2 years, back-to-back
  ]);
  assert.equal(years, 4);
});

test("overlapping employment periods are UNIONED, not naively summed", () => {
  const years = computeTotalYearsExperience([
    entry({ startDate: "2020-01", endDate: "2021-12" }), // ~2 years
    entry({ startDate: "2021-06", endDate: "2022-06" }), // ~1 year, overlaps the first by 6 months
  ]);
  // Naive sum would be ~3 years; true union (Jan 2020 - Jun 2022) is ~2.5 years.
  assert.ok(years !== null && years < 2.9, `expected union-based total under naive-sum value, got ${years}`);
  assert.ok(years !== null && years > 2.2);
});

test("a current role (endDate null) is measured up to 'now'", () => {
  const years = computeTotalYearsExperience([entry({ startDate: "2020-01", endDate: null })], new Date("2026-01-01T00:00:00Z"));
  assert.equal(years, 6);
});

test("an entry with no parseable startDate is excluded from the union, not guessed", () => {
  const years = computeTotalYearsExperience([entry({ startDate: null, endDate: "2020-01" }), entry({ startDate: "2018-01", endDate: "2019-01" })]);
  assert.equal(years, 1, "only the parseable entry should contribute");
});

test("an entry with an unparseable date string is excluded, not guessed", () => {
  const years = computeTotalYearsExperience([entry({ startDate: "sometime in 2018", endDate: "2020-01" })]);
  assert.equal(years, null);
});

test("zero parseable entries -> null (unknown), never 0 as a guess", () => {
  const years = computeTotalYearsExperience([entry({ startDate: null, endDate: null })]);
  assert.equal(years, null);
});

test("three overlapping roles merge into one continuous span", () => {
  const years = computeTotalYearsExperience([
    entry({ startDate: "2018-01", endDate: "2019-06" }),
    entry({ startDate: "2019-01", endDate: "2020-06" }),
    entry({ startDate: "2020-01", endDate: "2021-01" }),
  ]);
  // True union: 2018-01 through 2021-01 = 3 years exactly.
  assert.equal(years, 3);
});
