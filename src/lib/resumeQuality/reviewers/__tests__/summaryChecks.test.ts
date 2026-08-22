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
    requestedYears: null,
    fromUnclaimedText: false,
    ...overrides,
  };
}

test("22. a summary aligned with the JD's dominant stack passes with no alignment issues", () => {
  const summary = [
    "Senior Data Engineer with 6 years building Azure data platforms across banking and healthcare.",
    "Hands-on expertise in Azure Data Factory and Databricks pipelines for large-scale analytics platforms.",
    "Experienced in data quality, performance optimization, and production analytics workloads.",
  ];
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

test("Phase A: a single-line summary is flagged as too short to scan in 5-8 seconds", () => {
  const result = evaluateSummaryAlignment(
    ["Senior Data Engineer with 6 years building Azure Data Factory and Databricks pipelines for large-scale analytics platforms and production workloads across banking clients."],
    []
  );
  assert.ok(result.summaryIssues.some((i) => i.includes("only 1 line")));
});

test("Phase A: a sprawling 10-line summary is flagged as too long to scan in 5-8 seconds", () => {
  const summary = Array.from({ length: 10 }, (_, i) => `Sentence number ${i + 1} about the candidate's genuine experience.`);
  const result = evaluateSummaryAlignment(summary, []);
  assert.ok(result.summaryIssues.some((i) => i.includes("10 lines")));
});

test("Phase A: a 4-6 line summary within the target range is never flagged for structure", () => {
  const summary = [
    "Senior Data Engineer with 6 years building Azure data platforms across banking and healthcare.",
    "Hands-on expertise in PySpark, Databricks, and Azure Data Factory across batch and real-time pipelines.",
    "Experienced in data quality, performance optimization, and production analytics workloads.",
    "Additional experience building Azure OpenAI and RAG solutions.",
  ];
  const result = evaluateSummaryAlignment(summary, []);
  assert.ok(!result.summaryIssues.some((i) => i.includes("line")));
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
