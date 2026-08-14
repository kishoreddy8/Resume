import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequirementUnit } from "@/lib/match/types";
import type { SkillGroup } from "../../../../../tools/tailoring-engine/types";
import { evaluateSkillsOrdering } from "../skillsOrderingChecks";

function unit(overrides: Partial<RequirementUnit>): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: [],
    categories: [],
    label: "requirement",
    requirementLevel: "Required",
    criticality: "REQUIRED",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    fromUnclaimedText: false,
    ...overrides,
  };
}

test("25. dominant JD skills prioritized near the top of Technical Skills produce zero ordering issues", () => {
  const skillGroups: SkillGroup[] = [
    { label: "Cloud & Data Platform", items: ["Azure Data Factory", "Databricks"] },
    { label: "Programming", items: ["Python", "SQL"] },
  ];
  const jobRequirements = [unit({ memberSkillNames: ["Azure Data Factory"], criticality: "CRITICAL" }), unit({ memberSkillNames: ["Databricks"], criticality: "CRITICAL" })];
  const result = evaluateSkillsOrdering(skillGroups, jobRequirements);
  assert.deepEqual(result.skillsOrderingIssues, []);
});

test("26. a missing dominant required skill (absent from Technical Skills entirely) is flagged", () => {
  const skillGroups: SkillGroup[] = [{ label: "Programming", items: ["Python", "SQL"] }];
  const jobRequirements = [unit({ memberSkillNames: ["Azure Data Factory"], criticality: "CRITICAL" })];
  const result = evaluateSkillsOrdering(skillGroups, jobRequirements);
  assert.ok(result.skillsOrderingIssues.some((i) => i.includes("does not appear")));
});

test("a dominant JD skill buried behind several unrelated categories is flagged", () => {
  const skillGroups: SkillGroup[] = [
    { label: "Testing", items: ["Pytest", "Selenium"] },
    { label: "Monitoring", items: ["Datadog", "Grafana"] },
    { label: "BI / Reporting", items: ["Tableau", "Power BI"] },
    { label: "Cloud & Data Platform", items: ["Azure Data Factory"] },
  ];
  const jobRequirements = [unit({ memberSkillNames: ["Azure Data Factory"], criticality: "CRITICAL" })];
  const result = evaluateSkillsOrdering(skillGroups, jobRequirements);
  assert.ok(result.skillsOrderingIssues.some((i) => i.includes("buried")));
});

test("skills ordering with no job requirements surfaces the limitation, not a silent pass", () => {
  const result = evaluateSkillsOrdering([{ label: "Core", items: ["Python"] }], undefined);
  assert.equal(result.insufficientRequirementData, true);
});
