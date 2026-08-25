import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AccomplishmentUnit, CandidateAccomplishmentPackage } from "../accomplishmentEvidence";
import { buildCompactEvidence, renderCompactEvidenceLine, renderCompactAccomplishmentEvidenceSection } from "../compactEvidence";

/**
 * PHASE 6.6B — DETERMINISTIC EVIDENCE COMPACTION regression suite.
 *
 * buildCompactEvidence operates on a single, already-extracted, already-verified AccomplishmentUnit
 * (technologies[], rawText, category, explicitMetricEvidence) and is deliberately cloud/ecosystem-
 * AGNOSTIC by construction: it never inspects target ecosystem, primary platform, or supporting
 * cloud at all -- it only classifies whatever technologies the (already-verified) unit already lists,
 * via the SAME shared classifyTechnology() registry architecturePalette.ts itself uses. This is what
 * "works across all target ecosystems automatically" means in practice -- there is no per-cloud
 * branch to test, only the SAME transform applied to units shaped like each cloud's real evidence.
 */

function unit(overrides: Partial<AccomplishmentUnit>): AccomplishmentUnit {
  return {
    id: "test_acc_0",
    employer: "Test Employer",
    title: "Data Engineer",
    dates: "2024-01 - Present",
    sourceType: "master_resume",
    sourceReference: "master_resume:bullet_1",
    rawText: "Engineered pipelines.",
    actionVerb: "Engineered",
    technologies: [],
    category: "etl_pipeline",
    importanceScore: 5,
    ...overrides,
  };
}

