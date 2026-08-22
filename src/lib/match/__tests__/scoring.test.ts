import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeCoverageDimensionScore,
  computeEmployerEvidencedShare,
  computeOverallScore,
  computeRequirementCoverage,
  criticalGaps,
  isInsufficientJdSignal,
  MIN_REQUIREMENT_UNITS,
} from "../scoring";
import type { RequirementMatch, RequirementUnit } from "../types";

function unit(overrides: Partial<RequirementUnit>): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: ["X"],
    categories: [],
    label: "X",
    requirementLevel: "Required",
    criticality: "REQUIRED",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    requestedYears: null,
    fromUnclaimedText: false,
    ...overrides,
  };
}

function match(overrides: Partial<RequirementMatch>): RequirementMatch {
  return { requirement: unit({}), matchType: "MATCHED", credit: 1, ...overrides };
}

test("computeCoverageDimensionScore returns null (inapplicable), never 0 or 100, for an empty unit set", () => {
  assert.equal(computeCoverageDimensionScore([]), null);
});

test("computeCoverageDimensionScore is the mean credit across the pool, scaled to 0..100", () => {
  const score = computeCoverageDimensionScore([match({ credit: 1 }), match({ credit: 0.6 }), match({ credit: 0 })]);
  assert.ok(score !== null && Math.abs(score - 53.33) < 0.1);
});

test("computeOverallScore redistributes weight when a dimension is null, never divides by zero", () => {
  const score = computeOverallScore({ roleAlignment: 100, required: 100, preferred: null, experience: null, seniority: null });
  assert.equal(score, 100, "with only role alignment and 'required' applicable, their redistributed weight determines the score");
});

test("computeOverallScore returns 0 (not NaN/undefined) when every dimension is inapplicable", () => {
  assert.equal(computeOverallScore({ roleAlignment: null, required: null, preferred: null, experience: null, seniority: null }), 0);
});

test("Stage 24B requirement anchor: experience alone cannot carry the score when the JD yielded no requirements at all", () => {
  // The exact shape that produced 1,535 real jobs at overallScore 100 before Stage 24B — a posting
  // whose only extractable fact was a years-of-experience minimum the candidate clears.
  const score = computeOverallScore({ roleAlignment: 0, required: null, preferred: null, experience: 100, seniority: 100 });
  assert.equal(score, 0, "experience/seniority are supporting dimensions, never the whole basis of a fit claim");
});

test("Stage 24B requirement anchor: experience and seniority DO count once a requirement dimension is applicable", () => {
  const score = computeOverallScore({ roleAlignment: 100, required: 100, preferred: null, experience: 100, seniority: 100 });
  assert.equal(score, 100);
  const withoutSupport = computeOverallScore({ roleAlignment: 100, required: 100, preferred: null, experience: 0, seniority: 0 });
  assert.ok(withoutSupport < 100, "a candidate short on years/level scores lower than one who is not");
});

test("Stage 24B: role identity outweighs raw skill overlap — a wrong-profession job with perfect skill coverage scores far below an aligned one", () => {
  const alignedButPartialSkills = computeOverallScore({ roleAlignment: 100, required: 60, preferred: 60, experience: 100, seniority: null });
  const misalignedWithPerfectSkills = computeOverallScore({ roleAlignment: 0, required: 100, preferred: 100, experience: 100, seniority: null });
  assert.ok(
    alignedButPartialSkills > misalignedWithPerfectSkills,
    `expected the aligned role (${alignedButPartialSkills}) to outscore the misaligned one (${misalignedWithPerfectSkills})`
  );
});

test("computeRequirementCoverage: zero units -> 0 confidence, never a vacuous 100%", () => {
  assert.equal(computeRequirementCoverage([]), 0);
});

test("computeRequirementCoverage weights CRITICAL unresolved items much more heavily than PREFERRED ones", () => {
  const mostlyResolvedButCriticalGap = computeRequirementCoverage([
    match({ requirement: unit({ criticality: "CRITICAL" }), matchType: "UNRESOLVED" }),
    match({ requirement: unit({ criticality: "REQUIRED" }), matchType: "MATCHED" }),
    match({ requirement: unit({ criticality: "REQUIRED" }), matchType: "MATCHED" }),
  ]);
  const onlyPreferredUnresolved = computeRequirementCoverage([
    match({ requirement: unit({ criticality: "PREFERRED" }), matchType: "UNRESOLVED" }),
    match({ requirement: unit({ criticality: "REQUIRED" }), matchType: "MATCHED" }),
    match({ requirement: unit({ criticality: "REQUIRED" }), matchType: "MATCHED" }),
  ]);
  assert.ok(onlyPreferredUnresolved > mostlyResolvedButCriticalGap, "an unresolved CRITICAL item must hurt coverage far more than an unresolved PREFERRED one");
});

