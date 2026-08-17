import assert from "node:assert/strict";
import { test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import { buildJdPriorityMatrix, corePriorityRequirements, type JdPriorityMatrix } from "../jdPriorityMatrix";

function unit(overrides: Partial<RequirementUnit>): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: [],
    categories: [],
    label: "requirement",
    requirementLevel: "Required",
    criticality: "CRITICAL",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    fromUnclaimedText: false,
    ...overrides,
  };
}

function profile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "r", skills: "s" },
    builtAt: "2020-01-01T00:00:00Z",
    skills: [],
    experience: [],
    education: [],
    certifications: [],
    totalYearsExperience: null,
    ...overrides,
  };
}

test("criticality maps deterministically to tiers, never from keyword frequency (RequirementUnit carries no occurrence count at all)", () => {
  const requirements: RequirementUnit[] = [
    unit({ label: "Snowflake", memberSkillNames: ["Snowflake"], criticality: "CRITICAL" }),
    unit({ label: "dbt", memberSkillNames: ["dbt"], criticality: "REQUIRED" }),
    unit({ label: "Airflow", memberSkillNames: ["Airflow"], criticality: "PREFERRED" }),
    unit({ label: "Docker", memberSkillNames: ["Docker"], criticality: "OPTIONAL" }),
  ];
  const matrix = buildJdPriorityMatrix(requirements, "Senior Data Engineer", undefined);
  assert.equal(matrix.targetRoleTitle, "Senior Data Engineer");
  const byLabel = Object.fromEntries(matrix.requirements.map((r) => [r.requirement, r.priority]));
  assert.equal(byLabel["Snowflake"], "P1");
  assert.equal(byLabel["dbt"], "P2");
  assert.equal(byLabel["Airflow"], "P3");
  assert.equal(byLabel["Docker"], "P4");
});

test("a secondary technology represented by MANY OPTIONAL/PREFERRED units can never outnumber its way into P1 — tier count is irrelevant to tier assignment", () => {
  const manySecondaryUnits: RequirementUnit[] = ["Docker", "Kubernetes", "Prometheus", "Grafana", "Terraform"].map((label) =>
    unit({ label, memberSkillNames: [label], criticality: "OPTIONAL" })
  );
  const oneCoreUnit = unit({ label: "Snowflake", memberSkillNames: ["Snowflake"], criticality: "CRITICAL" });
  const matrix = buildJdPriorityMatrix([...manySecondaryUnits, oneCoreUnit], "Senior Data Engineer", undefined);

  const core = corePriorityRequirements(matrix);
  assert.deepEqual(core.map((r) => r.requirement), ["Snowflake"]);
  // Five P4 units existing alongside it changes nothing about which single unit is P1.
  assert.equal(matrix.requirements.filter((r) => r.priority === "P4").length, 5);
  assert.equal(matrix.requirements.filter((r) => r.priority === "P1").length, 1);
});

test("evidence strength is computed against the CandidateProfile only — the JD itself is never treated as evidence", () => {
  const candidate = profile({
    skills: [{ rawSkillName: "Azure", source: "inventory_only" }],
    experience: [{ employer: "Acme", title: "Data Engineer", startDate: "2020-01", endDate: null, technologies: ["Snowflake"] }],
  });
  const requirements: RequirementUnit[] = [
    unit({ label: "Snowflake", memberSkillNames: ["Snowflake"], criticality: "CRITICAL" }), // used at an employer -> STRONG
    unit({ label: "Azure", memberSkillNames: ["Azure"], criticality: "PREFERRED" }), // inventory only -> PARTIAL
    unit({ label: "Kafka", memberSkillNames: ["Kafka"], criticality: "OPTIONAL" }), // never claimed anywhere -> NONE
  ];
  const matrix = buildJdPriorityMatrix(requirements, "Data Engineer", candidate);
  const byLabel = Object.fromEntries(matrix.requirements.map((r) => [r.requirement, r]));
  assert.equal(byLabel["Snowflake"].evidenceStrength, "STRONG");
  assert.deepEqual(byLabel["Snowflake"].evidenceReferences, ["Snowflake"]);
  assert.equal(byLabel["Azure"].evidenceStrength, "PARTIAL");
  assert.equal(byLabel["Kafka"].evidenceStrength, "NONE");
  assert.equal(byLabel["Kafka"].evidenceAvailable, false);
});

test("no CandidateProfile supplied -> every requirement evidenceStrength is NONE, never guessed as supported", () => {
  const requirements: RequirementUnit[] = [unit({ label: "Snowflake", memberSkillNames: ["Snowflake"], criticality: "CRITICAL" })];
  const matrix = buildJdPriorityMatrix(requirements, "Data Engineer", undefined);
  assert.equal(matrix.requirements[0].evidenceStrength, "NONE");
});

test("requiredOrPreferred reflects Phase 2's own requirementLevel field verbatim", () => {
  const requirements: RequirementUnit[] = [
    unit({ label: "A", memberSkillNames: ["A"], requirementLevel: "Required" }),
    unit({ label: "B", memberSkillNames: ["B"], requirementLevel: "Preferred" }),
  ];
  const matrix = buildJdPriorityMatrix(requirements, null, undefined);
  assert.equal(matrix.requirements[0].requiredOrPreferred, "REQUIRED");
  assert.equal(matrix.requirements[1].requiredOrPreferred, "PREFERRED");
});

test("targetRoleTitle is P0 — a single value, not folded into the requirements list", () => {
  const matrix: JdPriorityMatrix = buildJdPriorityMatrix([], "Staff Data Architect", undefined);
  assert.equal(matrix.targetRoleTitle, "Staff Data Architect");
  assert.equal(matrix.requirements.length, 0);
});

test("no job title supplied -> targetRoleTitle is explicitly null, never fabricated", () => {
  const matrix = buildJdPriorityMatrix([], null, undefined);
  assert.equal(matrix.targetRoleTitle, null);
});