describe("Phase 6.6B: cross-cloud compact-evidence test matrix (EVIDENCE-*)", () => {
  it("EVIDENCE-AZURE-01: SQL Server -> ADF -> ADLS/Databricks classifies correctly, no hardcoded cloud branch", () => {
    const acc = unit({
      employer: "Comerica Bank",
      rawText: "Architected metadata-driven Azure Data Factory pipelines ingesting SQL Server into ADLS Gen2, processed with Azure Databricks, cutting batch runtime 30%.",
      technologies: ["SQL Server", "Azure Data Factory", "ADLS Gen2", "Azure Databricks"],
      explicitMetricEvidence: "30%",
    });
    const compact = buildCompactEvidence(acc);
    assert.deepEqual(compact.source, ["SQL Server"]);
    assert.deepEqual(compact.orchestration, ["Azure Data Factory"]);
    assert.deepEqual(compact.storage, ["ADLS Gen2"]);
    assert.deepEqual(compact.processing, ["Azure Databricks"]);
    assert.equal(compact.employer, "Comerica Bank");
  });

  it("EVIDENCE-AWS-01: SQL Server -> AWS Glue -> S3/Databricks classifies correctly via the same transform", () => {
    const acc = unit({
      employer: "AWS Employer",
      rawText: "Engineered AWS Glue pipelines ingesting SQL Server into Amazon S3, processed with Databricks, reducing cost 22%.",
      technologies: ["SQL Server", "AWS Glue", "Amazon S3", "Databricks"],
      explicitMetricEvidence: "22%",
    });
    const compact = buildCompactEvidence(acc);
    assert.deepEqual(compact.source, ["SQL Server"]);
    assert.deepEqual(compact.orchestration, ["AWS Glue"]);
    assert.deepEqual(compact.storage, ["Amazon S3"]);
    assert.deepEqual(compact.processing, ["Databricks"]);
  });

  it("EVIDENCE-GCP-01: supported GCP architecture compacts without ever inventing unsupported Cloud Data Fusion", () => {
    // The candidate's real evidence for this employer never mentions Cloud Data Fusion -- the
    // compaction transform must not introduce it merely because the employer is GCP-assigned.
    const acc = unit({
      employer: "GCP Employer",
      rawText: "Built BigQuery analytics pipelines processing data with Python, improving query latency 40%.",
      technologies: ["BigQuery", "Python"],
      explicitMetricEvidence: "40%",
    });
    const compact = buildCompactEvidence(acc);
    const allTech = [...compact.source, ...compact.orchestration, ...compact.processing, ...compact.storage, ...compact.warehouse, ...compact.other];
    assert.ok(!allTech.some((t) => /cloud data fusion/i.test(t)), "Cloud Data Fusion must never be invented");
    assert.deepEqual(compact.warehouse, ["BigQuery"]);
  });

  it("EVIDENCE-SNOWFLAKE-01: Snowflake-centered evidence with no cloud orchestration tech stays intact (no fabricated orchestration stage)", () => {
    const acc = unit({
      employer: "Microgate Technologies",
      rawText: "Optimized Snowflake processing time through warehouse tuning, reducing runtime 40%.",
      technologies: ["Snowflake"],
      explicitMetricEvidence: "40%",
    });
    const compact = buildCompactEvidence(acc);
    assert.deepEqual(compact.warehouse, ["Snowflake"]);
    assert.deepEqual(compact.orchestration, [], "no orchestration technology was ever evidenced -- must not be fabricated");
    assert.deepEqual(compact.source, []);
  });

  it("EVIDENCE-DATABRICKS-01: Databricks-centered architecture (processing + storage, no warehouse) stays intact", () => {
    const acc = unit({
      employer: "Databricks Employer",
      rawText: "Processed data using Databricks and PySpark into Delta Lake medallion layers, cutting nightly runtime 28%.",
      technologies: ["Databricks", "PySpark", "Delta Lake"],
      category: "architecture",
      explicitMetricEvidence: "28%",
    });
    const compact = buildCompactEvidence(acc);
    assert.deepEqual(compact.processing.sort(), ["Databricks", "PySpark"].sort());
    assert.deepEqual(compact.storage, ["Delta Lake"]);
    assert.deepEqual(compact.warehouse, [], "no warehouse technology was ever evidenced -- must not be fabricated");
  });

  it("EVIDENCE-MULTICLOUD-01: an Azure employer's evidence and an AWS employer's evidence remain fully isolated", () => {
    const azureAcc = unit({ id: "azure_acc_0", employer: "Comerica Bank", technologies: ["Azure Data Factory"], rawText: "Built ADF pipelines." });
    const awsAcc = unit({ id: "aws_acc_0", employer: "AWS Employer", technologies: ["AWS Glue"], rawText: "Built Glue pipelines." });
    const azureCompact = buildCompactEvidence(azureAcc);
    const awsCompact = buildCompactEvidence(awsAcc);
    assert.equal(azureCompact.employer, "Comerica Bank");
    assert.equal(awsCompact.employer, "AWS Employer");
    assert.ok(!azureCompact.orchestration.includes("AWS Glue"));
    assert.ok(!awsCompact.orchestration.includes("Azure Data Factory"));
  });

  it("EVIDENCE-MULTICLOUD-02: an AWS+GCP two-cloud pair injects zero Azure technology into either", () => {
    const awsAcc = unit({ id: "aws_acc_1", employer: "AWS Employer", technologies: ["AWS Glue", "Amazon S3"], rawText: "AWS pipeline work." });
    const gcpAcc = unit({ id: "gcp_acc_1", employer: "GCP Employer", technologies: ["BigQuery"], rawText: "GCP warehouse work." });
    const awsCompact = buildCompactEvidence(awsAcc);
    const gcpCompact = buildCompactEvidence(gcpAcc);
    const allTech = [
      ...awsCompact.source, ...awsCompact.orchestration, ...awsCompact.processing, ...awsCompact.storage, ...awsCompact.warehouse, ...awsCompact.other,
      ...gcpCompact.source, ...gcpCompact.orchestration, ...gcpCompact.processing, ...gcpCompact.storage, ...gcpCompact.warehouse, ...gcpCompact.other,
    ];
    assert.ok(!allTech.some((t) => /azure/i.test(t)), "no Azure technology may appear in a pure AWS+GCP pair");
  });

  it("EVIDENCE-METRIC-01: '30% runtime reduction' remains exactly 30% AND the runtime-reduction meaning, never collapsed to '30% improvement'", () => {
    const acc = unit({
      rawText: "Built PySpark transformations cutting batch processing time 30% compared to the legacy jobs they replaced.",
      technologies: ["PySpark"],
      explicitMetricEvidence: "30%",
    });
    const compact = buildCompactEvidence(acc);
    assert.equal(compact.outcome?.metric, "30%");
    assert.match(compact.outcome!.meaning, /batch processing time/);
    assert.doesNotMatch(compact.outcome!.meaning, /improvement/i, "must never be paraphrased to a generic 'improvement' meaning");
  });

  it("EVIDENCE-PROVENANCE-01: a metric/accomplishment cannot move between employers -- evidenceId and employer stay bound together", () => {
    const pkg: CandidateAccomplishmentPackage = {
      employers: [
        {
          employer: "Comerica Bank", title: "Data Engineer", dates: "2025 - Present",
          projectContext: "x", supportedTechnologies: [], availableViaMsi: [], prohibitedTargetSkills: [],
          verifiedAccomplishments: [unit({ id: "comerica_bank_acc_0", employer: "Comerica Bank", technologies: ["Snowflake"], rawText: "Comerica work cutting cost 10%.", explicitMetricEvidence: "10%" })],
        },
        {
          employer: "Fiserv", title: "Data Engineer", dates: "2023 - 2025",
          projectContext: "x", supportedTechnologies: [], availableViaMsi: [], prohibitedTargetSkills: [],
          verifiedAccomplishments: [unit({ id: "fiserv_acc_0", employer: "Fiserv", technologies: ["Delta Lake"], rawText: "Fiserv work cutting runtime 20%.", explicitMetricEvidence: "20%" })],
        },
      ],
      totalAccomplishmentsConsidered: 2,
      totalAccomplishmentsSelected: 2,
    };
    const rendered = renderCompactAccomplishmentEvidenceSection(pkg);
    const comericaSectionIdx = rendered.indexOf("### Comerica Bank");
    const fiservSectionIdx = rendered.indexOf("### Fiserv");
    const comericaSection = rendered.slice(comericaSectionIdx, fiservSectionIdx);
    const fiservSection = rendered.slice(fiservSectionIdx);
    assert.match(comericaSection, /10%/);
    assert.doesNotMatch(comericaSection, /20%/, "Fiserv's metric must never appear under Comerica's section");
    assert.match(fiservSection, /20%/);
    assert.doesNotMatch(fiservSection, /10%/, "Comerica's metric must never appear under Fiserv's section");
  });

  it("EVIDENCE-UNSUPPORTED-01: compaction never introduces a technology absent from the original unit.technologies", () => {
    const acc = unit({
      technologies: ["Snowflake", "Python"],
      rawText: "Built Snowflake and Python pipelines, improving throughput 15%.",
      explicitMetricEvidence: "15%",
    });
    const compact = buildCompactEvidence(acc);
    const allOutput = [...compact.source, ...compact.orchestration, ...compact.processing, ...compact.storage, ...compact.warehouse, ...compact.other];
    const inputLower = new Set(acc.technologies.map((t) => t.toLowerCase()));
    for (const t of allOutput) {
      assert.ok(
        inputLower.has(t.toLowerCase()) || [...inputLower].some((i) => t.toLowerCase().includes(i) || i.includes(t.toLowerCase())),
        `compact evidence introduced "${t}" which was not in the original technologies list`
      );
    }
  });
});

