import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ResumeContent } from "../types";
import { evaluateCanonicalCoverage, type CanonicalJdRequirement } from "../jdRequirementReconciler";
import { evaluateSummaryPolicy } from "../reviewers/summaryChecks";
import { checkSummaryOpening } from "../professionalIdentity";
import { getResumeQualityWorkflow } from "@/db/queries/resumeQualityWorkflows";
import { executeResumeQualityIteration, ResumeQualityOrchestrationError } from "../orchestrator";

/**
 * PHASE 6.5C — CANONICAL COVERAGE REGRESSION INVESTIGATION + SUMMARY COMPLIANCE CLEANUP +
 * OBSERVABILITY EVIDENCE FINALIZATION.
 *
 * Root cause of the "P1 coverage regression": evaluateCanonicalCoverage previously detected evidence
 * by routing resume text through skillAliases.ts's extractCanonicalSkillsFromText, which matches
 * against SKILL_TAXONOMY (`@/lib/jobIntel/skillsTaxonomy`) — a DIFFERENT, independently-maintained
 * taxonomy built for ATS/keyword-ordering checks, not this module's own 23-item canonical set. Several
 * canonical names (Dimensional Modeling, Lakehouse Architecture, Access Control & Security, Cost &
 * Performance Optimization, Data Lineage, Warehouse Migration & Rebuild, ELT / ETL Pipeline
 * Development) have no matching entry in SKILL_TAXONOMY at all, and others differ by name (e.g.
 * SKILL_TAXONOMY's "Data Quality" vs this module's "Data Quality & Validations") — so coverage read
 * MISSING regardless of resume content. This was NEVER caused by the Phase 6.5B repair; recomputing
 * against iteration 1 (unrepaired) with the OLD evaluator reproduces the exact same false MISSINGs.
 * Fixed by matching resume text directly against each requirement's OWN TECHNICAL_TAXONOMY aliases
 * (the same shared contract checkTaxonomyEntrySupport/isCapabilityGroundedForCandidate already use)
 * instead of a foreign taxonomy.
 */

function makeReq(overrides: Partial<CanonicalJdRequirement>): CanonicalJdRequirement {
  return {
    id: "REQ-X",
    canonicalName: "X",
    kind: "TECHNOLOGY",
    rawText: "x",
    priority: "P2",
    criticality: "REQUIRED",
    source: "STRUCTURED",
    evidenceSpans: [],
    aliasesMatched: [],
    supportedByCandidate: true,
    candidateEvidenceSources: ["MSI (x)"],
    writerAction: "PASS_TO_WRITER",
    coverageExpectation: "SHOULD_SURFACE",
    ...overrides,
  };
}

function coverageResume(overrides: Partial<ResumeContent> = {}): ResumeContent {
  return {
    name: "Saikishore Reddy",
    tagline: "Data Engineer",
    location: "Dallas, TX",
    phone: "9452370560",
    email: "saireddy2898@gmail.com",
    summary: ["Data Engineer with 6+ years of experience building Snowflake-centered data platforms."],
    skillGroups: [{ label: "Data Architecture & Modeling", items: ["Data Vault"] }],
    experience: [],
    education: [],
    certifications: [],
    ...overrides,
  };
}

