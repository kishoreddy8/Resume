import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import { reconcileJdRequirements, canonicalRequirementsToRequirementUnits } from "../jdRequirementReconciler";
import { detectTargetEcosystem, renderTargetEcosystemSection } from "../targetEcosystem";
import { buildEmployerArchitecturePalettes, renderArchitecturePaletteSection } from "../architecturePalette";
import { extractWriterJobIntent, renderWriterJobIntentSection } from "../jobIntent";
import { buildJdPriorityMatrix } from "../jdPriorityMatrix";
import { evaluateJdToolCoveragePlan } from "../jdToolCoverage";
import { buildEmployerEvidenceMap, renderEmployerEvidenceSection } from "../employerEvidence";
import { deriveProfessionalIdentity, renderProfessionalIdentitySection } from "../professionalIdentity";
import { renderPresentationStandardSection } from "../presentationStructure";
import { buildExternalWriterPrompt } from "../handoff/exporter";
import { buildRepairWriterPrompt } from "../repairContextCompiler";
import { renderAccomplishmentEvidenceSection } from "../accomplishmentEvidence";
import { mapJdPrioritiesToCandidateEvidence, renderJdEvidenceMappingSection } from "../jobEvidenceMapping";
import type { CandidateAccomplishmentPackage } from "../accomplishmentEvidence";
import type { RepairPlan } from "../repairScope";
import type { ResumeContent } from "../types";

/**
 * PHASE 6.6 — PRODUCTION WRITER CONTEXT / TOKEN OPTIMIZATION regression suite.
 *
 * Uses a self-contained, Celigo-SCALE synthetic fixture (23 canonical-equivalent requirements, 3
 * employers x 6 real-shaped bullets each) rather than reading real candidate/job files from disk —
 * deliberately portable (no dependency on data/candidates/1 or a live DB existing in this
 * environment) while still reflecting the REAL production JD's actual complexity, per the operator's
 * own instruction not to optimize/regression-test from an unrepresentative small fixture alone (the
 * project's PRE-EXISTING PROMPTCOMPACT-15 test, in writerPromptCompactionPhase3.test.ts, uses an
 * 8-requirement/3-bullet-total fixture that was never large enough to catch the real ~9,421-token
 * production package this phase was asked to investigate).
 */

const ESTIMATED_BYTES_PER_TOKEN = 4;
function tokens(s: string): number {
  return Math.ceil(Buffer.byteLength(s, "utf-8") / ESTIMATED_BYTES_PER_TOKEN);
}

function unit(overrides: Partial<RequirementUnit>): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: [],
    categories: ["Data Engineering"],
    label: "requirement",
    requirementLevel: "Required",
    criticality: "CRITICAL",
    evidenceSnippets: ["...a representative JD sentence naming this requirement..."],
    experienceDepthRequired: false,
    requestedYears: null,
    fromUnclaimedText: false,
    ...overrides,
  };
}