describe("Phase 6.6B: additional semantic-equivalence properties", () => {
  it("preserves employer ownership on the rendered line label", () => {
    const acc = unit({ employer: "Comerica Bank", technologies: ["Snowflake"] });
    const compact = buildCompactEvidence(acc);
    assert.equal(compact.employer, "Comerica Bank");
  });

  it("preserves evidence ID / provenance exactly", () => {
    const acc = unit({ id: "comerica_bank_acc_3" });
    const compact = buildCompactEvidence(acc);
    assert.equal(compact.evidenceId, "comerica_bank_acc_3");
  });

  it("preserves capability meaning from the unit's own already-validated category, never a new free-text extraction", () => {
    const dataQuality = buildCompactEvidence(unit({ category: "data_quality" }));
    assert.equal(dataQuality.capability, "data quality");
    const governance = buildCompactEvidence(unit({ category: "governance_security" }));
    assert.equal(governance.capability, "governance & security");
    const general = buildCompactEvidence(unit({ category: "general" }));
    assert.equal(general.capability, undefined, "'general' carries no distinguishing signal and must not force a label");
  });

  it("never fabricates an outcome when no metric was ever extracted", () => {
    const acc = unit({ rawText: "Documented pipeline runbooks and standard operating procedures.", technologies: [] });
    const compact = buildCompactEvidence(acc);
    assert.equal(compact.outcome, undefined);
  });

  it("preserves a technology unrecognized by classifyTechnology in the 'other' bucket rather than dropping it", () => {
    const acc = unit({ technologies: ["SomeInternalToolXYZ"] });
    const compact = buildCompactEvidence(acc);
    assert.ok(compact.other.includes("SomeInternalToolXYZ"), "unrecognized technology must never be silently dropped");
  });

  it("renderCompactEvidenceLine never renders arrow notation for a stage with zero technologies", () => {
    const acc = unit({ technologies: ["Snowflake"] });
    const compact = buildCompactEvidence(acc);
    const line = renderCompactEvidenceLine(compact, "E1");
    assert.doesNotMatch(line, /-> ->/, "must never render an empty arrow segment");
  });
});