describe("Phase 6.5C: Coverage evaluator against representative CURRENT resume text (COVERAGE-C-01..08)", () => {
  it("COVERAGE-C-01: Dimensional Modeling real bullet => EVIDENCED", () => {
    const resume = coverageResume({
      experience: [
        {
          company: "Fiserv",
          title: "Data Engineer",
          dates: "2023-07 - 2025-01",
          bullets: ["Designed star and snowflake schema dimensional models with fact and dimension tables, surrogate key logic, and SCD processing, improving report query response time 32%."],
        },
      ],
    });
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "Dimensional Modeling", kind: "ARCHITECTURE", priority: "P1", coverageExpectation: "MUST_SURFACE" })]);
    assert.equal(result[0].status, "EVIDENCED");
  });

  it("COVERAGE-C-02: Medallion Bronze/Silver/Gold evidence => EVIDENCED", () => {
    const resume = coverageResume({
      experience: [
        {
          company: "Comerica Bank",
          title: "Data Engineer",
          dates: "2025-02 - Present",
          bullets: ["Developed PySpark and Spark SQL transformations in Azure Databricks across Delta Lake Bronze, Silver, and Gold medallion layers, cutting batch processing time 30%."],
        },
      ],
    });
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "Medallion Architecture", kind: "ARCHITECTURE", priority: "P1", coverageExpectation: "MUST_SURFACE" })]);
    assert.equal(result[0].status, "EVIDENCED");
  });

  it("COVERAGE-C-03: Lakehouse project description => EVIDENCED", () => {
    const resume = coverageResume({
      experience: [
        {
          company: "Fiserv",
          title: "Data Engineer",
          dates: "2023-07 - 2025-01",
          projectDescription: "Enterprise analytics migration program moving legacy workloads onto a cloud lakehouse built on Delta Lake and Azure Synapse Analytics.",
          bullets: ["Unrelated bullet."],
        },
      ],
    });
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "Lakehouse Architecture", kind: "ARCHITECTURE", priority: "P1", coverageExpectation: "MUST_SURFACE" })]);
    assert.equal(result[0].status, "EVIDENCED");
  });

  it("COVERAGE-C-04: Purview/governance evidence => EVIDENCED", () => {
    const resume = coverageResume({
      experience: [
        {
          company: "Comerica Bank",
          title: "Data Engineer",
          dates: "2025-02 - Present",
          bullets: ["Supported cataloging and data lineage documentation through Microsoft Purview, strengthening audit readiness with data governance practices across the platform."],
        },
      ],
    });
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "Data Governance", kind: "CAPABILITY", priority: "P1", coverageExpectation: "MUST_SURFACE" })]);
    assert.equal(result[0].status, "EVIDENCED");
  });

  it("COVERAGE-C-05: RBAC/security evidence => EVIDENCED", () => {
    const resume = coverageResume({
      experience: [
        {
          company: "Comerica Bank",
          title: "Data Engineer",
          dates: "2025-02 - Present",
          bullets: ["Configured Azure access controls spanning Azure Key Vault, RBAC, Managed Identity, and service principals to strengthen audit readiness."],
        },
      ],
    });
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "Access Control & Security", kind: "CAPABILITY", priority: "P1", coverageExpectation: "MUST_SURFACE" })]);
    assert.equal(result[0].status, "EVIDENCED");
  });

  it("COVERAGE-C-06: Snowflake tuning/cost optimization evidence => EVIDENCED", () => {
    const resume = coverageResume({
      experience: [
        {
          company: "Microgate Technologies",
          title: "Data Engineer",
          dates: "2021-06 - 2023-06",
          bullets: ["Optimized Snowflake processing time 40% through warehouse tuning, clustering, partition pruning, and query optimization, lowering compute cost on recurring analytical workloads."],
        },
      ],
    });
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "Cost & Performance Optimization", kind: "CAPABILITY", priority: "P1", coverageExpectation: "MUST_SURFACE" })]);
    assert.equal(result[0].status, "EVIDENCED");
  });

  it("COVERAGE-C-07: Data Vault Skills-only => LISTED_ONLY", () => {
    const resume = coverageResume({ skillGroups: [{ label: "Data Architecture & Modeling", items: ["Data Vault"] }] });
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "Data Vault", kind: "ARCHITECTURE", priority: "P1", coverageExpectation: "MUST_SURFACE" })]);
    assert.equal(result[0].status, "LISTED_ONLY");
  });

  it("COVERAGE-C-08: a reduced/legacy-shaped requirement list cannot silently pass as the full canonical 23-item set", () => {
    // evaluateCanonicalCoverage is a pure pass-through over whatever list it's given -- it never pads,
    // backfills, or infers the other 20 canonical requirements. Feeding it a 3-item list (mimicking a
    // stale/legacy reduced requirement set) visibly produces a 3-item result, not a complete-looking
    // 23-item one -- the caller cannot be fooled into thinking full coverage was evaluated when it
    // wasn't. deterministicReviewer.ts only ever calls this with reconcileJdRequirements()'s real
    // 23-item canonicalRequirements output (never a legacy RequirementUnit[] list) -- see
    // deterministicReviewer.ts's `canonicalRequirements ? evaluateCanonicalCoverage(...) : undefined`.
    const legacyThreeItemList = [
      makeReq({ canonicalName: "Snowflake" }),
      makeReq({ canonicalName: "Python" }),
      makeReq({ canonicalName: "SQL" }),
    ];
    const result = evaluateCanonicalCoverage(coverageResume(), legacyThreeItemList);
    assert.equal(result.length, 3, "output length must reflect exactly what was passed in, never silently expanded to 23");
  });
});