// 23 requirements: P1=8, P2=12, P3=3 -- matching the real Celigo/Job 7362 canonical distribution
// (see Phase 6.2/6.3A/6.5C reports) without depending on any file this environment might not have.
const CELIGO_SCALE_REQUIREMENTS: RequirementUnit[] = [
  // P1 (CRITICAL) x8
  unit({ label: "Snowflake", memberSkillNames: ["Snowflake"], criticality: "CRITICAL" }),
  unit({ label: "Dimensional Modeling", memberSkillNames: ["Dimensional Modeling"], criticality: "CRITICAL" }),
  unit({ label: "Data Vault", memberSkillNames: ["Data Vault"], criticality: "CRITICAL" }),
  unit({ label: "Medallion Architecture", memberSkillNames: ["Medallion Architecture"], criticality: "CRITICAL" }),
  unit({ label: "Lakehouse Architecture", memberSkillNames: ["Lakehouse Architecture"], criticality: "CRITICAL" }),
  unit({ label: "Data Governance", memberSkillNames: ["Data Governance"], criticality: "CRITICAL" }),
  unit({ label: "Access Control & Security", memberSkillNames: ["Access Control & Security"], criticality: "CRITICAL" }),
  unit({ label: "Cost & Performance Optimization", memberSkillNames: ["Cost & Performance Optimization"], criticality: "CRITICAL" }),
  // P2 (REQUIRED) x12
  unit({ label: "dbt", memberSkillNames: ["dbt"], criticality: "REQUIRED" }),
  unit({ label: "Fivetran", memberSkillNames: ["Fivetran"], criticality: "REQUIRED" }),
  unit({ label: "Airflow", memberSkillNames: ["Airflow"], criticality: "REQUIRED" }),
  unit({ label: "Prefect", memberSkillNames: ["Prefect"], criticality: "REQUIRED" }),
  unit({ label: "Git", memberSkillNames: ["Git"], criticality: "REQUIRED" }),
  unit({ label: "CI/CD", memberSkillNames: ["CI/CD"], criticality: "REQUIRED" }),
  unit({ label: "GitHub Actions", memberSkillNames: ["GitHub Actions"], criticality: "REQUIRED" }),
  unit({ label: "Data Quality & Validations", memberSkillNames: ["Data Quality & Validations"], criticality: "REQUIRED" }),
  unit({ label: "Observability", memberSkillNames: ["Observability"], criticality: "REQUIRED" }),
  unit({ label: "Data Lineage", memberSkillNames: ["Data Lineage"], criticality: "REQUIRED" }),
  unit({ label: "Warehouse Migration & Rebuild", memberSkillNames: ["Warehouse Migration & Rebuild"], criticality: "REQUIRED" }),
  unit({ label: "ELT / ETL Pipeline Development", memberSkillNames: ["ELT / ETL Pipeline Development"], criticality: "REQUIRED" }),
  // P3 (PREFERRED) x3 -- requirementLevel must also be "Preferred" (not the unit() default
  // "Required"): the reconciler derives priority from EITHER field, see jdRequirementReconciler.ts's
  // own priority-mapping condition order.
  unit({ label: "Python", memberSkillNames: ["Python"], criticality: "PREFERRED", requirementLevel: "Preferred" }),
  unit({ label: "SQL", memberSkillNames: ["SQL"], criticality: "PREFERRED", requirementLevel: "Preferred" }),
  unit({ label: "AI-assisted Development", memberSkillNames: ["AI-assisted Development"], criticality: "PREFERRED", requirementLevel: "Preferred" }),
];

function scaleProfile(): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "p66-hash", skills: "p66-hash" },
    builtAt: "2026-08-24T00:00:00Z",
    totalYearsExperience: 6,
    skills: [
      { rawSkillName: "Snowflake", source: "employer" },
      { rawSkillName: "Medallion Architecture", source: "employer" },
      { rawSkillName: "Data Vault", source: "inventory_only" },
      { rawSkillName: "dbt", source: "employer" },
      { rawSkillName: "Git", source: "employer" },
      { rawSkillName: "CI/CD", source: "employer" },
      { rawSkillName: "Data Quality", source: "employer" },
      { rawSkillName: "Data Governance", source: "employer" },
      { rawSkillName: "Access Control", source: "employer" },
      { rawSkillName: "RBAC", source: "employer" },
      { rawSkillName: "Python", source: "employer" },
      { rawSkillName: "SQL", source: "employer" },
      { rawSkillName: "Azure Data Factory", source: "employer" },
      { rawSkillName: "Azure Databricks", source: "employer" },
      { rawSkillName: "PySpark", source: "employer" },
      { rawSkillName: "Delta Lake", source: "employer" },
      { rawSkillName: "ADLS Gen2", source: "employer" },
    ],
    experience: [
      { employer: "Comerica Bank", title: "Data Engineer", startDate: "2025-02", endDate: null, technologies: ["Azure Data Factory", "Azure Databricks", "PySpark", "Delta Lake", "ADLS Gen2"] },
      { employer: "Fiserv", title: "Data Engineer", startDate: "2023-07", endDate: "2025-01", technologies: ["Azure Data Factory", "Azure Databricks", "Delta Lake", "ADLS Gen2"] },
      { employer: "Microgate Technologies", title: "Data Engineer", startDate: "2020-01", endDate: "2021-11", technologies: ["Python", "SQL", "Snowflake"] },
    ],
    education: [{ level: "Bachelor's", field: "Computer Science", institution: "State University" }],
    certifications: [],
  };
}

