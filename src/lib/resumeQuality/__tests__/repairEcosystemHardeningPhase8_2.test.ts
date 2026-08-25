import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ResumeContent } from "../types";
import { detectTargetEcosystem, type TargetEcosystemResult } from "../targetEcosystem";
import {
  detectSummaryEcosystemDrift,
  evaluateSummaryAlignment,
  detectApplicationLanguage,
} from "../reviewers/summaryChecks";
import { buildRepairWriterPrompt } from "../repairContextCompiler";
import type { RepairPlan } from "../repairScope";
import { dynamicSummaryTechnologyCeiling } from "../summaryTechnologyBudget";
import { classifyTechnology } from "../technologyClassification";

/**
 * PHASE 8.2 — TARGETED-REPAIR ECOSYSTEM INTEGRITY HARDENING.
 *
 * The live Phase 8.1 WF52 benchmark exposed three production gaps:
 *  1. The minimized targeted-repair package dropped the TargetEcosystemResult, so a summary repair
 *     faithfully reintroduced source-cloud wording ("a single governed Azure Data Lake") into an
 *     AWS-targeted resume.
 *  2. The reviewer's only summary cloud-contradiction check inferred providers from canonical
 *     requirement NAMES, so drift against the raw-JD-derived target went undetected (score 100 → READY).
 *  3. significantSupportedTechnologyCount did not propagate through the repair path, so the repair
 *     prompt rendered the legacy fallback ceiling 7 instead of the JD's real dynamic ceiling 6.
 *
 * These tests exercise the generic contract — nothing is hardcoded to AWS, Job 7832, or the exact
 * Phase 8.1 phrase; every fixture below drives the same production functions.
 */

// ---------------------------------------------------------------------------------------------------
// Ecosystem fixtures — realistic JD wording driving the REAL detectTargetEcosystem, one per shape.
// ---------------------------------------------------------------------------------------------------

function eco(jd: string): TargetEcosystemResult {
  return detectTargetEcosystem({ roleTitle: "Senior Data Engineer", jobDescriptionText: jd, jobRequirements: [] });
}

const ECO_AWS = eco(
  "Design and build ingestion pipelines using AWS Glue moving data into Amazon S3, modeling dimensional schemas in Amazon Redshift for analytics."
);
const ECO_AZURE = eco(
  "Design and build ingestion pipelines in Azure Data Factory moving data into ADLS Gen2, modeling dimensional schemas in Azure Synapse Analytics."
);
const ECO_GCP = eco(
  "Design and build ingestion pipelines moving data into Google Cloud Storage, modeling dimensional schemas in BigQuery, orchestrated with Cloud Composer."
);
const ECO_SNOWFLAKE = eco(
  "Build ELT pipelines loading data into Snowflake, dbt models, dimensional modeling, warehouse migration, data quality and governance. No cloud provider is specified."
);
const ECO_DATABRICKS = eco(
  "Build PySpark pipelines on Databricks with Delta Lake and medallion architecture, CDC and SCD Type 2 history tracking, streaming ingestion."
);
const ECO_TWO_CLOUD = eco(
  "Design and operate data platforms across both AWS and GCP, building AWS Glue and Amazon S3 pipelines for one division and Google Cloud Storage and BigQuery pipelines for the other, supporting workload migration between AWS and GCP."
);

// ---------------------------------------------------------------------------------------------------
// Repair fixtures
// ---------------------------------------------------------------------------------------------------

const SUMMARY_REPAIR_PLAN: RepairPlan = {
  scope: "RESUME_ONLY",
  reason: "Summary sentence 2 reads as a technology list.",
  resumeFindings: ["Summary sentence 2 names 5 technologies and reads as a list rather than a statement."],
  coverLetterFindings: [],
  unattributedFindings: [],
  operations: [
    {
      operation: "REPLACE_SENTENCE",
      artifact: "resume",
      section: "summary",
      rootFinding: "summaryTechnologyList",
      evidenceSource: [],
      reason: "Summary sentence 2 names 5 technologies and reads as a list rather than a statement.",
      candidateInputRequired: false,
      editablePath: "resume.summary[0]",
    } as RepairPlan["operations"] extends (infer T)[] | undefined ? T : never,
  ],
  editablePaths: ["resume.summary[0]"],
};

