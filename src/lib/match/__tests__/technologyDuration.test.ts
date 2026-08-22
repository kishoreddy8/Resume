import assert from "node:assert/strict";
import { test } from "node:test";
import { extractTechnologySpecificYears } from "../technologyDuration";

test("TD-1: '4+ years Databricks' is recognized", () => {
  assert.equal(extractTechnologySpecificYears(["…4+ years Databricks experience required…"]), 4);
});

test("TD-2: '5 years Azure Data Factory' is recognized", () => {
  assert.equal(extractTechnologySpecificYears(["5 years Azure Data Factory (ADF) pipeline development"]), 5);
});

test("TD-3: '3+ years Snowflake experience' is recognized", () => {
  assert.equal(extractTechnologySpecificYears(["3+ years Snowflake experience building data warehouses"]), 3);
});

test("TD-4: 'minimum 4 years PySpark' is recognized", () => {
  assert.equal(extractTechnologySpecificYears(["Candidate must have minimum 4 years PySpark development"]), 4);
});

test("TD-5: 'at least 5 years experience with ADF' is recognized", () => {
  assert.equal(extractTechnologySpecificYears(["at least 5 years experience with ADF pipelines"]), 5);
});

test("TD-6: an overall/career-total figure sharing the same snippet as a technology mention is NEVER extracted", () => {
  // The exact critical distinction: "10 years overall experience; Databricks required" must not
  // become "10 years Databricks".
  assert.equal(extractTechnologySpecificYears(["10 years overall experience; Databricks required"]), null);
  assert.equal(extractTechnologySpecificYears(["8+ years of total IT experience, Snowflake a plus"]), null);
  assert.equal(extractTechnologySpecificYears(["6 years combined engineering background, PySpark preferred"]), null);
  assert.equal(extractTechnologySpecificYears(["12 years career experience in data platforms, Kafka desired"]), null);
});

test("TD-7: no duration stated at all returns null, never guessed", () => {
  assert.equal(extractTechnologySpecificYears(["Strong experience with Databricks"]), null);
  assert.equal(extractTechnologySpecificYears(["Databricks required"]), null);
  assert.equal(extractTechnologySpecificYears([]), null);
});

test("TD-8: an unsupported/unrelated technology's snippet with no years figure returns null", () => {
  assert.equal(extractTechnologySpecificYears(["Familiarity with Kubernetes is a plus"]), null);
});

test("TD-9: a non-experience number ('5 9s uptime') never matches — the literal word year(s) is required", () => {
  assert.equal(extractTechnologySpecificYears(["Must maintain 5 9s uptime for Databricks clusters"]), null);
});

test("TD-10: an out-of-bounds figure is rejected as a parse artefact, not accepted as a career", () => {
  assert.equal(extractTechnologySpecificYears(["99 years Databricks required (typo)"]), null);
  assert.equal(extractTechnologySpecificYears(["0 years Databricks"]), null);
});

test("TD-11: the first plausible snippet wins when multiple snippets are given", () => {
  assert.equal(extractTechnologySpecificYears(["Databricks required", "4+ years Databricks preferred"]), 4);
});

test("TD-12: generic — proves the detector is not hardcoded to any specific technology name", () => {
  for (const tech of ["Databricks", "Azure Data Factory", "Snowflake", "PySpark", "Kafka", "Some Future Technology XYZ"]) {
    assert.equal(extractTechnologySpecificYears([`4+ years ${tech} experience required`]), 4, `expected 4 for ${tech}`);
  }
});