describe("Phase 6.5C: Observability evidence finalization (OBS-C-01..02)", () => {
  it("OBS-C-01: natural supported pipeline-monitoring wording satisfies Observability when the taxonomy permits it", () => {
    const resume = coverageResume({
      experience: [
        {
          company: "Fiserv",
          title: "Data Engineer",
          dates: "2023-07 - 2025-01",
          bullets: ["Implemented pipeline monitoring and alerting to surface data-quality failures before they reached downstream reporting."],
        },
      ],
    });
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "Observability", kind: "CAPABILITY", priority: "P2" })]);
    assert.equal(result[0].status, "EVIDENCED");
  });

  it("OBS-C-02: generic 'monitoring check results' wording without pipeline/observability context does not falsely satisfy Observability", () => {
    // The live Phase 6.5B repair bullet: "monitoring check results to surface failures before
    // publication" -- genuinely describes point-in-time data-quality VALIDATION (a real, already-
    // EVIDENCED, distinct capability), not ongoing pipeline/data observability (monitoring, alerting,
    // freshness, reliability). Confirms this is a wording gap, not a taxonomy-matching bug: widening
    // Observability's aliases to catch this exact generic phrase would blur it into Data Quality &
    // Validations, which is exactly the "broadened synonym matching" the investigation was told not to
    // do.
    const resume = coverageResume({
      experience: [
        {
          company: "Fiserv",
          title: "Data Engineer",
          dates: "2023-07 - 2025-01",
          bullets: ["Established data quality controls for completeness, accuracy, uniqueness, and referential integrity, monitoring check results to surface failures before publication and cutting downstream reporting errors 20%."],
        },
      ],
    });
    const dataQuality = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "Data Quality & Validations", kind: "CAPABILITY", priority: "P2" })]);
    const observability = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "Observability", kind: "CAPABILITY", priority: "P2" })]);
    assert.equal(dataQuality[0].status, "EVIDENCED", "the bullet genuinely does evidence data-quality validation");
    assert.equal(observability[0].status, "MISSING", "but must not be credited as Observability evidence too");
  });
});

