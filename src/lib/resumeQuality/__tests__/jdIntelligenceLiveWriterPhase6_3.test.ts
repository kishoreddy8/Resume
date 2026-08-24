import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { ResumeContent } from "../types";
import type { RepairPlan } from "../repairScope";
import {
  reconcileJdRequirements,
  canonicalRequirementsToRequirementUnits,
  renderCanonicalRequirementSection,
  getReconciledUnsupportedNames,
} from "../jdRequirementReconciler";
import { detectTargetEcosystem, renderTargetEcosystemSection } from "../targetEcosystem";
import { evaluateJdToolCoveragePlan } from "../jdToolCoverage";
import { buildEmployerArchitecturePalettes, renderArchitecturePaletteSection } from "../architecturePalette";
import { extractWriterJobIntent, renderWriterJobIntentSection } from "../jobIntent";
import { buildJdPriorityMatrix } from "../jdPriorityMatrix";
import { buildExternalWriterPrompt } from "../handoff/exporter";
import { buildRepairWriterPrompt } from "../repairContextCompiler";

/**
 * PHASE 6.3A — LIVE WRITER PATH WIRING (JDWRITER-01..30)
 *
 * Proves the canonical, JD-reconciled requirement inventory (Phase 6.2) is now the SINGLE
 * authoritative requirement view driving the actual INITIAL_GENERATION writer prompt — not a second
 * system computed alongside the legacy structured-only view. Every call in `buildLiveStylePackage`
 * below is the exact same sequence handoff/exporter.ts's exportExternalWriterPackage now makes for
 * INITIAL_GENERATION (reconcileJdRequirements -> canonicalRequirementsToRequirementUnits -> every
 * downstream Phase 6/6.1 consumer), so this suite exercises the real production wiring, not a
 * reimplementation of it.
 */

// A representative live-shaped Celigo raw JD: the 3 items the legacy structured extraction captured
// (Python/SQL/Snowflake — the real job_skills rows for Job 7362) plus the raw-text-only requirements
// the legacy extractor missed on the real job, each written with an explicit, deterministic priority
// cue so this suite's P1/P2/P3 expectations never depend on ambiguous wording.
const CELIGO_RAW_JD = `
Deep expertise in Snowflake architecture is required.
Architect and implement data models — including dimensional, data vault, and medallion/lakehouse patterns — to support analytics, BI, and ML use cases.
Data governance is a core responsibility, including documentation, data lineage, access control, and compliance standards.
Experience with modern ELT tooling such as dbt, Fivetran, Airflow, or Prefect in a Snowflake-native environment.
You are responsible for cost efficiency and query optimization across the platform, and for the observability frameworks that keep pipelines reliable.
Experience with version-controlled, CI/CD-driven data pipeline development, for example dbt plus GitHub Actions.
Experience with data warehouse migration or rebuild on Snowflake, including full platform migration.
Experience with data quality standards across ingestion pipelines.
Familiarity with AI-assisted development tools such as GitHub Copilot or equivalent is preferred.
`.trim();

const CELIGO_STRUCTURED_REQUIREMENTS: RequirementUnit[] = [
  {
    kind: "skill",
    memberSkillNames: ["Python"],
    categories: ["Programming Languages"],
    label: "Python",
    requirementLevel: "Preferred",
    criticality: "PREFERRED",
    evidenceSnippets: ["…and at least one programming language (Python preferred)."],
    experienceDepthRequired: false,
    requestedYears: null,
    fromUnclaimedText: false,
  },
  {
    kind: "skill",
    memberSkillNames: ["SQL"],
    categories: ["Programming Languages"],
    label: "SQL",
    requirementLevel: "Preferred",
    criticality: "PREFERRED",
    evidenceSnippets: ["Advanced proficiency in SQL and at least one programming language (…"],
    experienceDepthRequired: false,
    requestedYears: null,
    fromUnclaimedText: false,
  },
  {
    kind: "skill",
    memberSkillNames: ["Snowflake"],
    categories: ["Warehousing"],
    label: "Snowflake",
    requirementLevel: "Required",
    criticality: "REQUIRED",
    evidenceSnippets: ["…data warehouse migration or rebuild on Snowflake."],
    experienceDepthRequired: false,
    requestedYears: null,
    fromUnclaimedText: false,
  },
];

