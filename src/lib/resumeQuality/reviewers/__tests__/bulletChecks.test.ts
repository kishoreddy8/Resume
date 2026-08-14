import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExperienceEntry } from "../../../../../tools/tailoring-engine/types";
import { evaluateBulletChecks } from "../bulletChecks";

function role(company: string, bullets: string[]): ExperienceEntry {
  return { title: "Data Engineer", company, dates: "2020 - 2023", bullets };
}

test("16. a bullet starting with 'Responsible for' is flagged as generic", () => {
  const result = evaluateBulletChecks([role("Acme", ["Responsible for building data pipelines using Azure Data Factory and Databricks."])]);
  assert.ok(result.genericBullets.length > 0);
  assert.ok(result.corrections.some((c) => c.description.includes("Responsible for")));
});

test("17. a bullet starting with 'Worked on' is flagged as generic", () => {
  const result = evaluateBulletChecks([role("Acme", ["Worked on data pipelines using Azure Data Factory and Databricks."])]);
  assert.ok(result.genericBullets.length > 0);
});

test("18. banned AI-sounding language is flagged", () => {
  const result = evaluateBulletChecks([role("Acme", ["Leveraged cutting-edge tools to seamlessly optimize the data pipeline architecture."])]);
  assert.ok(result.corrections.some((c) => c.description.includes("Banned AI-sounding language")));
});

test("19. exact duplicate bullets across roles are flagged", () => {
  const result = evaluateBulletChecks([
    role("Acme", ["Built ETL pipelines to process customer transaction data daily."]),
    role("Beta LLC", ["Built ETL pipelines to process customer transaction data daily."]),
  ]);
  assert.ok(result.corrections.some((c) => c.description.includes("Duplicate")));
});

test("19b. near-identical (punctuation/case only) duplicate bullets are flagged", () => {
  const result = evaluateBulletChecks([
    role("Acme", ["Built ETL pipelines to process customer transaction data daily."]),
    role("Beta LLC", ["built etl pipelines to process customer transaction data daily"]),
  ]);
  assert.ok(result.corrections.some((c) => c.description.includes("Duplicate")));
});

test("20. more than two consecutive bullets in the same role starting with the same verb are flagged", () => {
  const result = evaluateBulletChecks([
    role("Acme", [
      "Built ingestion pipelines using Azure Data Factory for daily loads.",
      "Built transformation logic in Databricks notebooks for cleansing.",
      "Built monitoring dashboards to track pipeline SLA compliance.",
    ]),
  ]);
  assert.ok(result.corrections.some((c) => c.description.includes("consecutive bullets")));
});

test("20b. exactly two consecutive bullets with the same verb are NOT flagged (the limit is 'more than two')", () => {
  const result = evaluateBulletChecks([
    role("Acme", [
      "Built ingestion pipelines using Azure Data Factory for daily loads.",
      "Built transformation logic in Databricks notebooks for cleansing.",
      "Configured monitoring dashboards to track pipeline SLA compliance.",
    ]),
  ]);
  assert.ok(!result.corrections.some((c) => c.description.includes("consecutive bullets")));
});

test("21. a legitimate, specific technical bullet with no defects passes cleanly", () => {
  const result = evaluateBulletChecks([
    role("Acme", ["Designed and deployed Azure Data Factory pipelines that reduced nightly batch processing time from 6 hours to 45 minutes."]),
  ]);
  assert.deepEqual(result.genericBullets, []);
  assert.equal(result.readabilityDeductions, 0);
});

test("a very short bullet is flagged", () => {
  const result = evaluateBulletChecks([role("Acme", ["Did stuff."])]);
  assert.ok(result.genericBullets.length > 0);
});

test("a run-on/overly long bullet is flagged", () => {
  const longBullet =
    "Designed, built, deployed, monitored, and continuously optimized a comprehensive suite of Azure Data Factory pipelines, Databricks notebooks, and Synapse Analytics dashboards across multiple business units while coordinating closely with cross-functional stakeholders across engineering, product, and analytics teams on requirements gathering, prioritization, and delivery timelines throughout each quarterly planning cycle.";
  const result = evaluateBulletChecks([role("Acme", [longBullet])]);
  assert.ok(result.corrections.some((c) => c.description.includes("long/run-on")));
});

test("empty bullet strings are ignored, not flagged as defects", () => {
  const result = evaluateBulletChecks([role("Acme", [""])]);
  assert.deepEqual(result.genericBullets, []);
});