const BASELINE_RESUME: ResumeContent = {
  name: "Test Candidate",
  tagline: "Data Engineer",
  location: "Dallas, TX",
  phone: "5550000000",
  email: "test@example.com",
  summary: [
    "Data Engineer with 6+ years of experience building cloud data platforms. Recent work modernized batch pipelines. That experience supports senior data engineering work.",
  ],
  skillGroups: [{ label: "Platforms", items: ["Snowflake", "Delta Lake"] }],
  experience: [
    {
      title: "Data Engineer",
      company: "Employer A",
      dates: "Feb 2025 - Present",
      bullets: ["Built ingestion pipelines feeding curated analytics tables."],
      environment: ["Snowflake"],
    },
  ],
  education: ["M.S. in Computer Science, Test University"],
  certifications: [],
};

function buildRepairPrompt(targetEcosystem: TargetEcosystemResult | undefined, significantSupportedTechnologyCount?: number): string {
  return buildRepairWriterPrompt({
    candidateId: 1,
    candidateName: "Test Candidate",
    applicationId: 1,
    jobId: 1,
    tailoringRunId: 1,
    workflowId: 1,
    iterationNumber: 2,
    targetRoleTitle: "Senior Data Engineer",
    companyName: "Test Co",
    repairPlan: SUMMARY_REPAIR_PLAN,
    currentResume: BASELINE_RESUME,
    currentCoverLetter: null,
    targetEcosystem,
    significantSupportedTechnologyCount,
  });
}

// =====================================================================================================
// PART 2/8 — REPAIR-ECOSYSTEM-01..06: the target decision survives repair-context minimization
// =====================================================================================================

describe("Phase 8.2: repair-context ecosystem contract", () => {
  it("REPAIR-ECOSYSTEM-01: AWS target ecosystem is present in summary targeted-repair context", () => {
    assert.equal(ECO_AWS.supportingCloud, "AWS");
    const prompt = buildRepairPrompt(ECO_AWS);
    assert.match(prompt, /Target Ecosystem \(PRESERVE\): AWS/);
    assert.match(prompt, /supporting cloud: AWS/);
    assert.match(prompt, /never reintroduce services incompatible with this target/i);
  });

  it("REPAIR-ECOSYSTEM-02: Azure target ecosystem flows through the identical generic path", () => {
    assert.equal(ECO_AZURE.supportingCloud, "AZURE");
    const prompt = buildRepairPrompt(ECO_AZURE);
    assert.match(prompt, /Target Ecosystem \(PRESERVE\): AZURE/);
    assert.match(prompt, /supporting cloud: AZURE/);
  });

  it("REPAIR-ECOSYSTEM-03: GCP target ecosystem flows through the identical generic path", () => {
    assert.equal(ECO_GCP.supportingCloud, "GCP");
    const prompt = buildRepairPrompt(ECO_GCP);
    assert.match(prompt, /Target Ecosystem \(PRESERVE\): GCP/);
    assert.match(prompt, /supporting cloud: GCP/);
  });

  it("REPAIR-ECOSYSTEM-04: TRUE_TWO_CLOUD preserves both allowed clouds in the contract line", () => {
    assert.equal(ECO_TWO_CLOUD.cloudRequirementMode, "TRUE_TWO_CLOUD");
    const prompt = buildRepairPrompt(ECO_TWO_CLOUD);
    assert.match(prompt, /Target Ecosystem \(PRESERVE\): MULTI_CLOUD/);
    assert.match(prompt, /mode: TRUE_TWO_CLOUD/);
  });

  it("REPAIR-ECOSYSTEM-05: Snowflake-centered contract names the platform and its supporting cloud", () => {
    assert.equal(ECO_SNOWFLAKE.targetEcosystem, "SNOWFLAKE_CENTERED");
    const prompt = buildRepairPrompt(ECO_SNOWFLAKE);
    assert.match(prompt, /Target Ecosystem \(PRESERVE\): SNOWFLAKE_CENTERED/);
    assert.match(prompt, /platform: SNOWFLAKE/);
  });

  it("REPAIR-ECOSYSTEM-06: Databricks-centered contract names the platform and its supporting cloud", () => {
    assert.equal(ECO_DATABRICKS.targetEcosystem, "DATABRICKS_CENTERED");
    const prompt = buildRepairPrompt(ECO_DATABRICKS);
    assert.match(prompt, /Target Ecosystem \(PRESERVE\): DATABRICKS_CENTERED/);
    assert.match(prompt, /platform: DATABRICKS/);
  });
});