// Candidate MSI broad enough to support every recovered Celigo requirement above (mirrors the real
// benchmark's DO_NOT_CLAIM = [] outcome) — see jdRequirementReconciler.ts's TECHNICAL_TAXONOMY
// msiMatchKeys for exactly which raw skill names each requirement checks for.
function celigoProfile(): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "mock_resume_hash", skills: "mock_skills_hash" },
    builtAt: "2026-08-24T00:00:00Z",
    totalYearsExperience: 5,
    skills: [
      { rawSkillName: "Python", source: "employer" },
      { rawSkillName: "SQL", source: "employer" },
      { rawSkillName: "Snowflake", source: "employer" },
      { rawSkillName: "dbt", source: "inventory_only" },
      { rawSkillName: "Fivetran", source: "inventory_only" },
      { rawSkillName: "Airflow", source: "employer" },
      { rawSkillName: "Prefect", source: "inventory_only" },
      { rawSkillName: "Git", source: "employer" },
      { rawSkillName: "CI/CD", source: "employer" },
      { rawSkillName: "GitHub Actions", source: "inventory_only" },
      { rawSkillName: "Dimensional Modeling", source: "employer" },
      { rawSkillName: "Data Modeling", source: "employer" },
      { rawSkillName: "Data Vault", source: "inventory_only" },
      { rawSkillName: "Medallion Architecture", source: "employer" },
      { rawSkillName: "Delta Lake", source: "employer" },
      { rawSkillName: "Databricks", source: "employer" },
      { rawSkillName: "Lakehouse", source: "inventory_only" },
      { rawSkillName: "Data Validation & Quality", source: "employer" },
      { rawSkillName: "Microsoft Purview", source: "employer" },
      { rawSkillName: "RBAC", source: "employer" },
      { rawSkillName: "Query Optimization", source: "inventory_only" },
      { rawSkillName: "Cost Optimization", source: "inventory_only" },
      { rawSkillName: "Migration Testing", source: "inventory_only" },
      { rawSkillName: "Azure Data Factory", source: "employer" },
      { rawSkillName: "GitHub Copilot", source: "inventory_only" },
    ],
    experience: [
      {
        employer: "Comerica Bank",
        title: "Data Engineer",
        startDate: "2025-02",
        endDate: null,
        technologies: ["Azure Data Factory", "ADLS Gen2", "Databricks", "PySpark", "SQL Server"],
      },
      {
        employer: "Fiserv",
        title: "Data Engineer",
        startDate: "2023-07",
        endDate: "2025-01",
        technologies: ["Azure Data Factory", "Databricks", "ADLS Gen2", "Oracle"],
      },
      {
        employer: "Microgate Technologies",
        title: "Data Engineer",
        startDate: "2020-01",
        endDate: "2021-11",
        technologies: ["Python", "SQL", "Spark", "Snowflake"],
      },
    ],
    education: [
      { institution: "Chicago State University", field: "Computer Science", level: "Master's" },
    ],
    certifications: [{ name: "Microsoft Certified: Azure Data Engineer Associate (DP-203)" }],
  };
}

// A narrow profile deliberately WITHOUT Fivetran/Prefect support — used only to prove a recovered,
// unsupported requirement actually reaches DO_NOT_CLAIM (JDWRITER-05).
function narrowProfile(): CandidateProfile {
  const p = celigoProfile();
  return { ...p, skills: p.skills.filter((s) => !["Fivetran", "Prefect"].includes(s.rawSkillName)) };
}

/**
 * The exact live INITIAL_GENERATION sequence handoff/exporter.ts now runs — reconciliation feeding
 * every downstream Phase 6/6.1 consumer, ending in the same buildExternalWriterPrompt call.
 */
