import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeRoleAlignment,
  parseRoleIdentity,
  scoreResponsibilityAlignment,
  scoreTitleAlignment,
} from "../roleAlignment";
import type { CandidateExperienceEntry, RequirementMatch, RequirementUnit } from "../types";

const CANDIDATE_TITLES = ["Data Engineer", "Data Engineer", "Data Engineer"];

function experience(titles: string[]): CandidateExperienceEntry[] {
  return titles.map((title, i) => ({ employer: `E${i}`, title, startDate: "2020-01", endDate: null, technologies: [] }));
}

function unit(overrides: Partial<RequirementUnit> = {}): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: ["Python"],
    categories: ["Data Engineering"],
    label: "Python",
    requirementLevel: "Required",
    criticality: "REQUIRED",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    fromUnclaimedText: false,
    ...overrides,
  };
}

function employerMatch(label: string, categories: RequirementUnit["categories"] = ["Data Engineering"]): RequirementMatch {
  return {
    requirement: unit({ label, memberSkillNames: [label], categories }),
    matchType: "MATCHED",
    credit: 1,
    evidence: { source: "employer", rawSkillName: label, canonicalSkillName: label, employers: ["Acme"] },
  };
}

function inventoryMatch(label: string): RequirementMatch {
  return {
    requirement: unit({ label, memberSkillNames: [label] }),
    matchType: "MATCHED",
    credit: 0.6,
    evidence: { source: "inventory_only", rawSkillName: label, canonicalSkillName: label },
  };
}

function missingMatch(label: string): RequirementMatch {
  return { requirement: unit({ label, memberSkillNames: [label] }), matchType: "MISSING", credit: 0 };
}

// --- parseRoleIdentity ---------------------------------------------------------------------------

test("parseRoleIdentity strips seniority/level words so role identity is level-independent", () => {
  assert.deepEqual(parseRoleIdentity("Senior Data Engineer II"), { roleNoun: "engineer", modifiers: new Set(["data"]) });
  assert.deepEqual(parseRoleIdentity("Data Engineer"), { roleNoun: "engineer", modifiers: new Set(["data"]) });
});

test("parseRoleIdentity picks the ROLE noun, not merely the last word", () => {
  // The naive "last token" rule would call this a "platform", losing the profession entirely.
  assert.equal(parseRoleIdentity("Software Engineer — Data Platform").roleNoun, "engineer");
  assert.deepEqual(parseRoleIdentity("Software Engineer — Data Platform").modifiers, new Set(["software", "data", "platform"]));
});

test("parseRoleIdentity canonicalises developer/programmer/engineering onto one profession", () => {
  assert.equal(parseRoleIdentity("Data Developer").roleNoun, "engineer");
  assert.equal(parseRoleIdentity("Data Engineering Lead").roleNoun, "engineer");
});

test("parseRoleIdentity yields no role noun for a title with no significant tokens", () => {
  assert.equal(parseRoleIdentity("   ").roleNoun, null);
  assert.equal(parseRoleIdentity("the a of and").roleNoun, null);
});

// --- scoreTitleAlignment -------------------------------------------------------------------------

test("a specialised version of the candidate's own role is full title alignment", () => {
  for (const title of [
    "Senior Data Engineer",
    "Azure Data Engineer",
    "Snowflake Data Engineer",
    "Databricks Data Engineer",
    "Data Platform Engineer",
    "AI/Data Engineer",
    "Data Engineer II",
  ]) {
    assert.equal(scoreTitleAlignment(title, CANDIDATE_TITLES), 1, `${title} should be full role alignment`);
  }
});

test("an oddly-titled but genuinely-same-specialisation role still aligns fully — no brittle title rejection", () => {
  // Stage 24B Phase 4 asks specifically whether "Software Engineer — Data Platform" can compete with
  // Data Engineer. It can: the candidate's whole role identity ("data" + engineer) is contained in
  // this title, which merely adds "software"/"platform". The title does NOT by itself claim the
  // responsibilities match — required-coverage carries 40 of the 100 weight and decides that
  // separately.
  assert.equal(scoreTitleAlignment("Software Engineer — Data Platform", CANDIDATE_TITLES), 1);
});

test("same profession with partially overlapping specialisation scores 0.75 — not full, not weak", () => {
  // Candidate specialised in Azure; the posting is the same profession and the same "data" flavour,
  // but a cloud the candidate's title does not claim.
  assert.equal(scoreTitleAlignment("AWS Data Engineer", ["Azure Data Engineer"]), 0.75);
});