// =====================================================================================================
// PART 4/5/8 — SUMMARY-CLOUD-01..09: reviewer-side summary ecosystem drift
// =====================================================================================================

describe("Phase 8.2: summary ecosystem drift detection", () => {
  it("SUMMARY-CLOUD-01: AWS target + 'Azure Data Lake' in summary is detected (the exact Phase 8.1 phrase)", () => {
    const drift = detectSummaryEcosystemDrift(
      "Recent work has centered on consolidating fragmented source systems onto a single governed Azure Data Lake through metadata-driven ingestion.",
      ECO_AWS
    );
    assert.ok(drift.length > 0, "expected 'Azure Data Lake' to be detected as Azure drift under an AWS target");
    assert.ok(drift.some((d) => d.cloud === "AZURE" && /azure data lake/i.test(d.matchedAlias)));
  });

  it("SUMMARY-CLOUD-02: AWS target + 'ADLS Gen2' is detected", () => {
    const drift = detectSummaryEcosystemDrift("Landed operational data into ADLS Gen2 for curated analytics.", ECO_AWS);
    assert.ok(drift.some((d) => d.canonical === "ADLS Gen2" && d.cloud === "AZURE"));
  });

  it("SUMMARY-CLOUD-03: AWS target + Azure Data Factory is detected", () => {
    const drift = detectSummaryEcosystemDrift("Orchestrated ingestion with Azure Data Factory across banking domains.", ECO_AWS);
    assert.ok(drift.some((d) => d.canonical === "Azure Data Factory" && d.cloud === "AZURE"));
  });

  it("SUMMARY-CLOUD-04: Azure target + AWS Glue is detected", () => {
    const drift = detectSummaryEcosystemDrift("Built AWS Glue ingestion pipelines feeding curated zones.", ECO_AZURE);
    assert.ok(drift.some((d) => d.canonical === "AWS Glue" && d.cloud === "AWS"));
  });

  it("SUMMARY-CLOUD-05: GCP target + Azure/AWS primary service is detected", () => {
    const drift = detectSummaryEcosystemDrift(
      "Orchestrated ingestion with Azure Data Factory and landed data in Amazon S3 for analytics.",
      ECO_GCP
    );
    const clouds = new Set(drift.map((d) => d.cloud));
    assert.ok(clouds.has("AZURE"), "Azure Data Factory should be drift under a GCP target");
    assert.ok(clouds.has("AWS"), "Amazon S3 should be drift under a GCP target");
  });

  it("SUMMARY-CLOUD-06: cloud-neutral technologies never trigger (Python/Snowflake/Delta Lake/dbt under AWS target)", () => {
    // Guard the premise too: these must genuinely be non-provider entries in the shared registry.
    for (const t of ["Python", "Snowflake", "Delta Lake", "dbt", "PySpark", "Kafka", "Airflow", "Terraform"]) {
      const entry = classifyTechnology(t);
      if (entry) assert.notEqual(["AWS", "AZURE", "GCP"].includes(entry.cloud), true, `${t} must not be provider-affiliated`);
    }
    const drift = detectSummaryEcosystemDrift(
      "Data Engineer using Python, Snowflake, Delta Lake, dbt, PySpark, Kafka, Airflow, and Terraform to build governed platforms with Git-based CI/CD.",
      ECO_AWS
    );
    assert.deepEqual(drift, []);
  });

  it("SUMMARY-CLOUD-07: TRUE_TWO_CLOUD AWS+GCP permits both AWS and GCP references", () => {
    const drift = detectSummaryEcosystemDrift(
      "Built AWS Glue pipelines into Amazon S3 and modeled BigQuery datasets on Google Cloud Storage.",
      ECO_TWO_CLOUD
    );
    assert.deepEqual(drift, [], "both allowed clouds' services must pass under TRUE_TWO_CLOUD");
    // But the third, unallowed provider is still drift:
    const azureDrift = detectSummaryEcosystemDrift("Also maintained Azure Synapse Analytics models.", ECO_TWO_CLOUD);
    assert.ok(azureDrift.some((d) => d.cloud === "AZURE"));
  });

  it("SUMMARY-CLOUD-08: immutable Azure certification text outside the summary is not an architecture failure", () => {
    // The drift check reads ONLY summary prose. A resume whose certifications carry Azure text but
    // whose summary is clean produces zero summary drift findings.
    const cleanSummary = ["Data Engineer with 6+ years of experience building governed data platforms on AWS Glue and Amazon Redshift."];
    const result = evaluateSummaryAlignment(cleanSummary, undefined, "Senior Data Engineer", ECO_AWS);
    const driftIssues = result.summaryIssues.filter((i) => i.includes("target ecosystem"));
    assert.deepEqual(driftIssues, []);
    // (Certifications never flow into evaluateSummaryAlignment's input at all — enforced by its signature.)
  });

  it("SUMMARY-CLOUD-09: summary application-language behavior remains unchanged", () => {
    assert.ok(detectApplicationLanguage("That experience lines up closely with this role's emphasis on Snowflake.").length > 0);
    assert.deepEqual(
      detectApplicationLanguage("Data Engineer with 6+ years of experience modernizing enterprise data platforms."),
      []
    );
  });

  it("drift findings gate through the existing style-issue severity path (styleIssuesFound)", () => {
    const bad = ["Recent work consolidated sources onto a single governed Azure Data Lake for reporting."];
    const result = evaluateSummaryAlignment(bad, undefined, "Senior Data Engineer", ECO_AWS);
    assert.ok(result.summaryIssues.some((i) => i.includes("target ecosystem")));
    assert.ok(result.styleIssuesFound.some((i) => i.includes("target ecosystem")), "drift must gate, not just advise");
  });

  it("omitting targetEcosystem preserves prior behavior exactly (check skipped)", () => {
    const bad = ["Recent work consolidated sources onto a single governed Azure Data Lake for reporting."];
    const result = evaluateSummaryAlignment(bad, undefined, "Senior Data Engineer");
    assert.ok(!result.summaryIssues.some((i) => i.includes("target ecosystem")));
  });
});