describe("Phase 6.5C: Summary policy validation (SUMMARY-C-01..07)", () => {
  const skillGroups = [{ label: "Cloud Data Platforms", items: ["Snowflake", "Azure Data Factory", "Databricks", "Python", "SQL"] }];

  it("SUMMARY-C-01: a natural summary with 2-4 technologies passes for an 11+ requirement JD", () => {
    const result = evaluateSummaryPolicy({
      summary: [
        "Data Engineer with 6+ years of experience building Snowflake-centered data platforms for banking and payments.",
        "Delivers governed ingestion, dimensional modeling, and reliability controls at scale using Azure Data Factory and Databricks.",
        "Brings that platform-modernization depth to this role's Snowflake priorities.",
      ],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 15,
      targetRoleTitle: "Senior Data Engineer",
    });
    assert.equal(result.technologyBudget.pass, true);
    assert.ok(result.technologyBudget.namedCount >= 2 && result.technologyBudget.namedCount <= 4);
    assert.equal(result.recruiterNaturalness.pass, true);
  });

  it("SUMMARY-C-02: a 6-technology summary can pass if natural, but 6 is not preferred (still within the ceiling)", () => {
    const result = evaluateSummaryPolicy({
      summary: [
        "Data Engineer with 6+ years of experience building governed Snowflake and Azure Data Factory data platforms across banking and payments.",
        "Delivers Databricks processing, Python and SQL transformations, and dbt-modeled marts at scale with strong data quality controls.",
        "Focused on Snowflake-centered platform modernization for this role.",
      ],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(result.technologyBudget.ceiling, 6);
    assert.equal(result.technologyBudget.namedCount, 6);
    assert.equal(result.technologyBudget.pass, true, "at the ceiling still passes -- the ceiling is not a hard-fail threshold below itself");
  });

  it("SUMMARY-C-03: a stack-list final sentence fails", () => {
    const result = evaluateSummaryPolicy({
      summary: [
        "Data Engineer with 6+ years of experience building governed cloud data platforms for banking and payments.",
        "Platform ownership spans medallion lakehouse design and dimensional modeling at scale.",
        "That work has cut batch runtimes 30% through tuning and optimization.",
        "Delivery runs on Azure Data Factory, Databricks, and Snowflake with Python, released through tested CI/CD pipelines.",
      ],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(result.keywordInventoryRisk.pass, false);
    assert.equal(result.recruiterNaturalness.pass, false);
  });

  it("SUMMARY-C-04: a summary with no dedicated technology-list sentence passes", () => {
    const result = evaluateSummaryPolicy({
      summary: [
        "Data Engineer with 6+ years of experience modernizing enterprise data platforms for banking and payments.",
        "Owns Snowflake-centered ingestion, dimensional modeling, and reliability controls at billions-of-records scale.",
        "Brings that depth directly to this role's platform priorities.",
      ],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(result.keywordInventoryRisk.pass, true);
    assert.equal(result.recruiterNaturalness.pass, true);
  });

  it("SUMMARY-C-05: skills duplication is based on substantial inventory overlap, not one or two necessary technology mentions", () => {
    // Naming Snowflake once (also in Skills) is normal, honest overlap -- not "the summary functions
    // as a second Skills list". Only heavy (>=3 overlapping AND >=70% of named techs) duplication fails.
    const oneNecessaryMention = evaluateSummaryPolicy({
      summary: ["Data Engineer with 6+ years of experience building Snowflake-centered data platforms for banking and payments, with strong data quality and access controls."],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(oneNecessaryMention.skillsDuplication.pass, true);

    const heavyDuplication = evaluateSummaryPolicy({
      summary: ["Data Engineer with 6+ years of experience across Snowflake, Azure Data Factory, Databricks, Python, and SQL."],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(heavyDuplication.skillsDuplication.pass, false);
  });

  it("SUMMARY-C-06: 'Data Engineer with six years...' remains valid (identityOpening)", () => {
    const result = evaluateSummaryPolicy({
      summary: ["Data Engineer with six years building governed cloud data platforms for banking and payments."],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(result.identityOpening.pass, true);
    // The writer-facing carve-out (professionalIdentity.ts's checkSummaryOpening) must accept the same
    // wording when the figure is verified -- the Phase 6.5B live finding this fix addressed.
    assert.deepEqual(checkSummaryOpening("Data Engineer with six years building governed cloud data platforms.", 6), []);
  });

  it("SUMMARY-C-07: 'Data Engineer with 6+ years...' remains valid (identityOpening)", () => {
    const result = evaluateSummaryPolicy({
      summary: ["Data Engineer with 6+ years of experience building governed cloud data platforms for banking and payments."],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(result.identityOpening.pass, true);
    assert.deepEqual(checkSummaryOpening("Data Engineer with 6+ years of experience building governed cloud data platforms.", 6), []);
  });
});

describe("Phase 6.5C: workflow terminal state is never silently reset (TERMINAL-C-01)", () => {
  it("TERMINAL-C-01: a real terminal FAILED workflow refuses another iteration instead of being reset", () => {
    const wf = getResumeQualityWorkflow(1, 33);
    assert.ok(wf, "workflow 33 must exist");
    assert.equal(wf!.status, "FAILED", "precondition: workflow 33 is the real terminal FAILED workflow from Phase 6.5B");

    // executeResumeQualityIteration's terminal guard runs BEFORE any read/write of iteration content --
    // candidate lookup, then workflow lookup, then this check -- so calling it here is read-only and
    // makes no state change whatsoever; it only proves the guard fires for this exact real row.
    assert.rejects(
      () =>
        executeResumeQualityIteration({
          candidateId: 1,
          workflowId: 33,
          resume: { name: "x", tagline: "x", location: "x", phone: "x", email: "x@x.com", summary: [], skillGroups: [], experience: [], education: [], certifications: [] },
        }),
      (err: unknown) => err instanceof ResumeQualityOrchestrationError && err.code === "WORKFLOW_ALREADY_TERMINAL"
    );
  });
});