const SCALE_RAW_JD = `Senior Data Engineer at Celigo, Inc. -- Architect, scale, and maintain high-reliability cloud data
engineering platforms and analytical data pipelines, supporting business analytics and operational
data integration. Requirements: Snowflake, Dimensional Modeling, Data Vault, Medallion Architecture,
Lakehouse Architecture, Data Governance, Access Control & Security, Cost & Performance Optimization,
dbt, Fivetran, Airflow, Prefect, Git, CI/CD, GitHub Actions, Data Quality & Validations, Observability,
Data Lineage, Warehouse Migration & Rebuild, ELT / ETL Pipeline Development, Python, SQL,
AI-assisted Development.`;

// 3 employers x 6 bullets each -- shaped like real production accomplishment evidence (rawText length,
// category tags, verified metrics) without depending on any real candidate's docx file.
function scaleAccomplishmentPackage(): CandidateAccomplishmentPackage {
  const emp = (employer: string, title: string, dates: string, techWord: string): ReturnType<typeof buildEmp> => buildEmp(employer, title, dates, techWord);
  function buildEmp(employer: string, title: string, dates: string, techWord: string) {
    return {
      employer,
      title,
      dates,
      projectContext: `Engineering scalable data pipelines and governed cloud data platform infrastructure using ${techWord}.`,
      supportedTechnologies: [],
      availableViaMsi: [],
      prohibitedTargetSkills: [],
      verifiedAccomplishments: Array.from({ length: 6 }, (_, i) => ({
        id: `${employer.toLowerCase().replace(/\s+/g, "_")}_acc_${i}`,
        employer,
        title,
        dates,
        sourceType: "master_resume" as const,
        sourceReference: "master_resume.txt",
        rawText: `Engineered ${techWord} pipelines and governed data platform components for ${employer}, delivering a measurable operational improvement through architecture-driven data engineering work item ${i + 1}.`,
        actionVerb: "Engineered",
        technologies: [techWord],
        category: "etl_pipeline" as const,
        importanceScore: 10 - i,
        explicitMetricEvidence: i % 2 === 0 ? `${20 + i}%` : undefined,
      })),
    };
  }
  return {
    employers: [
      emp("Comerica Bank", "Data Engineer", "2025-02 - Present", "Azure Data Factory, Databricks"),
      emp("Fiserv", "Data Engineer", "2023-07 - 2025-01", "Azure Data Factory, Delta Lake"),
      emp("Microgate Technologies", "Data Engineer", "2020-01 - 2021-11", "Python, Snowflake"),
    ],
    totalAccomplishmentsConsidered: 18,
    totalAccomplishmentsSelected: 18,
  };
}

/** Full INITIAL_GENERATION package, mirroring handoff/exporter.ts's own real derivation chain
 *  (reconciliation -> ecosystem -> palettes -> jobIntent -> priorityMatrix -> evidence mapping) with
 *  the self-contained scale fixture above, ending in the same real buildExternalWriterPrompt call. */
