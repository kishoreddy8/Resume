import assert from "node:assert/strict";
import { test } from "node:test";
import { findTechnologyContradictions, hasMigrationSignal } from "../technologyGroups";

test("Snowflake Schema is dimensional modeling, not the Snowflake warehouse platform", () => {
  assert.deepEqual(
    findTechnologyContradictions("Modeled a Snowflake Schema in Azure Synapse Analytics for finance reporting."),
    []
  );
  assert.deepEqual(
    findTechnologyContradictions("Built a snowflake-schema dimensional model in Azure Synapse Analytics."),
    []
  );
  assert.deepEqual(
    findTechnologyContradictions("Modeled star and snowflake schemas in Azure Synapse Analytics."),
    []
  );
});

test("a real Snowflake platform mention remains detectable", () => {
  const findings = findTechnologyContradictions(
    "Used Azure Synapse Analytics and the Snowflake warehouse as primary platforms for the same reporting layer."
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].foundMembers, ["Azure Synapse Analytics", "Snowflake"]);
});

test("same-responsibility competing CI/CD platforms still fail", () => {
  const findings = findTechnologyContradictions(
    "Used Azure DevOps and Jenkins as simultaneous primary deployment platforms for the same release pipeline."
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].foundMembers, ["Azure DevOps", "Jenkins"]);
});

test("the existing explicit migration and integration exceptions remain narrow and effective", () => {
  assert.equal(hasMigrationSignal("Migrated the warehouse from Snowflake to Azure Synapse Analytics."), true);
  assert.deepEqual(
    findTechnologyContradictions("Migrated the warehouse from Snowflake to Azure Synapse Analytics."),
    []
  );
  assert.deepEqual(
    findTechnologyContradictions("Used Snowflake and Azure Synapse Analytics for the same warehouse layer."),
    [{
      group: {
        members: ["Azure Synapse Analytics", "Redshift", "BigQuery", "Snowflake"],
        label: "competing data warehouses positioned as primary",
      },
      foundMembers: ["Azure Synapse Analytics", "Snowflake"],
    }]
  );
});