test("same profession, no shared specialisation scores 0.35 — weak, but never a hard rejection", () => {
  assert.equal(scoreTitleAlignment("Software Engineer", CANDIDATE_TITLES), 0.35);
  assert.equal(scoreTitleAlignment("Machine Learning Engineer", CANDIDATE_TITLES), 0.35);
});

test("a different profession scores 0 on title alone", () => {
  for (const title of ["Mammography Technologist", "Classroom Floater", "Actuarial Analyst", "Cust Care Rep II", "Material Handler"]) {
    assert.equal(scoreTitleAlignment(title, CANDIDATE_TITLES), 0, `${title} is not the candidate's profession`);
  }
});

test("an empty candidate work history can never produce title alignment", () => {
  assert.equal(scoreTitleAlignment("Senior Data Engineer", []), 0);
});

// --- scoreResponsibilityAlignment ----------------------------------------------------------------

test("responsibility alignment requires BREADTH of employer-attributed evidence, not one lucky skill", () => {
  assert.equal(scoreResponsibilityAlignment([employerMatch("SQL")]), 0, "one matched skill is not role identity");
  assert.equal(scoreResponsibilityAlignment([employerMatch("SQL"), employerMatch("Python")]), 0);
});

test("responsibility alignment is earned when most Required skill weight is employer-attributed", () => {
  const matches = [employerMatch("PySpark"), employerMatch("Azure Data Factory"), employerMatch("Snowflake"), missingMatch("Kafka")];
  assert.equal(scoreResponsibilityAlignment(matches), 0.75);
});

test("responsibility alignment is capped below full title alignment, so a title match always edges out a responsibility-only one", () => {
  const matches = [employerMatch("A"), employerMatch("B"), employerMatch("C")];
  assert.ok(scoreResponsibilityAlignment(matches) < 1);
});

test("inventory-only evidence can NEVER manufacture responsibility alignment (a broad skills inventory is not role identity)", () => {
  const matches = [inventoryMatch("A"), inventoryMatch("B"), inventoryMatch("C"), inventoryMatch("D")];
  assert.equal(scoreResponsibilityAlignment(matches), 0);
});

test("responsibility alignment is 0 when the JD stated no Required skill units at all", () => {
  assert.equal(scoreResponsibilityAlignment([]), 0);
});

test("ubiquitous tooling alone (SQL + Python + Power BI) can NEVER earn responsibility alignment", () => {
  // The exact shape that let "Sr. Financial Analyst, GPO Finance", "Pricing Analyst" and
  // "Actuarial Business Analyst III" earn role alignment on the real corpus.
  const generic = [
    employerMatch("SQL", ["Programming Languages"]),
    employerMatch("Python", ["Programming Languages"]),
    employerMatch("Power BI", ["BI / Reporting"]),
    employerMatch("Oracle", ["Databases"]),
  ];
  assert.equal(scoreResponsibilityAlignment(generic), 0);
});

test("one genuinely specialised employer-evidenced requirement alongside generic tooling DOES earn it", () => {
  const withSpecialisation = [
    employerMatch("SQL", ["Programming Languages"]),
    employerMatch("Python", ["Programming Languages"]),
    employerMatch("Oracle", ["Databases"]),
    employerMatch("Databricks", ["Warehousing"]),
  ];
  assert.equal(scoreResponsibilityAlignment(withSpecialisation), 0.75);
});

// --- computeRoleAlignment ------------------------------------------------------------------------

test("computeRoleAlignment takes the best of the title and responsibility paths", () => {
  // Title says "Analyst" — a different profession — but the JD's own required skills are broadly
  // covered by the candidate's employer-attributed data-engineering experience.
  const result = computeRoleAlignment(
    "Data Analytics Analyst",
    experience(CANDIDATE_TITLES),
    [employerMatch("PySpark"), employerMatch("Azure Data Factory"), employerMatch("Snowflake", ["Warehousing"])]
  );
  assert.equal(result.titleScore, 0, "the title alone does not align");
  assert.equal(result.responsibilityScore, 0.75);
  assert.equal(result.score, 0.75, "brittle title-only rejection is avoided");
  assert.ok(result.note.length > 0);
});

test("computeRoleAlignment gives an aligned title full credit even with thin skill evidence", () => {
  const result = computeRoleAlignment("Senior Data Engineer", experience(CANDIDATE_TITLES), [missingMatch("Kafka")]);
  assert.equal(result.score, 1);
});

test("computeRoleAlignment stays 0 for an unrelated role with no broad employer evidence — no fabricated alignment", () => {
  const result = computeRoleAlignment("Mammography Technologist", experience(CANDIDATE_TITLES), [employerMatch("SQL")]);
  assert.equal(result.score, 0);
  assert.match(result.note, /Different profession/);
});