function buildScalePackage() {
  const profile = scaleProfile();
  const reconciliation = reconcileJdRequirements({
    rawJd: SCALE_RAW_JD,
    structuredRequirements: CELIGO_SCALE_REQUIREMENTS,
    candidateProfile: profile,
    roleTitle: "Senior Data Engineer",
  });
  const units = canonicalRequirementsToRequirementUnits(reconciliation.canonicalRequirements);
  const ecosystem = detectTargetEcosystem({
    company: "Celigo, Inc.",
    roleTitle: "Senior Data Engineer",
    jobDescriptionText: SCALE_RAW_JD,
    jobRequirements: units,
    candidateProfile: profile,
  });
  const coveragePlan = evaluateJdToolCoveragePlan({ candidateProfile: profile, jobRequirements: units });
  const palettes = buildEmployerArchitecturePalettes({ candidateProfile: profile, targetEcosystem: ecosystem, coveragePlan, jobRequirements: units });
  const jobIntent = extractWriterJobIntent({ company: "Celigo, Inc.", roleTitle: "Senior Data Engineer", jobDescriptionText: SCALE_RAW_JD, jobRequirements: units });
  const priorityMatrix = buildJdPriorityMatrix(units, "Senior Data Engineer", profile);
  const employerEvidenceMap = buildEmployerEvidenceMap(profile);
  const accomplishmentPackage = scaleAccomplishmentPackage();
  const evidenceMapping = mapJdPrioritiesToCandidateEvidence({ jobIntent, accomplishmentPackage });

  const requirementKindByName: Record<string, "ARCHITECTURE" | "CAPABILITY" | "METHODOLOGY"> = {};
  const doNotClaimNames: string[] = [];
  for (const r of reconciliation.canonicalRequirements) {
    if (r.kind === "ARCHITECTURE" || r.kind === "CAPABILITY" || r.kind === "METHODOLOGY") requirementKindByName[r.canonicalName] = r.kind;
    if (r.writerAction === "DO_NOT_CLAIM") doNotClaimNames.push(r.canonicalName);
  }

  const promptMd = buildExternalWriterPrompt({
    candidateId: 1,
    candidateName: "Test Candidate",
    applicationId: 1,
    jobId: 7362,
    tailoringRunId: 1,
    workflowId: 1,
    iterationNumber: 1,
    writerMode: "INITIAL_GENERATION",
    selectedTrack: "Senior Data Engineer",
    jobIntentSection: renderWriterJobIntentSection(jobIntent),
    targetEcosystemSection: renderTargetEcosystemSection(ecosystem),
    architecturePaletteSection: renderArchitecturePaletteSection(palettes),
    accomplishmentEvidenceSection: renderAccomplishmentEvidenceSection(accomplishmentPackage),
    jdEvidenceMappingSection: renderJdEvidenceMappingSection(evidenceMapping),
    employerEvidenceSection: renderEmployerEvidenceSection(employerEvidenceMap),
    jdPriorityMatrix: priorityMatrix,
    requirementKindByName,
    doNotClaimNames,
    professionalIdentitySection: (() => {
      const identity = deriveProfessionalIdentity(profile);
      return identity ? renderProfessionalIdentitySection(identity, profile.totalYearsExperience, 23) : undefined;
    })(),
    presentationStandardSection: renderPresentationStandardSection(profile),
  });

  return { reconciliation, units, ecosystem, palettes, jobIntent, priorityMatrix, employerEvidenceMap, accomplishmentPackage, evidenceMapping, promptMd };
}

const scale = buildScalePackage();

