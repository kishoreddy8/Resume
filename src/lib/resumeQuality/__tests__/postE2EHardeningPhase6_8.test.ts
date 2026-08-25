import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CandidateProfile } from "@/lib/match/types";
import type { ResumeContent } from "../types";
import { evaluateCanonicalCoverage, type CanonicalJdRequirement } from "../jdRequirementReconciler";
import { evaluateSummaryPolicy, detectApplicationLanguage } from "../reviewers/summaryChecks";
import { checkSummaryOpening } from "../professionalIdentity";
import { dynamicSummaryTechnologyCeiling } from "../summaryTechnologyBudget";
import { evaluatePresentationStructure, checkPresentationAttribution } from "../presentationStructure";
import { evaluateCrossEmployerRepetition } from "../reviewers/repetitionChecks";

/**
 * PHASE 6.8 — POST-E2E RESUME QUALITY HARDENING.
 *
 * Small hardening phase after the successful Phase 6.7 E2E benchmark: summary application-language
 * (cover-letter voice) detection, project-description business-context strengthening, and
 * cross-employer/same-employer semantic bullet repetition reporting. See the Phase 6.8 final report
 * for the full narrative; this file holds the required regression coverage for all of it, plus proof
 * that the Phase 6.5/6.5C summary policy, canonical coverage architecture-coherence behavior, and
 * years-of-experience safety are all unchanged.
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

function role(overrides: Partial<ResumeContent["experience"][number]>): ResumeContent["experience"][number] {
  return {
    title: "Data Engineer",
    company: "Comerica Bank",
    dates: "Feb 2025 – Present",
    bullets: [],
    ...overrides,
  };
}

// =====================================================================================================
// PART 4 — SUMMARY-APPLICATION-LANGUAGE-01..04
// =====================================================================================================

describe("Phase 6.8: summary application-language / cover-letter voice detection", () => {
  it("SUMMARY-APPLICATION-LANGUAGE-01: 'this role' wording is detected and reviewed", () => {
    const text =
      "That experience lines up closely with this role's emphasis on Snowflake warehouse design and disciplined data quality.";
    const matches = detectApplicationLanguage(text);
    assert.ok(matches.length > 0, "expected 'this role' phrasing to be detected");
    const result = evaluateSummaryPolicy({ summary: [text], resumeSkillGroups: [] });
    assert.equal(result.applicationLanguage.pass, false);
  });

  it("SUMMARY-APPLICATION-LANGUAGE-02: 'this position' wording is detected and reviewed", () => {
    const text = "Strong match for this position given the candidate's Snowflake and Delta Lake background.";
    const matches = detectApplicationLanguage(text);
    assert.ok(matches.length > 0, "expected 'this position' phrasing to be detected");
    const result = evaluateSummaryPolicy({ summary: [text], resumeSkillGroups: [] });
    assert.equal(result.applicationLanguage.pass, false);
  });

  it("SUMMARY-APPLICATION-LANGUAGE-03: normal target-aligned prose passes", () => {
    const good1 =
      "Data Engineer with 6+ years of experience modernizing enterprise data platforms across banking, payments, and analytics.";
    const good2 =
      "Experienced in building governed Snowflake data platforms with dimensional modeling, automated ingestion, and data-quality controls.";
    assert.deepEqual(detectApplicationLanguage(good1), []);
    assert.deepEqual(detectApplicationLanguage(good2), []);
    const result = evaluateSummaryPolicy({ summary: [good1, good2], resumeSkillGroups: [] });
    assert.equal(result.applicationLanguage.pass, true);
  });

  it("SUMMARY-APPLICATION-LANGUAGE-04: company/domain terminology alone does not trigger", () => {
    const text =
      "Data Engineer with 6+ years of experience modernizing data platforms for Celigo-style SaaS integration and banking clients, using this platform's own medallion architecture.";
    // "Celigo", "banking", "SaaS", and "this platform" (an engineering noun, not "this role/position/
    // opportunity/job") must never trigger the check on their own.
    assert.deepEqual(detectApplicationLanguage(text), []);
  });
});

// =====================================================================================================
// PART 5 — SUMMARY-IDENTITY-01, SUMMARY-TECH-BUDGET-01 (preserve Phase 6.5/6.5C policy)
// =====================================================================================================

describe("Phase 6.8: Phase 6.5/6.5C summary policy is unchanged", () => {
  it("SUMMARY-IDENTITY-01: 'Data Engineer with 6+ years...' remains valid when authorized", () => {
    const text =
      "Data Engineer with 6+ years of experience modernizing enterprise data platforms for banking, payments, and analytics teams.";
    const issues = checkSummaryOpening(text, 6);
    assert.deepEqual(issues, []);
  });

  it("SUMMARY-TECH-BUDGET-01: dynamic technology ceiling is unchanged (a ceiling, not a target)", () => {
    assert.equal(dynamicSummaryTechnologyCeiling(0), 2);
    assert.equal(dynamicSummaryTechnologyCeiling(5), 2);
    assert.equal(dynamicSummaryTechnologyCeiling(10), 4);
    // 23 significant supported requirements — the real Phase 6.7 Celigo benchmark's own count.
    assert.equal(dynamicSummaryTechnologyCeiling(23), 6);
  });
});

// =====================================================================================================
// PART 6 — PROJECT-DESCRIPTION-01, PROJECT-DESCRIPTION-02
// =====================================================================================================

describe("Phase 6.8: project-description business-context vs architecture-chain restating", () => {
  it("PROJECT-DESCRIPTION-01: business/project-context description passes", () => {
    const good =
      "Enterprise banking data-platform modernization supporting governed operational and analytical reporting across core banking domains. Work covered ingestion, historical processing, curated data products, and analyst-facing reporting.";
    const resume = coverageResume({
      experience: [
        role({
          projectDescription: good,
          bullets: [
            "Built ingestion pipelines moving core banking data into a governed medallion architecture for analyst-facing reporting.",
          ],
        }),
      ],
    });
    const issues = evaluatePresentationStructure(resume);
    const projectIssues = issues.filter((i) => i.kind.startsWith("PROJECT_DESCRIPTION"));
    assert.deepEqual(projectIssues, []);
  });

  it("PROJECT-DESCRIPTION-02: obvious architecture-chain duplication is detected and reported", () => {
    const bad =
      "Built ADF pipelines into ADLS, processed with Databricks and Delta Lake, then loaded Snowflake for enterprise reporting.";
    const resume = coverageResume({
      experience: [
        role({
          projectDescription: bad,
          bullets: [
            "Built Azure Data Factory pipelines into ADLS, processed with Databricks and Delta Lake, then loaded Snowflake for enterprise reporting.",
          ],
        }),
      ],
    });
    const issues = evaluatePresentationStructure(resume);
    const chainFinding = issues.find((i) => i.kind === "PROJECT_DESCRIPTION_ARCHITECTURE_CHAIN");
    assert.ok(chainFinding, "expected a PROJECT_DESCRIPTION_ARCHITECTURE_CHAIN finding");
    assert.equal(chainFinding?.severity, "LOW", "architecture-chain finding must be advisory, never blocking");
  });
});

// =====================================================================================================
// PART 7 — REPETITION-01..04
// =====================================================================================================

describe("Phase 6.8: cross-employer / same-employer semantic bullet repetition", () => {
  it("REPETITION-01: same technologies, different responsibilities is not an automatic duplicate", () => {
    const resume = coverageResume({
      experience: [
        role({
          company: "Comerica Bank",
          bullets: [
            "Built Azure Data Factory pipelines moving SQL Server data into ADLS Gen2 for downstream Snowflake consumption.",
          ],
        }),
        role({
          company: "Fiserv",
          bullets: [
            "Implemented data quality validation and reconciliation checks across Snowflake and Azure Data Factory data flows to ensure downstream reporting accuracy.",
          ],
        }),
      ],
    });
    const result = evaluateCrossEmployerRepetition(resume);
    assert.equal(result.status, "PASS");
    assert.deepEqual(result.findings, []);
  });

  it("REPETITION-02: near-identical responsibility/architecture/purpose across employers is reported", () => {
    const resume = coverageResume({
      experience: [
        role({
          company: "Comerica Bank",
          bullets: ["Built Azure Data Factory pipelines moving SQL Server data into ADLS Gen2 for enterprise reporting."],
        }),
        role({
          company: "Fiserv",
          bullets: ["Developed Azure Data Factory pipelines moving SQL Server data into ADLS Gen2 for enterprise reporting."],
        }),
        role({
          company: "Microgate Technologies",
          bullets: ["Created Azure Data Factory pipelines moving SQL Server data into ADLS Gen2 for enterprise reporting."],
        }),
      ],
    });
    const result = evaluateCrossEmployerRepetition(resume);
    assert.equal(result.status, "REVIEW");
    assert.ok(result.findings.length >= 3, "expected a finding for each of the three cross-employer pairs");
    assert.ok(result.findings.every((f) => f.scope === "CROSS_EMPLOYER"));
  });

  it("REPETITION-03: different employers may truthfully share one technology without failure", () => {
    const resume = coverageResume({
      experience: [
        role({
          company: "Comerica Bank",
          bullets: ["Modeled Snowflake dimensional schemas supporting analyst-facing reporting for core banking domains."],
        }),
        role({
          company: "Fiserv",
          bullets: ["Tuned Snowflake warehouse performance and clustering keys for finance operational reporting."],
        }),
        role({
          company: "Microgate Technologies",
          bullets: ["Automated CI/CD release pipelines for Snowflake schema changes using Git and pytest."],
        }),
      ],
    });
    const result = evaluateCrossEmployerRepetition(resume);
    assert.equal(result.status, "PASS");
    assert.deepEqual(result.findings, []);
  });

  it("REPETITION-04: verb substitution alone does not hide a semantic duplicate", () => {
    const resume = coverageResume({
      experience: [
        role({
          company: "Comerica Bank",
          bullets: ["Built Azure Data Factory pipelines moving SQL Server data into ADLS Gen2 for downstream consumption."],
        }),
        role({
          company: "Fiserv",
          bullets: ["Engineered Azure Data Factory pipelines moving SQL Server data into ADLS Gen2 for downstream consumption."],
        }),
      ],
    });
    const result = evaluateCrossEmployerRepetition(resume);
    assert.equal(result.status, "REVIEW");
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].scope, "CROSS_EMPLOYER");
  });
});

// =====================================================================================================
// PART 8 — COVERAGE-01..03 (canonical coverage — do not keyword-stuff)
// =====================================================================================================

describe("Phase 6.8: canonical coverage preserves EVIDENCED/LISTED_ONLY/SUBSTITUTED/MISSING", () => {
  it("COVERAGE-01: Data Vault Skills-only remains LISTED_ONLY, never force-promoted", () => {
    const resume = coverageResume({ skillGroups: [{ label: "Data Architecture & Modeling", items: ["Data Vault"] }] });
    const result = evaluateCanonicalCoverage(resume, [
      makeReq({ canonicalName: "Data Vault", kind: "ARCHITECTURE", priority: "P1", coverageExpectation: "MUST_SURFACE" }),
    ]);
    assert.equal(result[0].status, "LISTED_ONLY");
  });

  it("COVERAGE-02: SUBSTITUTED requirements (Airflow/Prefect -> ADF, GitHub Actions -> Azure DevOps) remain supported", () => {
    const resume = coverageResume({
      skillGroups: [{ label: "Orchestration & DevOps", items: ["Azure Data Factory", "Azure DevOps"] }],
    });
    const airflow = evaluateCanonicalCoverage(resume, [
      makeReq({ canonicalName: "Airflow", kind: "TECHNOLOGY", priority: "P2" }),
    ]);
    assert.equal(airflow[0].status, "SUBSTITUTED");
    assert.equal(airflow[0].substitutedBy, "Azure Data Factory");

    const ghActions = evaluateCanonicalCoverage(resume, [
      makeReq({ canonicalName: "GitHub Actions", kind: "TECHNOLOGY", priority: "P2" }),
    ]);
    assert.equal(ghActions[0].status, "SUBSTITUTED");
    assert.equal(ghActions[0].substitutedBy, "Azure DevOps");
  });

  it("COVERAGE-03: MISSING P2 requirements (e.g. Fivetran) do not carry any blocking signal", () => {
    const resume = coverageResume({ skillGroups: [] });
    const result = evaluateCanonicalCoverage(resume, [
      makeReq({ canonicalName: "Fivetran", kind: "TECHNOLOGY", priority: "P2", coverageExpectation: "SHOULD_SURFACE" }),
    ]);
    assert.equal(result[0].status, "MISSING");
    // CanonicalCoverageEntry carries no blocking/severity field at all — MISSING is reporting-only by
    // construction, never something a downstream caller can misread as a hard gate.
    assert.deepEqual(Object.keys(result[0]).sort(), ["coverageExpectation", "kind", "priority", "requirement", "status"]);
  });
});

// =====================================================================================================
// PART 9 — TRUTH-01, YEARS-01, YEARS-02
// =====================================================================================================

describe("Phase 6.8: truthfulness and years-of-experience safety are unchanged", () => {
  it("TRUTH-01: an unsupported technology on an Environment line remains rejected", () => {
    const master: CandidateProfile = {
      schemaVersion: 1,
      sourceHashes: { resume: "h1", skills: "h2" },
      builtAt: "2026-08-24T00:00:00Z",
      totalYearsExperience: 6,
      skills: [{ rawSkillName: "Snowflake", source: "employer" }],
      experience: [
        {
          employer: "Comerica Bank",
          title: "Data Engineer",
          startDate: "2025-02",
          endDate: null,
          technologies: ["Snowflake"],
        },
      ],
      education: [],
      certifications: [],
    } as unknown as CandidateProfile;

    const resume = coverageResume({
      experience: [
        role({
          company: "Comerica Bank",
          bullets: ["Built Snowflake data models for enterprise reporting."],
          environment: ["Snowflake", "Google BigQuery"],
        }),
      ],
    });

    const issues = checkPresentationAttribution(resume, master);
    const bigQueryIssue = issues.find((i) => i.offending === "Google BigQuery");
    assert.ok(bigQueryIssue, "expected the unsupported 'Google BigQuery' Environment entry to be rejected");
  });

  it("YEARS-01: an unauthorized years claim (no verified total) fails", () => {
    const text = "Data Engineer with close to five years of experience in enterprise data platforms.";
    const issues = checkSummaryOpening(text, null);
    assert.ok(
      issues.some((i) => i.kind === "UNVERIFIED_YEARS"),
      "expected an UNVERIFIED_YEARS finding when CareerOps has no verified total"
    );
  });

  it("YEARS-02: an authorized years claim (verified total present) passes", () => {
    const text = "Data Engineer with 6+ years of experience in enterprise data platforms.";
    const issues = checkSummaryOpening(text, 6);
    assert.deepEqual(issues, []);
  });
});