test("computeEmployerEvidencedShare: zero credit earned -> 0, never divide by zero", () => {
  assert.equal(computeEmployerEvidencedShare([match({ matchType: "MISSING", credit: 0 })]), 0);
});

test("computeEmployerEvidencedShare: all-inventory-matched required set scores 0% employer share", () => {
  const share = computeEmployerEvidencedShare([
    match({ credit: 0.6, evidence: { source: "inventory_only", rawSkillName: "X", canonicalSkillName: "X" } }),
  ]);
  assert.equal(share, 0);
});

test("computeEmployerEvidencedShare: mixed employer/inventory credit reflects the true proportion", () => {
  const share = computeEmployerEvidencedShare([
    match({ credit: 1, evidence: { source: "employer", rawSkillName: "X", canonicalSkillName: "X" } }),
    match({ credit: 0.6, evidence: { source: "inventory_only", rawSkillName: "Y", canonicalSkillName: "Y" } }),
  ]);
  assert.ok(Math.abs(share - 1 / 1.6) < 0.01);
});

test("computeEmployerEvidencedShare excludes education/certification units entirely — a matched degree/cert must never dilute or inflate the skill-evidence-strength gate (regression: found evaluating real job 14 during Phase 2 validation)", () => {
  const educationMatch = match({
    requirement: unit({ kind: "education", label: "High School in Finance" }),
    matchType: "MATCHED",
    credit: 1,
    evidence: { source: "employer", rawSkillName: "High School in Finance", canonicalSkillName: null },
  });
  const certMatch = match({
    requirement: unit({ kind: "certification", label: "PMP" }),
    matchType: "MATCHED",
    credit: 1,
    evidence: { source: "employer", rawSkillName: "PMP", canonicalSkillName: null },
  });
  // No real skill evidence at all — only education/certification units matched.
  assert.equal(computeEmployerEvidencedShare([educationMatch, certMatch]), 0, "with zero actual skill units, share must be 0, not artificially inflated to 100% by non-skill matches");

  // A genuinely inventory-only skill match alongside a matched education unit: the education unit
  // must not count toward (or dilute) the skill-only share calculation.
  const inventorySkillMatch = match({
    requirement: unit({ kind: "skill", label: "Python" }),
    matchType: "MATCHED",
    credit: 0.6,
    evidence: { source: "inventory_only", rawSkillName: "Python", canonicalSkillName: "Python" },
  });
  assert.equal(computeEmployerEvidencedShare([educationMatch, inventorySkillMatch]), 0, "the matched education unit must not be counted as skill credit at all");
});

test("isInsufficientJdSignal fires below MIN_REQUIREMENT_UNITS", () => {
  assert.equal(isInsufficientJdSignal(Array.from({ length: MIN_REQUIREMENT_UNITS - 1 }, () => match({}))), true);
  assert.equal(isInsufficientJdSignal(Array.from({ length: MIN_REQUIREMENT_UNITS }, () => match({}))), false);
});

test("criticalGaps returns only CRITICAL units that are MISSING or UNRESOLVED", () => {
  const gaps = criticalGaps([
    match({ requirement: unit({ criticality: "CRITICAL" }), matchType: "MISSING" }),
    match({ requirement: unit({ criticality: "CRITICAL" }), matchType: "MATCHED" }),
    match({ requirement: unit({ criticality: "REQUIRED" }), matchType: "MISSING" }),
  ]);
  assert.equal(gaps.length, 1);
});

test("Stage 25B: an UNRESOLVED free-text requirement line does not anchor the score", () => {
  // detectUnclaimedRequirements emits kind "skill" with an EMPTY memberSkillNames. Those units are
  // deliberately UNRESOLVED against coverage; treating them as a skill anchor let a posting with no
  // taxonomy-resolved skill at all (e.g. "Crisis & Referral Specialist", whose only evidenced unit
  // was a Bachelor's degree) reach 61.1 with role alignment 0 and outrank real engineering postings.
  const dims = { roleAlignment: 0, required: 100, preferred: 0, experience: 100, seniority: null };
  assert.equal(computeOverallScore(dims, true), 61.1);
  assert.equal(computeOverallScore(dims, false), 53.3);
  assert.ok(computeOverallScore(dims, false) < computeOverallScore(dims, true));
});

test("Stage 25B: a resolved skill requirement still anchors experience and seniority", () => {
  const dims = { roleAlignment: 100, required: 90, preferred: 80, experience: 100, seniority: 100 };
  assert.equal(computeOverallScore(dims, true), computeOverallScore(dims));
  assert.ok(computeOverallScore(dims, true) > computeOverallScore(dims, false));
});