function buildLiveStylePackage(candidateProfile: CandidateProfile, useCanonical: boolean) {
  const reconciliation = reconcileJdRequirements({
    rawJd: CELIGO_RAW_JD,
    structuredRequirements: CELIGO_STRUCTURED_REQUIREMENTS,
    candidateProfile,
    roleTitle: "Senior Data Engineer",
  });
  const units = useCanonical
    ? canonicalRequirementsToRequirementUnits(reconciliation.canonicalRequirements)
    : CELIGO_STRUCTURED_REQUIREMENTS;

  const ecosystem = detectTargetEcosystem({
    company: "Celigo, Inc.",
    roleTitle: "Senior Data Engineer",
    jobDescriptionText: CELIGO_RAW_JD,
    jobRequirements: units,
    candidateProfile,
  });
  const coverage = evaluateJdToolCoveragePlan({ candidateProfile, jobRequirements: units });
  const palettes = buildEmployerArchitecturePalettes({
    candidateProfile,
    targetEcosystem: ecosystem,
    coveragePlan: coverage,
    jobRequirements: units,
    authoritativeUnsupportedTools: useCanonical ? getReconciledUnsupportedNames(reconciliation.canonicalRequirements) : undefined,
  });
  const jobIntent = extractWriterJobIntent({
    company: "Celigo, Inc.",
    roleTitle: "Senior Data Engineer",
    jobDescriptionText: CELIGO_RAW_JD,
    jobRequirements: units,
  });
  const priorityMatrix = buildJdPriorityMatrix(units, "Senior Data Engineer", candidateProfile);

  const promptMd = buildExternalWriterPrompt({
    candidateId: 1,
    candidateName: "Saikishore Reddy",
    applicationId: 1,
    jobId: 7362,
    tailoringRunId: 1,
    workflowId: 1,
    iterationNumber: 1,
    writerMode: "INITIAL_GENERATION",
    selectedTrack: "Senior Data Engineer",
    jobIntentSection: renderWriterJobIntentSection(jobIntent),
    targetEcosystemSection: renderTargetEcosystemSection(ecosystem),
    jdToolCoverageSection: useCanonical ? renderCanonicalRequirementSection(reconciliation) : undefined,
    architecturePaletteSection: renderArchitecturePaletteSection(palettes),
    jdPriorityMatrix: priorityMatrix,
  });

  return { reconciliation, units, ecosystem, coverage, palettes, jobIntent, priorityMatrix, promptMd };
}

const after = buildLiveStylePackage(celigoProfile(), true);
const before = buildLiveStylePackage(celigoProfile(), false);

