import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCanonicalSkillsFromText, resolveSkillForReview } from "../skillAliases";

test("resolveSkillForReview: shared taxonomy resolution still works unmodified (Databricks)", () => {
  assert.equal(resolveSkillForReview("Databricks")?.canonical, "Databricks");
});

test("resolveSkillForReview: supplementary alias ADF resolves to Azure Data Factory", () => {
  assert.equal(resolveSkillForReview("ADF")?.canonical, "Azure Data Factory");
});

test("resolveSkillForReview: supplementary alias 'AWS Glue' resolves to its own canonical, not the generic AWS entry", () => {
  assert.equal(resolveSkillForReview("AWS Glue")?.canonical, "AWS Glue");
});

test("resolveSkillForReview: supplementary alias 'Azure Databricks' resolves to Databricks", () => {
  assert.equal(resolveSkillForReview("Azure Databricks")?.canonical, "Databricks");
});

test("resolveSkillForReview: PySpark and Spark never conflate", () => {
  assert.equal(resolveSkillForReview("PySpark")?.canonical, "PySpark");
  assert.equal(resolveSkillForReview("Spark")?.canonical, "Spark");
  assert.notEqual(resolveSkillForReview("PySpark")?.canonical, resolveSkillForReview("Spark")?.canonical);
});

test("resolveSkillForReview: PySpark never resolves to Python", () => {
  assert.notEqual(resolveSkillForReview("PySpark")?.canonical, "Python");
});

test("resolveSkillForReview: Azure OpenAI never resolves to a bare 'OpenAI' entry (none exists)", () => {
  assert.equal(resolveSkillForReview("Azure OpenAI")?.canonical, "Azure OpenAI");
  assert.equal(resolveSkillForReview("OpenAI"), null, "no bare OpenAI canonical exists in the taxonomy to accidentally match");
});

test("resolveSkillForReview: unrecognized terms return null, never guessed", () => {
  assert.equal(resolveSkillForReview("Completely Made Up Technology XYZ"), null);
});

test("extractCanonicalSkillsFromText: a specific term (AWS Glue) is credited to its own canonical, not double-credited to the generic AWS entry too", () => {
  const found = extractCanonicalSkillsFromText("Built pipelines using AWS Glue and S3.");
  assert.ok(found.has("AWS Glue"));
  assert.ok(!found.has("AWS"), "the more specific match should consume the span, not also credit the shorter generic alias");
});

test("extractCanonicalSkillsFromText: bare AWS is still credited when no more specific AWS product is mentioned", () => {
  const found = extractCanonicalSkillsFromText("Worked extensively with AWS infrastructure.");
  assert.ok(found.has("AWS"));
});

test("extractCanonicalSkillsFromText: extracts multiple distinct canonical skills from one block of text", () => {
  const found = extractCanonicalSkillsFromText("Built Azure Data Factory pipelines to orchestrate Databricks notebooks using PySpark.");
  assert.ok(found.has("Azure Data Factory"));
  assert.ok(found.has("Databricks"));
  assert.ok(found.has("PySpark"));
});
