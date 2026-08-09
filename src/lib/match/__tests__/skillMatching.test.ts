import assert from "node:assert/strict";
import { test } from "node:test";
import { CREDIT } from "../creditTable";
import { normalizeCandidateSkills } from "../normalizeCandidateSkills";
import { matchRequirementUnit } from "../skillMatching";
import type { CandidateProfile, RequirementUnit } from "../types";
import { FIXTURE_TRANSFERABLE_PAIRS } from "./testHelpers";

function profile(skills: CandidateProfile["skills"], certifications: CandidateProfile["certifications"] = [], education: CandidateProfile["education"] = []): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "a", skills: "b" },
    builtAt: "2026-01-01T00:00:00Z",
    skills,
    experience: [],
    education,
    certifications,
    totalYearsExperience: null,
  };
}

function unit(overrides: Partial<RequirementUnit>): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: ["Python"],
    categories: [],
    label: "Python",
    requirementLevel: "Required",
    criticality: "REQUIRED",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    fromUnclaimedText: false,
    ...overrides,
  };
}

test("employer-attributed exact match scores the strongest credit", () => {
  const p = profile([{ rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme" }] }]);
  const match = matchRequirementUnit(unit({}), p, normalizeCandidateSkills(p));
  assert.equal(match.matchType, "MATCHED");
  assert.equal(match.credit, CREDIT.employerExact);
  assert.equal(match.evidence?.source, "employer");
});

test("inventory-only exact match scores lower than employer, never implies production depth", () => {
  const p = profile([{ rawSkillName: "Python", source: "inventory_only" }]);
  const match = matchRequirementUnit(unit({}), p, normalizeCandidateSkills(p));
  assert.equal(match.matchType, "MATCHED");
  assert.equal(match.credit, CREDIT.inventoryExact);
  assert.ok(match.credit < CREDIT.employerExact);
});

test("inventory-only match against a hands-on/production-required unit is credited even lower", () => {
  const p = profile([{ rawSkillName: "Airflow", source: "inventory_only" }]);
  const match = matchRequirementUnit(unit({ memberSkillNames: ["Airflow"], label: "Airflow", experienceDepthRequired: true }), p, normalizeCandidateSkills(p));
  assert.equal(match.credit, CREDIT.inventoryExactExperienceDepthRequired);
  assert.ok(match.credit < CREDIT.inventoryExact);
});

test("employer-attributed credit is NOT reduced by a hands-on cue (real evidence already proves depth)", () => {
  const p = profile([{ rawSkillName: "Airflow", source: "employer", attributedTo: [{ employer: "Acme" }] }]);
  const match = matchRequirementUnit(unit({ memberSkillNames: ["Airflow"], label: "Airflow", experienceDepthRequired: true }), p, normalizeCandidateSkills(p));
  assert.equal(match.credit, CREDIT.employerExact);
});

test("transferable match (fixture pair only) gets partial credit between missing and inventory", () => {
  const p = profile([{ rawSkillName: "TestSkillA", source: "employer", attributedTo: [{ employer: "Acme" }] }]);
  // Built by hand rather than via normalizeCandidateSkills(), since "TestSkillA" is a test-only
  // fixture name deliberately absent from the real SKILL_TAXONOMY (see transferableSkills.test.ts).
  const normalized = [{ ...p.skills[0], canonicalSkillName: "TestSkillA", category: null }];
  const match = matchRequirementUnit(unit({ memberSkillNames: ["TestSkillB"], label: "TestSkillB" }), p, normalized, FIXTURE_TRANSFERABLE_PAIRS);
  assert.equal(match.matchType, "TRANSFERABLE");
  assert.equal(match.credit, CREDIT.transferableStrong);
  assert.ok(match.credit > CREDIT.missing && match.credit < CREDIT.employerExact);
});

test("missing requirement (no match, no transferable pair) scores zero", () => {
  const p = profile([{ rawSkillName: "Java", source: "employer", attributedTo: [{ employer: "Acme" }] }]);
  const match = matchRequirementUnit(unit({ memberSkillNames: ["Python"] }), p, normalizeCandidateSkills(p));
  assert.equal(match.matchType, "MISSING");
  assert.equal(match.credit, 0);
});

test("an unclaimed-text unit is always UNRESOLVED, never guessed as MISSING or MATCHED", () => {
  const p = profile([{ rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme" }] }]);
  const match = matchRequirementUnit(
    unit({ memberSkillNames: [], label: "some novel line", fromUnclaimedText: true }),
    p,
    normalizeCandidateSkills(p)
  );
  assert.equal(match.matchType, "UNRESOLVED");
  assert.equal(match.credit, 0);
});

test("OR-alternative group: satisfying ANY one member satisfies the whole unit at the best available credit", () => {
  const p = profile([{ rawSkillName: "Azure", source: "employer", attributedTo: [{ employer: "Acme" }] }]);
  const match = matchRequirementUnit(unit({ kind: "skill_group", memberSkillNames: ["AWS", "Azure"], label: "AWS OR Azure" }), p, normalizeCandidateSkills(p));
  assert.equal(match.matchType, "MATCHED");
  assert.equal(match.credit, CREDIT.employerExact, "candidate lacks AWS but has Azure — must not be penalized for the missing alternative");
});

test("certification unit: held certification matches, unheld one is missing", () => {
  const p = profile([], [{ name: "AWS Certified Solutions Architect" }]);
  const held = matchRequirementUnit(unit({ kind: "certification", label: "AWS Certified Solutions Architect", memberSkillNames: [] }), p, normalizeCandidateSkills(p));
  assert.equal(held.matchType, "MATCHED");
  const unheld = matchRequirementUnit(unit({ kind: "certification", label: "PMP", memberSkillNames: [] }), p, normalizeCandidateSkills(p));
  assert.equal(unheld.matchType, "MISSING");
});

test("education unit: candidate meeting or exceeding the required level matches", () => {
  const p = profile([], [], [{ level: "Master's", field: "Computer Science", institution: null }]);
  const match = matchRequirementUnit(unit({ kind: "education", label: "Bachelor's in Computer Science", memberSkillNames: [] }), p, normalizeCandidateSkills(p));
  assert.equal(match.matchType, "MATCHED");
});

test("education unit: candidate below the required level is missing, never fabricated as satisfied", () => {
  const p = profile([], [], [{ level: "Bachelor's", field: null, institution: null }]);
  const match = matchRequirementUnit(unit({ kind: "education", label: "Master's", memberSkillNames: [] }), p, normalizeCandidateSkills(p));
  assert.equal(match.matchType, "MISSING");
});

test("only JD-side requirement units drive matching — a broad unrelated candidate skill list never appears as scored output", () => {
  const p = profile([
    { rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme" }] },
    { rawSkillName: "COBOL", source: "inventory_only" },
    { rawSkillName: "Photoshop", source: "inventory_only" },
  ]);
  const match = matchRequirementUnit(unit({ memberSkillNames: ["Python"] }), p, normalizeCandidateSkills(p));
  // Only ONE match is produced for ONE requirement unit, regardless of how many other skills the
  // candidate profile lists — COBOL/Photoshop never enter the output because nothing on the JD side
  // asked for them.
  assert.equal(match.matchType, "MATCHED");
});