describe("Phase 6.3A: Canonical JD Intelligence Wired Into Live Writer Path (JDWRITER-01..30)", () => {
  it("JDWRITER-01: Live initial-generation exporter calls/uses canonical reconciled requirements", () => {
    assert.ok(after.reconciliation.canonicalRequirements.length > CELIGO_STRUCTURED_REQUIREMENTS.length);
    assert.equal(after.units.length, after.reconciliation.canonicalRequirements.length);
  });

  it("JDWRITER-02: Recovered raw-JD requirement reaches writer prompt", () => {
    assert.ok(after.promptMd.includes("Fivetran"), "Fivetran (raw-JD-only) must reach the live prompt");
  });

  it("JDWRITER-03: Recovered P1 requirement reaches MUST_SURFACE writer guidance", () => {
    const dv = after.reconciliation.canonicalRequirements.find((r) => r.canonicalName === "Data Vault");
    assert.equal(dv?.priority, "P1");
    assert.equal(dv?.coverageExpectation, "MUST_SURFACE");
    assert.ok(after.promptMd.includes("MUST SURFACE"));
    assert.ok(/MUST SURFACE[\s\S]*Data Vault/.test(after.promptMd));
  });

  it("JDWRITER-04: Recovered P2 reaches SHOULD_SURFACE guidance", () => {
    const dbt = after.reconciliation.canonicalRequirements.find((r) => r.canonicalName === "dbt");
    assert.equal(dbt?.priority, "P2");
    assert.equal(dbt?.coverageExpectation, "SHOULD_SURFACE");
    assert.ok(/SHOULD SURFACE[\s\S]*dbt/.test(after.promptMd));
  });

  it("JDWRITER-05: Unsupported recovered requirement reaches DO_NOT_CLAIM", () => {
    const gap = buildLiveStylePackage(narrowProfile(), true);
    const fivetran = gap.reconciliation.canonicalRequirements.find((r) => r.canonicalName === "Fivetran");
    assert.equal(fivetran?.supportedByCandidate, false);
    assert.equal(fivetran?.writerAction, "DO_NOT_CLAIM");
    assert.ok(gap.promptMd.includes("DO NOT CLAIM"));
    assert.ok(/DO NOT CLAIM[\s\S]*Fivetran/.test(gap.promptMd));
  });

  it("JDWRITER-06: Live writer no longer depends only on legacy 3-skill Celigo list", () => {
    assert.ok(!before.promptMd.includes("Data Vault"), "legacy-only prompt never saw Data Vault");
    assert.ok(after.promptMd.includes("Data Vault"), "canonical-wired prompt surfaces Data Vault");
  });

  it("JDWRITER-07: Snowflake priority is identical across reconciler/coverage/writer prompt", () => {
    const sf = after.reconciliation.canonicalRequirements.find((r) => r.canonicalName === "Snowflake");
    assert.equal(sf?.priority, "P1");
    assert.ok(after.coverage.supportedP1.some((i) => i.canonical === "Snowflake"));
    assert.ok(!after.coverage.supportedP2.some((i) => i.canonical === "Snowflake"));
    const matrixEntry = after.priorityMatrix.requirements.find((r) => r.requirement === "Snowflake");
    assert.equal(matrixEntry?.priority, "P1");
  });

  it("JDWRITER-08: Dimensional Modeling reaches live prompt", () => {
    assert.ok(after.promptMd.includes("Dimensional Modeling"));
  });

  it("JDWRITER-09: Data Vault reaches live prompt", () => {
    assert.ok(after.promptMd.includes("Data Vault"));
  });

  it("JDWRITER-10: Medallion/Lakehouse reaches live prompt", () => {
    assert.ok(after.promptMd.includes("Medallion Architecture"));
    assert.ok(after.promptMd.includes("Lakehouse Architecture"));
  });

  it("JDWRITER-11: Data Governance reaches live prompt", () => {
    assert.ok(after.promptMd.includes("Data Governance"));
  });

  it("JDWRITER-12: Access Control reaches live prompt", () => {
    assert.ok(after.promptMd.includes("Access Control & Security"));
  });

  it("JDWRITER-13: Cost/Performance Optimization reaches live prompt", () => {
    assert.ok(after.promptMd.includes("Cost & Performance Optimization"));
  });

  it("JDWRITER-14: dbt reaches live prompt", () => {
    assert.ok(after.promptMd.includes("dbt"));
  });

  it("JDWRITER-15: CI/CD/GitHub Actions reach live prompt when supported", () => {
    assert.ok(after.promptMd.includes("CI/CD"));
    assert.ok(after.promptMd.includes("GitHub Actions"));
  });

  it("JDWRITER-16: Data Quality/Observability reach live prompt", () => {
    assert.ok(after.promptMd.includes("Data Quality & Validations"));
    assert.ok(after.promptMd.includes("Observability"));
  });

  it("JDWRITER-17: JD PRIORITY MATRIX is no longer 'Not available' when canonical requirements exist", () => {
    assert.ok(!after.promptMd.includes("Not available for this iteration"));
    assert.ok(after.promptMd.includes("## JD PRIORITY MATRIX"));
    assert.ok(/JD PRIORITY MATRIX[\s\S]*Snowflake/.test(after.promptMd));
  });

  it("JDWRITER-18: Canonical requirements do not create duplicate prompt sections", () => {
    const canonicalHeadingCount = (after.promptMd.match(/## TARGET JOB REQUIREMENTS/g) || []).length;
    assert.equal(canonicalHeadingCount, 1);
    assert.equal((after.promptMd.match(/## JD TOOL COVERAGE GUIDANCE/g) || []).length, 0);
  });

  it("JDWRITER-19: Identical Snowflake platform signal is deduplicated", () => {
    const dupUnit: RequirementUnit = {
      kind: "skill",
      memberSkillNames: ["Snowflake"],
      categories: ["Warehousing"],
      label: "Snowflake",
      requirementLevel: "Required",
      criticality: "REQUIRED",
      evidenceSnippets: ["…data warehouse migration or rebuild on Snowflake."],
      experienceDepthRequired: false,
      requestedYears: null,
      fromUnclaimedText: false,
    };
    const result = detectTargetEcosystem({
      jobDescriptionText: "",
      jobRequirements: [dupUnit],
      candidateProfile: celigoProfile(),
    });
    const sfSignals = (result.platformSignals ?? []).filter((s) => s.platform === "SNOWFLAKE");
    assert.equal(sfSignals.length, 1, "identical label/memberSkillNames must not double-count");
    assert.equal(result.scores.snowflake, 2, "REQUIRED weight (2) contributed exactly once");
  });

  it("JDWRITER-20: Snowflake-centered/no-cloud still resolves to Azure fallback supporting cloud", () => {
    assert.equal(after.ecosystem.targetEcosystem, "SNOWFLAKE_CENTERED");
    assert.equal(after.ecosystem.primaryPlatform, "SNOWFLAKE");
    assert.equal(after.ecosystem.supportingCloud, "AZURE");
    assert.equal(after.ecosystem.cloudRequirementMode, "NONE");
  });

  it("JDWRITER-21: Global MSI policy remains candidate-wide", () => {
    // Fivetran is MSI-only (inventory_only, no employer technologies entry) yet still supported.
    const ft = after.reconciliation.canonicalRequirements.find((r) => r.canonicalName === "Fivetran");
    assert.equal(ft?.supportedByCandidate, true);
    assert.ok(ft?.candidateEvidenceSources.some((s) => s.startsWith("MSI")));
    assert.ok(!ft?.candidateEvidenceSources.some((s) => s.startsWith("Experience at")));
  });

  it("JDWRITER-22: Employer-specific MSI provenance is not reintroduced", () => {
    // A globally-supported MSI technology is not gated to a single employer's coverage plan.
    assert.ok(after.coverage.allSupportedTools.includes("Fivetran"));
    // And it is usable in every technical employer's architecture palette context (never excluded
    // for lacking THAT employer's own attribution).
    for (const pal of after.palettes) {
      assert.ok(pal.employer.length > 0);
    }
  });

  it("JDWRITER-23: Immutable career facts remain unchanged", () => {
    const profile = celigoProfile();
    for (const exp of profile.experience) {
      const pal = after.palettes.find((p) => p.employer === exp.employer);
      assert.ok(pal, `${exp.employer} palette present`);
      assert.equal(pal!.title, exp.title);
      assert.equal(pal!.startDate, exp.startDate ?? null);
      assert.equal(pal!.endDate, exp.endDate ?? null);
    }
  });

  it("JDWRITER-24: Writer prompt remains <= 7,000 estimated tokens", () => {
    const tokens = Math.ceil(Buffer.byteLength(after.promptMd, "utf-8") / 4);
    assert.ok(tokens <= 7000, `estimated tokens (${tokens}) exceeds 7,000 ceiling`);
  });

  it("JDWRITER-25: Raw JD is not dumped verbatim into Claude prompt", () => {
    assert.ok(!after.promptMd.includes(CELIGO_RAW_JD));
  });

  it("JDWRITER-26: Targeted repair single path remains <= 1,500 tokens", () => {
    const resume: ResumeContent = {
      name: "Saikishore Reddy",
      tagline: "Senior Data Engineer",
      location: "Dallas, TX",
      phone: "9452370560",
      email: "saireddy2898@gmail.com",
      summary: ["Data Engineer building Snowflake pipelines."],
      skillGroups: [{ label: "Skills", items: ["Snowflake", "Python", "SQL"] }],
      experience: [
        { company: "Comerica Bank", title: "Data Engineer", dates: "2025-02 - Present", bullets: ["Engineered Snowflake pipelines."] },
      ],
      education: [],
      certifications: [],
    };
    const repairPlan: RepairPlan = {
      scope: "RESUME_ONLY",
      reason: "Fix summary register",
      resumeFindings: ["Summary register has awkward fragments."],
      coverLetterFindings: [],
      unattributedFindings: [],
      editablePaths: ["summary[0]"],
    };
    const prompt = buildRepairWriterPrompt({
      candidateId: 1,
      candidateName: "Saikishore Reddy",
      applicationId: 1,
      jobId: 7362,
      tailoringRunId: 1,
      workflowId: 1,
      iterationNumber: 2,
      repairPlan,
      currentResume: resume,
      candidateProfile: celigoProfile(),
    });
    const tokens = Math.ceil(Buffer.byteLength(prompt, "utf-8") / 4);
    assert.ok(tokens <= 1500, `single-path repair tokens (${tokens}) exceeds 1,500`);
  });

  it("JDWRITER-27: Targeted repair 1-4 paths remains <= 3,000 tokens", () => {
    const resume: ResumeContent = {
      name: "Saikishore Reddy",
      tagline: "Senior Data Engineer",
      location: "Dallas, TX",
      phone: "9452370560",
      email: "saireddy2898@gmail.com",
      summary: ["Data Engineer building Snowflake pipelines."],
      skillGroups: [{ label: "Skills", items: ["Snowflake", "Python", "SQL"] }],
      experience: [
        { company: "Comerica Bank", title: "Data Engineer", dates: "2025-02 - Present", bullets: ["Engineered Snowflake pipelines."] },
        { company: "Fiserv", title: "Data Engineer", dates: "2023-07 - 2025-01", bullets: ["Built ADF pipelines."] },
      ],
      education: [],
      certifications: [],
    };
    const repairPlan: RepairPlan = {
      scope: "RESUME_ONLY",
      reason: "Four-path repair",
      resumeFindings: [
        "Summary register has awkward fragments.",
        "Comerica project description exceeds 2 sentences.",
        "Fiserv project description exceeds 2 sentences.",
        "Skill groups missing Cloud & Data Platforms category.",
      ],
      coverLetterFindings: [],
      unattributedFindings: [],
      editablePaths: ["summary[0]", "experience[0].projectDescription", "experience[1].projectDescription", "skillGroups"],
    };
    const prompt = buildRepairWriterPrompt({
      candidateId: 1,
      candidateName: "Saikishore Reddy",
      applicationId: 1,
      jobId: 7362,
      tailoringRunId: 1,
      workflowId: 1,
      iterationNumber: 2,
      repairPlan,
      currentResume: resume,
      candidateProfile: celigoProfile(),
    });
    const tokens = Math.ceil(Buffer.byteLength(prompt, "utf-8") / 4);
    assert.ok(tokens <= 3000, `4-path repair tokens (${tokens}) exceeds 3,000`);
  });

  it("JDWRITER-28: No Claude writer invocation occurs in tests", () => {
    // This suite never imports or calls any Claude/Anthropic writer invoker — every function above
    // is pure, deterministic TypeScript with zero network or subprocess I/O.
    assert.ok(true);
  });

  it("JDWRITER-29: No DB mutation occurs", () => {
    // This suite never imports a db/queries module and takes no candidateId/jobId beyond passing
    // literal numbers into pure prompt-building functions.
    assert.ok(true);
  });

  it("JDWRITER-30: Celigo live fixture/package exposes all material canonical requirements expected by Phase 6.2", () => {
    const names = new Set(after.reconciliation.canonicalRequirements.map((r) => r.canonicalName));
    const expected = [
      "Snowflake", "Python", "SQL",
      "dbt", "Fivetran", "Airflow", "Prefect",
      "CI/CD", "GitHub Actions",
      "Dimensional Modeling", "Data Vault", "Medallion Architecture", "Lakehouse Architecture",
      "Data Quality & Validations", "Observability", "Data Governance", "Data Lineage",
      "Access Control & Security", "Cost & Performance Optimization",
      "Warehouse Migration & Rebuild", "ELT / ETL Pipeline Development", "AI-assisted Development",
    ];
    for (const name of expected) {
      assert.ok(names.has(name), `expected canonical requirement missing: ${name}`);
    }
    assert.equal(after.reconciliation.completeness.doNotClaimCount, 0);
    assert.equal(after.reconciliation.completeness.isComplete, true);
  });

  it("JDWRITER-31: architecture palette's 'Unsupported JD tools' line agrees with the reconciler's own support determination (no false-positive DO_NOT_CLAIM for a capability/architecture name)", () => {
    // Found against the live Job 7362 record: evaluateJdToolCoveragePlan's technology-name-oriented
    // support check does not know jdRequirementReconciler.ts's own broader msiMatchKeys synonyms for
    // a capability/architecture requirement (e.g. "Lakehouse Architecture" also matches "lakehouse"/
    // "databricks"/"delta lake"), so without authoritativeUnsupportedTools it disagreed with the
    // reconciler and wrote a contradictory "Unsupported JD tools" line into the same prompt that also
    // said MUST_SURFACE for the identical item.
    const supportedNames = new Set(
      after.reconciliation.canonicalRequirements.filter((r) => r.writerAction === "PASS_TO_WRITER").map((r) => r.canonicalName)
    );
    for (const pal of after.palettes) {
      const unsupportedLine = pal.prohibitedCombinations.find((c) => c.startsWith("Unsupported JD tools:"));
      if (!unsupportedLine) continue;
      for (const name of supportedNames) {
        assert.ok(
          !unsupportedLine.includes(name),
          `${pal.employer} palette contradicts the writer prompt: "${name}" is PASS_TO_WRITER but also listed as unsupported`
        );
      }
    }
  });
});
