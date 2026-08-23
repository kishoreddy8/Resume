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

// --- SUMMARY QUALITY V2 (2026-08-23) ----------------------------------------------------------------

test("a summary missing the JD's dominant technologies is now gated, not merely advisory", () => {
  const summary = ["Backend engineer with strong experience in Java, Spring Boot, and microservices architecture design."];
  const jobRequirements = [unit({ memberSkillNames: ["Azure Data Factory"], criticality: "CRITICAL" }), unit({ memberSkillNames: ["Databricks"], criticality: "CRITICAL" })];
  const result = evaluateSummaryAlignment(summary, jobRequirements);
  assert.ok(result.styleIssuesFound.some((i) => i.includes("dominant")), "must be promoted into styleIssuesFound so it gates READY, not just advises");
});

test("abstract, subject-driven framing is detected and gated", () => {
  const summary = [
    "Senior Data Engineer with 6 years across banking and healthcare.",
    "Platform design spans ingestion, transformation and orchestration on Azure.",
  ];
  const result = evaluateSummaryAlignment(summary, []);
  assert.ok(result.summaryIssues.some((i) => i.includes("abstract")));
  assert.ok(result.styleIssuesFound.some((i) => i.includes("abstract")));
});

test("a concrete sentence using a similar verb but a real subject is never flagged as abstract framing", () => {
  const summary = [
    "Senior Data Engineer with 6 years building Azure data platforms.",
    "Delivery experience extends into Azure Synapse Analytics for downstream analytics teams.",
  ];
  const result = evaluateSummaryAlignment(summary, []);
  assert.ok(!result.styleIssuesFound.some((i) => i.includes("abstract")), "must not flag a concrete, technology-naming sentence just because it shares a verb");
});

test("a summary that never names or aligns with the target role is flagged", () => {
  const summary = ["Built large-scale batch and streaming pipelines on Azure Databricks for banking and healthcare clients."];
  const result = evaluateSummaryAlignment(summary, [], "Senior Data Engineer");
  assert.ok(result.styleIssuesFound.some((i) => i.includes("target role")));
});

test("a summary that names the target role's own domain word is never flagged for target-role clarity", () => {
  const summary = ["Senior Data Engineer with 6 years building Azure Databricks pipelines for banking and healthcare clients."];
  const result = evaluateSummaryAlignment(summary, [], "Senior Data Engineer");
  assert.ok(!result.styleIssuesFound.some((i) => i.includes("target role")));
});

test("target-role clarity is not checked when no target role title is supplied", () => {
  const summary = ["Built large-scale batch and streaming pipelines on Azure Databricks for banking and healthcare clients."];
  const result = evaluateSummaryAlignment(summary, []);
  assert.ok(!result.styleIssuesFound.some((i) => i.includes("target role")));
});

test("a keyword-stuffed summary (many distinct technologies, few words) is detected", () => {
  const summary = [
    "Azure Databricks PySpark Kafka Snowflake Airflow dbt Terraform Kubernetes Docker Jenkins engineer.",
  ];
  const result = evaluateSummaryAlignment(summary, []);
  assert.ok(result.styleIssuesFound.some((i) => i.includes("keyword list")));
});

test("a technology-dense but genuinely written summary is not flagged as keyword stuffing", () => {
  const summary = [
    "Senior Data Engineer with 6 years building Azure data platforms across banking and healthcare organizations nationwide.",
    "Hands-on experience with Azure Data Factory and Databricks pipelines spanning both batch ETL and real-time streaming workloads.",
    "Production engineering strengths include data quality automation, performance tuning, and CI/CD delivery through GitHub Actions.",
  ];
  const result = evaluateSummaryAlignment(summary, []);
  assert.ok(!result.styleIssuesFound.some((i) => i.includes("keyword list")));
});

test("AI/ML technologies dominating a non-AI/ML target role's summary is flagged", () => {
  const summary = [
    "AI Engineer with 5 years delivering GenAI and machine learning platforms.",
    "Hands-on experience with LangChain, MLflow, PyTorch, and RAG-based retrieval systems.",
  ];
  const result = evaluateSummaryAlignment(summary, [], "Senior Data Engineer");
  assert.ok(result.styleIssuesFound.some((i) => i.includes("AI/ML")));
});

test("AI/ML mentioned as a genuine minority secondary differentiator is never flagged as dominance", () => {
  const summary = [
    "Senior Data Engineer with 6 years building Azure data platforms across banking and healthcare.",
    "Hands-on experience with Azure Data Factory, Databricks, PySpark, and Kafka across batch and streaming pipelines.",
    "Production engineering strengths include data quality automation, performance tuning, and CI/CD delivery.",
    "Additional experience delivering Azure OpenAI and RAG solutions.",
  ];
  const result = evaluateSummaryAlignment(summary, [], "Senior Data Engineer");
  assert.ok(!result.styleIssuesFound.some((i) => i.includes("AI/ML")));
});

test("AI/ML dominance is never flagged when the target role itself is AI/ML-focused", () => {
  const summary = [
    "AI Engineer with 5 years delivering GenAI and machine learning platforms.",
    "Hands-on experience with LangChain, MLflow, PyTorch, and RAG-based retrieval systems.",
  ];
  const result = evaluateSummaryAlignment(summary, [], "AI Engineer");
  assert.ok(!result.styleIssuesFound.some((i) => i.includes("AI/ML")));
});

test("a clean, well-structured summary produces no style issues at all", () => {
  const summary = [
    "Senior Data Engineer with 6 years building Azure data platforms across banking and healthcare.",
    "Hands-on experience with Azure Data Factory and Databricks pipelines across batch and real-time workloads.",
    "Production engineering strengths include data quality automation, performance tuning, and CI/CD delivery.",
    "Additional experience delivering Azure OpenAI and RAG solutions.",
  ];
  const jobRequirements = [unit({ memberSkillNames: ["Azure Data Factory"], criticality: "CRITICAL" }), unit({ memberSkillNames: ["Databricks"], criticality: "CRITICAL" })];
  const result = evaluateSummaryAlignment(summary, jobRequirements, "Senior Data Engineer");
  assert.deepEqual(result.styleIssuesFound, []);
});
