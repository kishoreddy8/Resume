import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequirementUnit } from "@/lib/match/types";
import { evaluateSummaryAlignment } from "../summaryChecks";

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

test("22. a summary aligned with the JD's dominant stack passes with no alignment issues", () => {
  const summary = ["Senior Data Engineer with 6 years building Azure Data Factory and Databricks pipelines for large-scale analytics platforms."];
  const jobRequirements = [
    unit({ memberSkillNames: ["Azure Data Factory"], criticality: "CRITICAL" }),
    unit({ memberSkillNames: ["Databricks"], criticality: "CRITICAL" }),
  ];
  const result = evaluateSummaryAlignment(summary, jobRequirements);
  assert.deepEqual(result.summaryIssues, []);
});

test("23. a generic, low-content summary is flagged", () => {
  const result = evaluateSummaryAlignment(["Hardworking engineer."], []);
  assert.ok(result.summaryIssues.some((i) => i.includes("short")));
});

test("23b. an empty summary is flagged", () => {
  const result = evaluateSummaryAlignment([""], []);
  assert.ok(result.summaryIssues.some((i) => i.includes("empty")));
});

test("24. a summary emphasizing the wrong dominant cloud stack is flagged", () => {
  const summary = ["Senior Data Engineer with deep AWS Glue and Redshift experience building analytics pipelines."];
  const jobRequirements = [unit({ memberSkillNames: ["Azure"], criticality: "CRITICAL" }), unit({ memberSkillNames: ["Azure Data Factory"], criticality: "CRITICAL" })];
  const result = evaluateSummaryAlignment(summary, jobRequirements);
  assert.ok(result.summaryIssues.some((i) => i.includes("AWS") && i.includes("Azure")));
});

test("summary alignment with no job requirements surfaces the limitation, not a silent pass", () => {
  const result = evaluateSummaryAlignment(["A long enough summary sentence about data engineering work and platforms."], undefined);
  assert.equal(result.insufficientRequirementData, true);
});

test("a summary missing the JD's dominant technologies entirely is flagged", () => {
  const summary = ["Backend engineer with strong experience in Java, Spring Boot, and microservices architecture design."];
  const jobRequirements = [unit({ memberSkillNames: ["Azure Data Factory"], criticality: "CRITICAL" }), unit({ memberSkillNames: ["Databricks"], criticality: "CRITICAL" })];
  const result = evaluateSummaryAlignment(summary, jobRequirements);
  assert.ok(result.summaryIssues.some((i) => i.includes("dominant")));
});