// =====================================================================================================
// PART 6/8 — SUMMARY-CEILING-01..03: dynamic ceiling propagation into the repair prompt
// =====================================================================================================

describe("Phase 8.2: dynamic summary ceiling propagation", () => {
  it("SUMMARY-CEILING-01: WF52-scale significant-supported count (15) produces repair ceiling 6", () => {
    assert.equal(dynamicSummaryTechnologyCeiling(15), 6);
    const prompt = buildRepairPrompt(ECO_AWS, 15);
    assert.match(prompt, /Named-technology ceiling — a CEILING, never a target: 6\./);
    assert.doesNotMatch(prompt, /never a target: 7\./);
  });

  it("SUMMARY-CEILING-02: lower dynamic tier is preserved (4 supported -> ceiling 2; 8 supported -> ceiling 4)", () => {
    assert.match(buildRepairPrompt(ECO_AWS, 4), /never a target: 2\./);
    assert.match(buildRepairPrompt(ECO_AWS, 8), /never a target: 4\./);
  });

  it("SUMMARY-CEILING-03: repair prompt and first-pass policy share the single ceiling source", () => {
    // The rendered repair ceiling for any count must equal dynamicSummaryTechnologyCeiling(count) —
    // the same exported function professionalIdentity.ts's first-pass section calls.
    for (const count of [1, 5, 6, 10, 11, 15, 23]) {
      const expected = dynamicSummaryTechnologyCeiling(count);
      const prompt = buildRepairPrompt(ECO_AWS, count);
      assert.match(prompt, new RegExp(`never a target: ${expected}\\.`));
    }
  });
});

