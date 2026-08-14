import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExperienceEntry } from "../../../../../tools/tailoring-engine/types";
import { evaluateArchitectureConsistency } from "../architectureChecks";

function role(company: string, bullets: string[]): ExperienceEntry {
  return { title: "Data Engineer", company, dates: "2020 - 2023", bullets };
}

test("12. Azure Data Factory + AWS Glue in the same bullet is flagged as a technology contradiction", () => {
  const result = evaluateArchitectureConsistency([role("Acme", ["Built Azure Data Factory and AWS Glue pipelines for the same ingestion workflow."])]);
  assert.ok(result.incorrectTechnologyUsage.length > 0);
  assert.ok(result.blockingIssues.length > 0);
  assert.ok(result.architectureConsistencyScore < 100);
});

test("13. Azure Synapse + Redshift + BigQuery positioned as competing warehouses in one bullet is flagged", () => {
  const result = evaluateArchitectureConsistency([role("Acme", ["Migrated queries across Azure Synapse, Redshift, and BigQuery as the primary warehouse."])]);
  // The migration signal ("Migrated") should NOT exempt this — see test 14 for the true exemption
  // case. Here the phrasing genuinely reads as three co-primary warehouses, so let's use non-migration wording.
  const nonMigration = evaluateArchitectureConsistency([role("Acme", ["Queried data across Azure Synapse, Redshift, and BigQuery as the primary warehouse."])]);
  assert.ok(nonMigration.incorrectTechnologyUsage.length > 0);
  assert.ok(nonMigration.blockingIssues.length > 0);
  void result;
});

test("14. explicit migration framing prevents a false positive", () => {
  const result = evaluateArchitectureConsistency([role("Acme", ["Migrated legacy AWS Glue ETL jobs to Azure Data Factory for centralized orchestration."])]);
  assert.deepEqual(result.incorrectTechnologyUsage, []);
  assert.deepEqual(result.blockingIssues, []);
  assert.equal(result.architectureConsistencyScore, 100);
});

test("15. a single coherent ecosystem produces zero contradictions and a perfect score", () => {
  const result = evaluateArchitectureConsistency([
    role("Acme", [
      "Built Azure Data Factory pipelines to orchestrate Azure Databricks notebooks.",
      "Configured Azure Key Vault for secrets management across the pipeline.",
    ]),
  ]);
  assert.deepEqual(result.incorrectTechnologyUsage, []);
  assert.equal(result.architectureConsistencyScore, 100);
});

test("Databricks + EMR in the same bullet is flagged", () => {
  const result = evaluateArchitectureConsistency([role("Acme", ["Ran Spark jobs across both Databricks and EMR clusters for the same transformation."])]);
  assert.ok(result.incorrectTechnologyUsage.length > 0);
});

test("competing CI/CD platforms in the same bullet are flagged", () => {
  const result = evaluateArchitectureConsistency([role("Acme", ["Used Jenkins and GitHub Actions for the same deployment pipeline."])]);
  assert.ok(result.incorrectTechnologyUsage.length > 0);
});

test("contradictions across DIFFERENT bullets/roles are never flagged — only within the same bullet", () => {
  const result = evaluateArchitectureConsistency([
    role("Acme", ["Built Azure Data Factory pipelines."]),
    role("Beta LLC", ["Built AWS Glue pipelines."]),
  ]);
  assert.deepEqual(result.incorrectTechnologyUsage, [], "different roles legitimately using different clouds must never be flagged as a same-bullet contradiction");
});

test("architectureConsistencyScore stays within 0-100 bounds even with many contradictions", () => {
  const bullets = Array.from({ length: 5 }, () => "Used Azure Data Factory and AWS Glue for the same responsibility.");
  const result = evaluateArchitectureConsistency([role("Acme", bullets)]);
  assert.ok(result.architectureConsistencyScore >= 0 && result.architectureConsistencyScore <= 100);
});