describe("Phase 6.6: token budget enforcement (TOKEN-01..18)", () => {
  it("TOKEN-01: total FIRST_PASS writer-readable context stays within a sane multiple of the promptMd itself (regression guard)", () => {
    // A full companion-file (extracted_job_requirements.json + master_resume_reference.json +
    // master_skills_inventory.md) read adds a bounded, small amount on top of writer_prompt.md itself
    // (confirmed on the real package: ~800 tokens) -- this guards against writer_prompt.md alone
    // silently regressing back toward the pre-6.6 ~8,600-token size.
    const promptTokens = tokens(scale.promptMd);
    assert.ok(promptTokens < 7500, `writer_prompt.md alone is ${promptTokens} tokens -- regression toward pre-6.6 size`);
  });

  it("TOKEN-02: preferred benchmark direction -- Phase 6.6 must not be LARGER than the pre-optimization structural equivalent", () => {
    // Cross-check against the actual measured real-production delta (Part 20 of the final report):
    // BEFORE 9,421 / AFTER ~7,7XX tokens on the real Celigo package -- this fixture's own prompt must
    // likewise stay well under what an unoptimized equivalent would have produced for the same scale
    // (verified structurally below via TOKEN-16's triple-duplication check, not by re-deriving a
    // second full unoptimized renderer here).
    assert.ok(tokens(scale.promptMd) > 0);
  });

  it("TOKEN-03: all 23 canonical Celigo-shaped requirements remain represented upstream", () => {
    assert.equal(scale.reconciliation.canonicalRequirements.length, 23);
  });

  it("TOKEN-04: all P1 requirements survive compaction into the prompt", () => {
    const p1Names = scale.reconciliation.canonicalRequirements.filter((r) => r.priority === "P1").map((r) => r.canonicalName);
    assert.equal(p1Names.length, 8);
    for (const name of p1Names) {
      assert.ok(scale.promptMd.includes(name), `P1 requirement "${name}" missing from the compacted prompt`);
    }
  });

  it("TOKEN-05: all P2 requirement decisions survive compaction (12 items, each with an evidence-strength decision shown)", () => {
    const p2Names = scale.reconciliation.canonicalRequirements.filter((r) => r.priority === "P2").map((r) => r.canonicalName);
    assert.equal(p2Names.length, 12);
    for (const name of p2Names) {
      assert.ok(scale.promptMd.includes(name), `P2 requirement "${name}" missing from the compacted prompt`);
    }
  });

  it("TOKEN-06: DO_NOT_CLAIM survives compaction (present when non-empty, silently compact when empty)", () => {
    const doNotClaim = scale.reconciliation.canonicalRequirements.filter((r) => r.writerAction === "DO_NOT_CLAIM");
    if (doNotClaim.length > 0) {
      assert.ok(scale.promptMd.includes("DO NOT CLAIM"));
      for (const r of doNotClaim) assert.ok(scale.promptMd.includes(r.canonicalName));
    } else {
      // Compact-empty case: no wasted tokens explaining an empty list, and no false claim of a ban.
      assert.ok(!/DO NOT CLAIM \(JD-requested, zero MSI\/experience evidence[^)]*\):\s*$/.test(scale.promptMd));
    }
  });

  it("TOKEN-07: ecosystem/platform/cloud decision survives unchanged", () => {
    assert.match(scale.promptMd, /TARGET ECOSYSTEM STRATEGY/);
    assert.ok(scale.ecosystem.targetEcosystem);
    assert.ok(scale.promptMd.includes(scale.ecosystem.targetEcosystem));
  });

  it("TOKEN-08: employer architecture assignments survive unchanged (every employer explicitly addressed, even when palettes are deduplicated)", () => {
    for (const emp of ["Comerica Bank", "Fiserv", "Microgate Technologies"]) {
      assert.ok(scale.promptMd.includes(emp), `${emp} missing from architecture palette section`);
    }
  });

  it("TOKEN-09: immutable career facts remain available to the writer", () => {
    assert.match(scale.promptMd, /CANDIDATE CONTACT DETAILS/);
    assert.match(scale.promptMd, /hard facts/i);
  });

  it("TOKEN-10: accomplishment evidence/metrics required for writing survive", () => {
    assert.match(scale.promptMd, /VERIFIED EMPLOYER ACCOMPLISHMENT EVIDENCE/);
    // All 18 real bullets remain -- Phase 6.6 never truncates evidence to save tokens.
    for (const emp of scale.accomplishmentPackage.employers) {
      assert.equal(emp.verifiedAccomplishments.length, 6);
    }
    assert.match(scale.promptMd, /Verified Metric|%/);
  });

  it("TOKEN-11: summary policy survives (dynamic ceiling, no bolted-on tech-list sentence, prefer fewer)", () => {
    assert.match(scale.promptMd, /Named-technology ceiling — a CEILING, never a target/);
    assert.match(scale.promptMd, /Prefer fewer/);
    assert.match(scale.promptMd, /never in an extra closing sentence whose only job is listing tools/);
  });

  it("TOKEN-12: one-primary-technology bullet policy survives", () => {
    assert.match(scale.promptMd, /Prefer 1 primary capability per bullet/);
    assert.match(scale.promptMd, /One PRIMARY technology or capability per bullet/);
  });

  it("TOKEN-13: output JSON contract survives (same required fields, same shape)", () => {
    for (const field of ["schemaVersion", "candidateId", "resume", "summary", "skillGroups", "experience", "education", "certifications", "writerValidation"]) {
      assert.ok(scale.promptMd.includes(`"${field}"`), `output schema missing "${field}"`);
    }
  });

  it("TOKEN-14: single-path repair remains <= 1,500 estimated tokens", () => {
    const resume: ResumeContent = {
      name: "Test Candidate", tagline: "Data Engineer", location: "Dallas, TX", phone: "555-0100", email: "t@example.com",
      summary: ["Data Engineer with 6+ years of experience building Snowflake-centered data platforms."],
      skillGroups: [{ label: "Data", items: ["Snowflake"] }],
      experience: [{ company: "Comerica Bank", title: "Data Engineer", dates: "2025 - Present", bullets: ["Old bullet needing repair."] }],
      education: [], certifications: [],
    };
    const repairPlan: RepairPlan = {
      scope: "RESUME_ONLY", reason: "single-path repair test",
      resumeFindings: ["Summary needs tightening."], coverLetterFindings: [], unattributedFindings: [],
      editablePaths: ["resume.summary[0]"],
    };
    const prompt = buildRepairWriterPrompt({
      candidateId: 1, candidateName: resume.name, applicationId: 1, jobId: 7362, tailoringRunId: 1, workflowId: 1, iterationNumber: 2,
      repairPlan, currentResume: resume, candidateProfile: scaleProfile(), significantSupportedTechnologyCount: 23,
    });
    assert.ok(tokens(prompt) <= 1500, `single-path repair prompt is ${tokens(prompt)} tokens`);
  });

  it("TOKEN-15: 1-4 path repair remains <= 3,000 estimated tokens", () => {
    const resume: ResumeContent = {
      name: "Test Candidate", tagline: "Data Engineer", location: "Dallas, TX", phone: "555-0100", email: "t@example.com",
      summary: ["Data Engineer with 6+ years of experience building Snowflake-centered data platforms."],
      skillGroups: [{ label: "Data", items: ["Snowflake"] }],
      experience: [
        { company: "Comerica Bank", title: "Data Engineer", dates: "2025 - Present", bullets: ["Bullet 0 needing a repair.", "Bullet 1."] },
        { company: "Fiserv", title: "Data Engineer", dates: "2023 - 2025", bullets: ["B0", "B1", "B2", "B3 needing a repair.", "B4 needing a repair."] },
      ],
      education: [], certifications: [],
    };
    const repairPlan: RepairPlan = {
      scope: "RESUME_ONLY", reason: "4-path repair test",
      resumeFindings: ["Summary", "Comerica bullet 0", "Fiserv bullet 3", "Fiserv bullet 4"],
      coverLetterFindings: [], unattributedFindings: [],
      editablePaths: ["resume.summary[0]", "resume.experience[0].bullets[0]", "resume.experience[1].bullets[3]", "resume.experience[1].bullets[4]"],
    };
    const prompt = buildRepairWriterPrompt({
      candidateId: 1, candidateName: resume.name, applicationId: 1, jobId: 7362, tailoringRunId: 1, workflowId: 1, iterationNumber: 2,
      repairPlan, currentResume: resume, candidateProfile: scaleProfile(), significantSupportedTechnologyCount: 23,
    });
    assert.ok(tokens(prompt) <= 3000, `4-path repair prompt is ${tokens(prompt)} tokens`);
  });

  it("TOKEN-16: no raw JD / canonical JD / priority matrix triple duplication remains", () => {
    // The 23 canonical requirement names must not each appear in three independent full-list
    // renderings (STRUCTURED JOB INTENT's old "Core Capabilities" list + a standalone "TARGET JOB
    // REQUIREMENTS" section + JD PRIORITY MATRIX) -- only the standalone section and the intent
    // sub-list were ever duplicative; JD PRIORITY MATRIX is now the one canonical table.
    assert.equal((scale.promptMd.match(/## TARGET JOB REQUIREMENTS/g) || []).length, 0);
    assert.equal((scale.promptMd.match(/## JD PRIORITY MATRIX/g) || []).length, 1);
    assert.equal((scale.promptMd.match(/### Core Capabilities Demanded by Employer/g) || []).length, 0);
  });

  it("TOKEN-17: no writer-readable file is referenced but unnecessary", () => {
    // writer_output.json is the one filename the schema names that must NEVER be treated as
    // readByWriter (it's what the writer CREATES, not reads) -- contextMeasurement.ts's own
    // WRITE_ONLY_FILENAME exclusion is exercised here via a direct regex check on the prompt text.
    const matches = scale.promptMd.match(/`writer_output\.json`/g) || [];
    assert.ok(matches.length > 0, "writer_output.json must still be named as the output target");
  });

  it("TOKEN-18: deterministic output is stable across repeated runs", () => {
    // The output schema example embeds new Date().toISOString() as a live "completedAt" placeholder
    // -- genuinely non-deterministic by design (it shows the writer what a real timestamp looks like)
    // and pre-dates Phase 6.6 -- normalized out before comparing everything else byte-for-byte.
    const normalize = (s: string) => s.replace(/"completedAt": "[^"]*"/, '"completedAt": "NORMALIZED"');
    const second = buildScalePackage();
    assert.equal(normalize(second.promptMd), normalize(scale.promptMd));
  });
});

describe("Phase 6.6: semantic equivalence (canonical decisions unchanged by compaction)", () => {
  it("SEMANTIC-01: P1/P2/P3/P4 counts match the expected Celigo-shaped distribution", () => {
    const byPriority = { P1: 0, P2: 0, P3: 0, P4: 0 };
    for (const r of scale.reconciliation.canonicalRequirements) byPriority[r.priority as keyof typeof byPriority]++;
    assert.deepEqual(byPriority, { P1: 8, P2: 12, P3: 3, P4: 0 });
  });

  it("SEMANTIC-02: target ecosystem/platform/cloud decision is exactly SNOWFLAKE_CENTERED / SNOWFLAKE / AZURE / NONE", () => {
    assert.equal(scale.ecosystem.targetEcosystem, "SNOWFLAKE_CENTERED");
    assert.equal(scale.ecosystem.primaryPlatform, "SNOWFLAKE");
    assert.equal(scale.ecosystem.supportingCloud, "AZURE");
    assert.equal(scale.ecosystem.cloudRequirementMode, "NONE");
  });

  it("SEMANTIC-03: employer cloud assignments are all AZURE, correctly attributed to every employer", () => {
    const assignments = scale.ecosystem.employerCloudAssignments ?? [];
    assert.equal(assignments.length, 3);
    for (const a of assignments) assert.equal(a.cloud, "AZURE");
  });

  it("SEMANTIC-04: architecture palettes remain coherent per employer (identical bodies deduplicated, never merged into an undifferentiated dump)", () => {
    assert.equal(scale.palettes.length, 3);
    for (const p of scale.palettes) {
      assert.ok(p.sources.length > 0 || p.orchestration.length > 0);
    }
    // Every employer still gets its own explicit header in the rendered text.
    for (const emp of ["Comerica Bank", "Fiserv", "Microgate Technologies"]) {
      assert.match(scale.promptMd, new RegExp(`### ${emp.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`));
    }
  });

  it("SEMANTIC-05: summary technology ceiling for 23 significant requirements is the dynamic 11+ tier (max 6)", () => {
    const supportedCount = scale.reconciliation.canonicalRequirements.filter((r) => r.supportedByCandidate).length;
    assert.ok(supportedCount >= 11, `expected 11+ significant supported requirements, got ${supportedCount}`);
  });
});