// =====================================================================================================
// PART 8 — REPAIR-PRESERVE-01..02 and REPAIR-TOKEN-01
// =====================================================================================================

describe("Phase 8.2: repair authorization and token budget", () => {
  it("REPAIR-PRESERVE-01: adding ecosystem context does not expand authorized editable paths", () => {
    const withEco = buildRepairPrompt(ECO_AWS, 15);
    const without = buildRepairPrompt(undefined, 15);
    // Same single authorized-path block in both prompts:
    for (const prompt of [withEco, without]) {
      const pathHeaders = prompt.match(/#### Path: `[^`]+`/g) ?? [];
      assert.equal(pathHeaders.length, 1);
      assert.match(pathHeaders[0], /summary\[0\]/);
    }
  });

  it("REPAIR-PRESERVE-02: resume.summary[0] remains the only authorized path in a one-path repair", () => {
    const prompt = buildRepairPrompt(ECO_AWS, 15);
    assert.match(prompt, /#### Path: `summary\[0\]` \(full `resume\.summary\[0\]`\)/);
    assert.doesNotMatch(prompt, /#### Path: `skillGroups/);
    assert.doesNotMatch(prompt, /#### Path: `experience/);
    assert.match(prompt, /Modify ONLY the explicitly authorized JSON paths/);
  });

  it("REPAIR-TOKEN-01: realistic one-path summary repair stays within the 1,500-token budget", () => {
    // The realistic fixture includes contact details and the new ecosystem contract — the two
    // largest generic additions a real one-path summary repair carries beyond this test's baseline
    // resume. (The real WF52 repair measured 1,444 tokens pre-hardening; the ecosystem contract adds
    // ~60 estimated tokens.)
    const prompt = buildRepairWriterPrompt({
      candidateId: 1,
      candidateName: "Test Candidate",
      applicationId: 1,
      jobId: 1,
      tailoringRunId: 1,
      workflowId: 1,
      iterationNumber: 2,
      targetRoleTitle: "Senior Data Engineer",
      companyName: "Test Co",
      candidateContact: {
        name: "Test Candidate",
        email: "test@example.com",
        phone: "5550000000",
        location: "Dallas, TX",
        linkedin: "linkedin.com/in/test",
      } as never,
      repairPlan: SUMMARY_REPAIR_PLAN,
      currentResume: BASELINE_RESUME,
      currentCoverLetter: null,
      targetEcosystem: ECO_AWS,
      significantSupportedTechnologyCount: 15,
      coverLetterContextOmitted: true,
    });
    const tokens = Math.ceil(Buffer.byteLength(prompt, "utf-8") / 4);
    assert.ok(tokens <= 1500, `one-path summary repair prompt is ${tokens} estimated tokens (> 1,500)`);
  });
});

// =====================================================================================================
// PART 9 — replay the Phase 8.1 failure without a writer
// =====================================================================================================

describe("Phase 8.2: Phase 8.1 failure replay (no writer)", () => {
  const PHASE_8_1_SUMMARY = [
    "Data Engineer with 6+ years of experience building and modernizing cloud data platforms for banking, payments, and enterprise analytics teams. Recent work has centered on consolidating fragmented source systems onto a single governed Azure Data Lake through metadata-driven ingestion, then re-architecting billions-of-record batch workloads on Databricks and Delta Lake to cut nightly runtime 28%. That experience maps closely to senior data engineering work built on reliable ELT pipelines, curated consumption zones, and validation checks that keep analytical consumers on trustworthy numbers.",
  ];

  it("the exact Phase 8.1 repaired summary now FAILS review under the AWS target", () => {
    const result = evaluateSummaryAlignment(PHASE_8_1_SUMMARY, undefined, "Senior Data Engineer", ECO_AWS);
    assert.ok(
      result.styleIssuesFound.some((i) => i.includes("target ecosystem") && /azure data lake/i.test(i)),
      "the hardened reviewer must detect the Azure Data Lake drift that reached READY in Phase 8.1"
    );
  });

  it("a corrected cloud-neutral/AWS-compatible summary passes", () => {
    const corrected = [
      "Data Engineer with 6+ years of experience building and modernizing cloud data platforms for banking, payments, and enterprise analytics teams. Recent work has centered on consolidating fragmented source systems into governed lakehouse zones through metadata-driven ingestion, then re-architecting billions-of-record batch workloads on Databricks and Delta Lake to cut nightly runtime 28%. That experience maps closely to senior data engineering work built on reliable ELT pipelines, curated consumption zones, and validation checks that keep analytical consumers on trustworthy numbers.",
    ];
    const result = evaluateSummaryAlignment(corrected, undefined, "Senior Data Engineer", ECO_AWS);
    assert.ok(!result.summaryIssues.some((i) => i.includes("target ecosystem")));
  });
});

// =====================================================================================================
// PART 10 — cross-ecosystem read-only validation of allowed/disallowed affiliations
// =====================================================================================================

describe("Phase 8.2: cross-ecosystem drift matrix", () => {
  const AZURE_PHRASE = "orchestrated with Azure Data Factory";
  const AWS_PHRASE = "landed in Amazon S3";
  const GCP_PHRASE = "modeled in BigQuery";

  function driftClouds(summary: string, target: TargetEcosystemResult): Set<string> {
    return new Set(detectSummaryEcosystemDrift(summary, target).map((d) => d.cloud));
  }

  it("Azure target: AWS and GCP services are drift; Azure services are not", () => {
    assert.deepEqual(driftClouds(AZURE_PHRASE, ECO_AZURE), new Set());
    assert.deepEqual(driftClouds(AWS_PHRASE, ECO_AZURE), new Set(["AWS"]));
    assert.deepEqual(driftClouds(GCP_PHRASE, ECO_AZURE), new Set(["GCP"]));
  });

  it("AWS target: Azure and GCP services are drift; AWS services are not", () => {
    assert.deepEqual(driftClouds(AWS_PHRASE, ECO_AWS), new Set());
    assert.deepEqual(driftClouds(AZURE_PHRASE, ECO_AWS), new Set(["AZURE"]));
    assert.deepEqual(driftClouds(GCP_PHRASE, ECO_AWS), new Set(["GCP"]));
  });

  it("GCP target: Azure and AWS services are drift; GCP services are not", () => {
    assert.deepEqual(driftClouds(GCP_PHRASE, ECO_GCP), new Set());
    assert.deepEqual(driftClouds(AZURE_PHRASE, ECO_GCP), new Set(["AZURE"]));
    assert.deepEqual(driftClouds(AWS_PHRASE, ECO_GCP), new Set(["AWS"]));
  });

  it("Snowflake-centered (Azure fallback): Snowflake itself and the supporting cloud never conflict", () => {
    assert.equal(ECO_SNOWFLAKE.supportingCloud, "AZURE");
    assert.deepEqual(driftClouds("built governed Snowflake warehouses", ECO_SNOWFLAKE), new Set());
    assert.deepEqual(driftClouds(AZURE_PHRASE, ECO_SNOWFLAKE), new Set());
    assert.deepEqual(driftClouds(AWS_PHRASE, ECO_SNOWFLAKE), new Set(["AWS"]));
  });

  it("Databricks-centered (Azure fallback): Databricks itself is never classified as cloud drift", () => {
    assert.equal(ECO_DATABRICKS.supportingCloud, "AZURE");
    assert.deepEqual(driftClouds("re-architected pipelines on Databricks with Delta Lake", ECO_DATABRICKS), new Set());
    assert.deepEqual(driftClouds(GCP_PHRASE, ECO_DATABRICKS), new Set(["GCP"]));
  });

  it("TRUE_TWO_CLOUD AWS+GCP: both allowed, Azure is drift", () => {
    assert.deepEqual(driftClouds(`${AWS_PHRASE} and ${GCP_PHRASE}`, ECO_TWO_CLOUD), new Set());
    assert.deepEqual(driftClouds(AZURE_PHRASE, ECO_TWO_CLOUD), new Set(["AZURE"]));
  });

  it("ambiguous bare-English aliases never fire in prose ('the glue between teams')", () => {
    assert.deepEqual(driftClouds("served as the glue between engineering teams and iam owners of delivery", ECO_AZURE), new Set());
  });
});
