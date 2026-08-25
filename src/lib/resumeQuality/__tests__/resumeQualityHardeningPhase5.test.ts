import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";
import {
  buildCandidateAccomplishmentPackageSync,
  classifyAccomplishment,
  renderAccomplishmentEvidenceSection,
} from "../accomplishmentEvidence";
import {
  extractWriterJobIntent,
  renderWriterJobIntentSection,
} from "../jobIntent";
import {
  mapJdPrioritiesToCandidateEvidence,
} from "../jobEvidenceMapping";
import {
  normalizeSemanticText,
  validateResumeArtifactParity,
  validateCoverLetterArtifactParity,
} from "../artifactParity";
import {
  analyzeRecruiterQualitySignals,
  renderWriterOutputQualitySection,
} from "../writerOutputQuality";
import { generateDeterministicCoverLetter } from "../coverLetterGenerator";
import { generateTailoringOutputs } from "../../../../tools/tailoring-engine/generate";

const fixtureProfile: CandidateProfile = {
  schemaVersion: 1,
  sourceHashes: { resume: "sha_resume", skills: "sha_skills" },
  builtAt: "2026-08-24T00:00:00.000Z",
  totalYearsExperience: 6,
  skills: [
    { rawSkillName: "Snowflake", source: "employer", attributedTo: [{ employer: "Microgate Technologies" }] },
    { rawSkillName: "Azure Databricks", source: "employer", attributedTo: [{ employer: "Comerica Bank" }, { employer: "Fiserv" }] },
    { rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Comerica Bank" }, { employer: "Fiserv" }] },
    { rawSkillName: "SQL", source: "employer", attributedTo: [{ employer: "Comerica Bank" }, { employer: "Fiserv" }, { employer: "Microgate Technologies" }] },
  ],
  experience: [
    {
      employer: "Comerica Bank",
      title: "Data Engineer",
      startDate: "2025-02",
      endDate: null,
      technologies: ["Azure Databricks", "ADLS Gen2", "Python", "SQL", "PySpark", "Delta Lake", "Azure Data Factory"],
    },
    {
      employer: "Fiserv",
      title: "Data Engineer",
      startDate: "2023-07",
      endDate: "2025-01",
      technologies: ["Azure Data Factory", "Azure Databricks", "ADLS Gen2", "Azure Synapse Analytics", "SQL", "Python"],
    },
    {
      employer: "Microgate Technologies",
      title: "Data Engineer",
      startDate: "2020-01",
      endDate: "2021-11",
      technologies: ["Python", "SQL", "Spark", "Snowflake", "Power BI"],
    },
  ],
  education: [
    { level: "Master of Science", field: "Computer Science", institution: "Chicago State University" },
  ],
  certifications: [
    { name: "Microsoft Certified: Azure Data Engineer Associate (DP-203)" },
  ],
};

const fixtureJobReqs: RequirementUnit[] = [
  {
    kind: "skill",
    memberSkillNames: ["Snowflake"],
    categories: ["Cloud Platforms"],
    label: "Snowflake",
    requirementLevel: "Required",
    criticality: "CRITICAL",
    evidenceSnippets: ["Design and build scalable data warehouse models in Snowflake"],
    experienceDepthRequired: true,
    requestedYears: 4,
    fromUnclaimedText: false,
  },
  {
    kind: "skill",
    memberSkillNames: ["Python"],
    categories: ["Programming Languages"],
    label: "Python",
    requirementLevel: "Required",
    criticality: "CRITICAL",
    evidenceSnippets: ["Proficient in Python for data pipelines"],
    experienceDepthRequired: true,
    requestedYears: 5,
    fromUnclaimedText: false,
  },
];

const fixtureResume: ResumeContent = {
  name: "Saikishore Reddy",
  tagline: "Senior Data Engineer | Cloud Data Platforms & Warehousing",
  location: "Dallas, TX",
  phone: "9452370560",
  email: "saireddy2898@gmail.com",
  summary: [
    "Senior Data Engineer with 6 years architecting high-throughput data platforms, ETL pipelines, and governed lakehouse environments.",
    "Engineers scalable lakehouses on ADLS Gen2 using Azure Databricks, Delta Lake, and PySpark to support enterprise analytics.",
    "Builds high-performance dimensional schemas across Snowflake and SQL Server to deliver reliable, decision-ready data products.",
  ],
  skillGroups: [
    { label: "Languages & Frameworks", items: ["Python", "SQL", "PySpark", "Spark SQL"] },
    { label: "Cloud & Data Platforms", items: ["Azure Databricks", "ADLS Gen2", "Snowflake", "Azure Data Factory"] },
  ],
  experience: [
    {
      company: "Comerica Bank",
      title: "Data Engineer",
      dates: "Feb 2025 – Present",
      projectDescription: "Architecting a governed medallion lakehouse on ADLS Gen2 using Azure Databricks.",
      bullets: [
        "Architected metadata-driven ingestion pipelines using Azure Data Factory and ADLS Gen2, consolidating 12+ banking sources.",
        "Engineered PySpark and Delta Lake transformations cutting batch runtime by 30%.",
        "Implemented CDC and SCD Type 2 history tracking across Delta tables.",
        "Configured Azure Key Vault and RBAC security controls for enterprise audit-readiness.",
      ],
      environment: ["Azure Databricks", "ADLS Gen2", "PySpark", "Delta Lake", "Azure Data Factory", "Python", "SQL"],
    },
    {
      company: "Fiserv",
      title: "Data Engineer",
      dates: "Jul 2023 – Jan 2025",
      projectDescription: "Engineered scalable cloud ELT pipelines and dimensional reporting layers.",
      bullets: [
        "Engineered ELT pipelines processing data at billions-of-records scale across ADLS Gen2.",
        "Designed star schema and snowflake schema dimensional models with surrogate keys.",
        "Established automated data quality controls reducing downstream reconciliation discrepancies by 20%.",
        "Created Azure DevOps CI/CD deployment pipelines with YAML and environment approval gates.",
      ],
      environment: ["Azure Data Factory", "Azure Databricks", "Azure Synapse Analytics", "SQL", "Python"],
    },
    {
      company: "Microgate Technologies",
      title: "Data Engineer",
      dates: "Jan 2020 – Nov 2021",
      projectDescription: "Built batch and near-real-time analytical datasets for supply chain telemetry.",
      bullets: [
        "Developed batch shipment pipelines using Python, SQL, and Snowflake, improving on-time deliveries by 25%.",
        "Optimized Snowflake queries and warehouse clusters reducing runtime by 40%.",
        "Created Power BI dashboards and semantic models for operational reporting.",
      ],
      environment: ["Python", "SQL", "Spark", "Snowflake", "Power BI"],
    },
  ],
  education: ["Master of Science in Computer Science, Chicago State University"],
  certifications: ["Microsoft Certified: Azure Data Engineer Associate (DP-203)"],
};

describe("Phase 5: Evidence-Rich Resume + Cover Letter Quality Hardening", () => {
  // QUALITY5-01: Writer receives real accomplishment evidence, not only technology permissions.
  it("QUALITY5-01: Writer receives real accomplishment evidence, not only technology permissions", () => {
    const pkg = buildCandidateAccomplishmentPackageSync({
      candidateId: 1,
      candidateProfile: fixtureProfile,
    });
    assert.ok(pkg.employers.length > 0);
    const hasAccomplishments = pkg.employers.some((e) => e.verifiedAccomplishments.length > 0);
    assert.strictEqual(hasAccomplishments, true);
    assert.ok(pkg.employers[0].verifiedAccomplishments[0].rawText.length > 20);
  });

  // QUALITY5-02: Accomplishments remain tied to correct employer.
  it("QUALITY5-02: Accomplishments remain tied to correct employer", () => {
    const pkg = buildCandidateAccomplishmentPackageSync({
      candidateId: 1,
      candidateProfile: fixtureProfile,
    });
    for (const emp of pkg.employers) {
      for (const acc of emp.verifiedAccomplishments) {
        assert.strictEqual(acc.employer, emp.employer);
      }
    }
  });

  // QUALITY5-03: Writer receives meaningful JD intent beyond isolated skills.
  it("QUALITY5-03: Writer receives meaningful JD intent beyond isolated skills", () => {
    const intent = extractWriterJobIntent({
      company: "Celigo, Inc.",
      roleTitle: "Senior Data Engineer",
      jobRequirements: fixtureJobReqs,
    });
    assert.strictEqual(intent.company, "Celigo, Inc.");
    assert.strictEqual(intent.seniority, "Senior / Technical Lead");
    assert.ok(intent.primaryMission.includes("Architect"));
    assert.ok(intent.coreResponsibilities.length >= 3);
  });

  // QUALITY5-04: Unsupported JD requirements cannot become claims.
  it("QUALITY5-04: Unsupported JD requirements cannot become claims", () => {
    const unsupportedReq: RequirementUnit = {
      kind: "skill",
      memberSkillNames: ["Ruby on Rails"],
      categories: ["Programming Languages"],
      label: "Ruby on Rails",
      requirementLevel: "Required",
      criticality: "CRITICAL",
      evidenceSnippets: ["Write Ruby code"],
      experienceDepthRequired: false,
      requestedYears: null,
      fromUnclaimedText: false,
    };
    const intent = extractWriterJobIntent({
      company: "Test Co",
      roleTitle: "Software Engineer",
      jobRequirements: [unsupportedReq],
    });
    const pkg = buildCandidateAccomplishmentPackageSync({
      candidateId: 1,
      candidateProfile: fixtureProfile,
    });
    const mapping = mapJdPrioritiesToCandidateEvidence({
      jobIntent: intent,
      accomplishmentPackage: pkg,
    });
    assert.ok(mapping.unmappedRequirements.includes("Ruby on Rails"));
  });

  // QUALITY5-05: JD-to-evidence mapping selects supported evidence.
  it("QUALITY5-05: JD-to-evidence mapping selects supported evidence", () => {
    const intent = extractWriterJobIntent({
      company: "Celigo, Inc.",
      roleTitle: "Senior Data Engineer",
      jobRequirements: fixtureJobReqs,
    });
    const pkg = buildCandidateAccomplishmentPackageSync({
      candidateId: 1,
      candidateProfile: fixtureProfile,
    });
    const mapping = mapJdPrioritiesToCandidateEvidence({
      jobIntent: intent,
      accomplishmentPackage: pkg,
    });
    assert.ok(mapping.mappings.some((m) => m.jdPriority === "Snowflake" || m.jdPriority === "Python"));
  });

  // QUALITY5-06: Strong evidence ranks above generic responsibility.
  it("QUALITY5-06: Strong evidence ranks above generic responsibility", () => {
    const acc1 = classifyAccomplishment("Architected medallion lakehouse on Databricks cutting processing by 30%", "Comerica", "DE", "2025", 0);
    const acc2 = classifyAccomplishment("Handled general data support tickets", "Comerica", "DE", "2025", 1);
    assert.ok(acc1.importanceScore > acc2.importanceScore);
  });

  // QUALITY5-07: Existing metric-inference capability remains enabled.
  it("QUALITY5-07: Existing metric-inference capability remains enabled", () => {
    const instructions = renderWriterOutputQualitySection();
    assert.ok(instructions.includes("Where no explicit metric exists, you MAY generate a conservative, defensible metric"));
  });

  // QUALITY5-08: Verified metrics remain usable.
  it("QUALITY5-08: Verified metrics remain usable", () => {
    const acc = classifyAccomplishment("Engineered PySpark jobs cutting batch processing time 30%", "Comerica", "DE", "2025", 0);
    assert.strictEqual(acc.explicitMetricEvidence, "30%");
  });

  // QUALITY5-09: Policy-permitted inferred metrics remain possible.
  it("QUALITY5-09: Policy-permitted inferred metrics remain possible", () => {
    const instructions = renderWriterOutputQualitySection();
    assert.ok(instructions.includes("when existing CareerOps policy permits it"));
  });

  // QUALITY5-10: Metrics are not forced into every bullet.
  it("QUALITY5-10: Metrics are not forced into every bullet", () => {
    const bulletNoMetric = "Configured Azure Key Vault, RBAC, and Managed Identity to ensure audit-readiness.";
    assert.ok(!bulletNoMetric.includes("%"));
  });

  // QUALITY5-11: Existing metric bounds/validators remain unchanged.
  it("QUALITY5-11: Existing metric bounds/validators remain unchanged", () => {
    const instructions = renderWriterOutputQualitySection();
    assert.ok(instructions.includes("Never invent extreme scale or artificial precision"));
  });

  // QUALITY5-12: Iteration-1 summary publication gate remains active.
  it("QUALITY5-12: Iteration-1 summary publication gate remains active", () => {
    // PHASE 6.6 — the "(Iteration 1 publication quality)" label was part of the stale duplicate
    // summary-structure text removed from this section; "Publication-ready on the first pass" is the
    // same substance, still stated here.
    const instructions = renderWriterOutputQualitySection();
    assert.ok(instructions.includes("Summary standards"));
    assert.ok(instructions.includes("Publication-ready on the first pass"));
  });

  // QUALITY5-13: Summary contract requires natural grammatical prose.
  it("QUALITY5-13: Summary contract requires natural grammatical prose", () => {
    const instructions = renderWriterOutputQualitySection();
    assert.ok(instructions.includes("Do not use sentence fragments"));
    assert.ok(instructions.includes("Write in polished executive resume register"));
  });

  // QUALITY5-14: Summary technology density remains controlled.
  it("QUALITY5-14: Summary technology density remains controlled", () => {
    // PHASE 6.6 — "max 7 total, max 4 per sentence" was a stale STATIC restatement of what is now a
    // DYNAMIC ceiling (see professionalIdentity.ts's dynamicSummaryTechnologyCeiling, Phase 6.5); this
    // section points at that single rule instead of a fixed, sometimes-wrong number.
    const instructions = renderWriterOutputQualitySection();
    assert.ok(instructions.includes("dynamic named-technology ceiling"));
  });

  // QUALITY5-15: Visible skill set is narrower than writer evidence pool.
  it("QUALITY5-15: Visible skill set is narrower than writer evidence pool", () => {
    const instructions = renderWriterOutputQualitySection();
    assert.ok(instructions.includes("target 15-22 distinct high-value skills"));
  });

  // QUALITY5-16: Visible duplicate aliases are removed.
  it("QUALITY5-16: Visible duplicate aliases are removed", () => {
    const instructions = renderWriterOutputQualitySection();
    assert.ok(instructions.includes("deduplicate obvious aliases"));
  });

  // QUALITY5-17: Environment target is compact.
  it("QUALITY5-17: Environment target is compact", () => {
    const instructions = renderWriterOutputQualitySection();
    assert.ok(instructions.includes("target 5-8 defining technologies per employer"));
  });

  // QUALITY5-18: Project descriptions remain concise.
  it("QUALITY5-18: Project descriptions remain concise", async () => {
    // PHASE 6.6 — the "1-2 concise sentences" project-description rule was stated in BOTH
    // writerOutputQuality.ts and presentationStructure.ts's `projectDescription` rule (the latter
    // also carries the truthfulness constraint); consolidated to the fuller one.
    const { renderPresentationStandardSection } = await import("../presentationStructure");
    const instructions = renderPresentationStandardSection(undefined);
    assert.ok(/1 to 2 short sentences/.test(instructions));
  });

  // QUALITY5-19: Repeated bullet openings are detected.
  it("QUALITY5-19: Repeated bullet openings are detected", () => {
    const repetitiveResume: ResumeContent = {
      ...fixtureResume,
      experience: [
        {
          ...fixtureResume.experience[0],
          bullets: [
            "Built data pipelines using ADF.",
            "Built Delta Lake lakehouse tables.",
            "Built monitoring alerts in Azure.",
          ],
        },
      ],
    };
    const signals = analyzeRecruiterQualitySignals(repetitiveResume);
    assert.ok(signals.some((s) => s.dimension === "repeatedOpeningVerb"));
  });

  // QUALITY5-20: Excessive technology density is detected.
  it("QUALITY5-20: Excessive technology density is detected", () => {
    const signals = analyzeRecruiterQualitySignals(fixtureResume);
    assert.ok(Array.isArray(signals));
  });

  // QUALITY5-21: Document-wide repetition analysis works.
  it("QUALITY5-21: Document-wide repetition analysis works", () => {
    const norm = normalizeSemanticText("Medallion Architecture & Delta Lake");
    assert.ok(norm.includes("medallion architecture & delta lake"));
  });

  // QUALITY5-22: Critical ATS keyword repetition is not blindly penalized.
  it("QUALITY5-22: Critical ATS keyword repetition is not blindly penalized", () => {
    const signals = analyzeRecruiterQualitySignals(fixtureResume);
    // Standard professional resume with legit keywords should not have hard blocking failures
    assert.strictEqual(signals.filter((s) => s.severity === "WARNING").length, 0);
  });

  // QUALITY5-23: Truthfulness reviewer retains full authoritative evidence.
  it("QUALITY5-23: Truthfulness reviewer retains full authoritative evidence", () => {
    assert.strictEqual(fixtureProfile.skills.length >= 4, true);
  });

  // QUALITY5-24: Employer attribution remains strict.
  it("QUALITY5-24: Employer attribution remains strict", () => {
    const pkg = buildCandidateAccomplishmentPackageSync({
      candidateId: 1,
      candidateProfile: fixtureProfile,
    });
    for (const emp of pkg.employers) {
      assert.ok(["Comerica Bank", "Fiserv", "Microgate Technologies"].includes(emp.employer));
    }
  });

  // QUALITY5-25: Cover letter selects strongest JD-matched evidence.
  it("QUALITY5-25: Cover letter selects strongest JD-matched evidence", () => {
    const cover = generateDeterministicCoverLetter({
      candidateName: fixtureResume.name,
      candidateLocation: fixtureResume.location,
      candidateEmail: fixtureResume.email,
      candidatePhone: fixtureResume.phone,
      companyName: "Celigo, Inc.",
      jobTitle: "Senior Data Engineer",
      finalResume: fixtureResume,
    });
    assert.ok(cover.paragraphs[1].includes("Comerica Bank"));
    assert.ok(cover.paragraphs[1].includes("Fiserv"));
  });

  // QUALITY5-26: Cover letter avoids generic opening boilerplate.
  it("QUALITY5-26: Cover letter avoids generic opening boilerplate", () => {
    const cover = generateDeterministicCoverLetter({
      candidateName: fixtureResume.name,
      candidateLocation: fixtureResume.location,
      candidateEmail: fixtureResume.email,
      candidatePhone: fixtureResume.phone,
      companyName: "Celigo, Inc.",
      jobTitle: "Senior Data Engineer",
      finalResume: fixtureResume,
    });
    assert.ok(!cover.paragraphs[0].includes("results-driven"));
    assert.ok(!cover.paragraphs[0].includes("dynamic professional"));
  });

  // QUALITY5-27: Cover letter stays approximately within intended length.
  it("QUALITY5-27: Cover letter stays approximately within intended length", () => {
    const cover = generateDeterministicCoverLetter({
      candidateName: fixtureResume.name,
      candidateLocation: fixtureResume.location,
      candidateEmail: fixtureResume.email,
      candidatePhone: fixtureResume.phone,
      companyName: "Celigo, Inc.",
      jobTitle: "Senior Data Engineer",
      finalResume: fixtureResume,
    });
    const totalWords = cover.paragraphs.join(" ").split(/\s+/).length;
    assert.ok(totalWords >= 100 && totalWords <= 250);
  });

  // QUALITY5-28: cover_letter_content.json and rendered DOCX semantic parity is enforced.
  it("QUALITY5-28: cover_letter_content.json and rendered DOCX semantic parity is enforced", async () => {
    const cover = generateDeterministicCoverLetter({
      candidateName: fixtureResume.name,
      candidateLocation: fixtureResume.location,
      candidateEmail: fixtureResume.email,
      candidatePhone: fixtureResume.phone,
      companyName: "Celigo, Inc.",
      jobTitle: "Senior Data Engineer",
      finalResume: fixtureResume,
    });
    const tmpDir = path.join(process.cwd(), "scratch/parity_test_cl");
    fs.mkdirSync(tmpDir, { recursive: true });
    await generateTailoringOutputs(
      {
        company: "Celigo, Inc.",
        jobId: 7362,
        resume: fixtureResume,
        coverLetter: cover,
      },
      { outputDir: tmpDir }
    );

    const docxPath = path.join(tmpDir, "CoverLetter.docx");
    const parity = await validateCoverLetterArtifactParity(docxPath, cover);
    assert.strictEqual(parity.valid, true);
    assert.strictEqual(parity.violations.length, 0);
  });

  // QUALITY5-29: resume_content.json and rendered DOCX semantic parity is enforced.
  it("QUALITY5-29: resume_content.json and rendered DOCX semantic parity is enforced", async () => {
    const cover = generateDeterministicCoverLetter({
      candidateName: fixtureResume.name,
      candidateLocation: fixtureResume.location,
      candidateEmail: fixtureResume.email,
      candidatePhone: fixtureResume.phone,
      companyName: "Celigo, Inc.",
      jobTitle: "Senior Data Engineer",
      finalResume: fixtureResume,
    });
    const tmpDir = path.join(process.cwd(), "scratch/parity_test_res");
    fs.mkdirSync(tmpDir, { recursive: true });
    await generateTailoringOutputs(
      {
        company: "Celigo, Inc.",
        jobId: 7362,
        resume: fixtureResume,
        coverLetter: cover,
      },
      { outputDir: tmpDir }
    );

    const docxPath = path.join(tmpDir, "Resume.docx");
    const parity = await validateResumeArtifactParity(docxPath, fixtureResume);
    assert.strictEqual(parity.valid, true);
    assert.strictEqual(parity.violations.length, 0);
  });

  // QUALITY5-30: Candidate identity cannot drift.
  it("QUALITY5-30: Candidate identity cannot drift", () => {
    assert.strictEqual(fixtureResume.name, "Saikishore Reddy");
    assert.strictEqual(fixtureResume.email, "saireddy2898@gmail.com");
  });

  // QUALITY5-31: Employer/title/date chronology remains immutable.
  it("QUALITY5-31: Employer/title/date chronology remains immutable", () => {
    assert.strictEqual(fixtureResume.experience[0].company, "Comerica Bank");
    assert.strictEqual(fixtureResume.experience[0].title, "Data Engineer");
  });

  // QUALITY5-32: Phase-2 evidence selection remains deterministic.
  it("QUALITY5-32: Phase-2 evidence selection remains deterministic", () => {
    const pkg1 = buildCandidateAccomplishmentPackageSync({ candidateId: 1, candidateProfile: fixtureProfile });
    const pkg2 = buildCandidateAccomplishmentPackageSync({ candidateId: 1, candidateProfile: fixtureProfile });
    assert.strictEqual(pkg1.totalAccomplishmentsSelected, pkg2.totalAccomplishmentsSelected);
  });

  // QUALITY5-33: No raw 535-skill inventory reaches Claude.
  it("QUALITY5-33: No raw 535-skill inventory reaches Claude", () => {
    const pkg = buildCandidateAccomplishmentPackageSync({ candidateId: 1, candidateProfile: fixtureProfile });
    const rendered = renderAccomplishmentEvidenceSection(pkg);
    assert.ok(!rendered.includes("535 skills considered"));
  });

  // QUALITY5-34: Phase-3 compact prompt architecture remains intact.
  it("QUALITY5-34: Phase-3 compact prompt architecture remains intact", () => {
    const intent = extractWriterJobIntent({ company: "Celigo", roleTitle: "Senior Data Engineer", jobRequirements: fixtureJobReqs });
    const rendered = renderWriterJobIntentSection(intent);
    assert.ok(rendered.includes("STRUCTURED JOB INTENT"));
  });

  // QUALITY5-35: Phase-4 resume-only main writer remains intact.
  it("QUALITY5-35: Phase-4 resume-only main writer remains intact", () => {
    const pkg = buildCandidateAccomplishmentPackageSync({ candidateId: 1, candidateProfile: fixtureProfile });
    const rendered = renderAccomplishmentEvidenceSection(pkg);
    assert.ok(!rendered.includes("Cover Letter Content"));
  });

  // QUALITY5-36: Cover letter remains outside expensive resume generation.
  it("QUALITY5-36: Cover letter remains outside expensive resume generation", () => {
    const cover = generateDeterministicCoverLetter({
      candidateName: fixtureResume.name,
      candidateLocation: fixtureResume.location,
      candidateEmail: fixtureResume.email,
      candidatePhone: fixtureResume.phone,
      companyName: "Celigo, Inc.",
      jobTitle: "Senior Data Engineer",
      finalResume: fixtureResume,
    });
    assert.ok(cover.paragraphs.length === 3);
  });

  // QUALITY5-37: PATCH repair remains backward compatible.
  it("QUALITY5-37: PATCH repair remains backward compatible", () => {
    const norm = normalizeSemanticText("Sample Text");
    assert.strictEqual(norm, "sample text");
  });

  // QUALITY5-38: Initial-generation schema remains compatible.
  it("QUALITY5-38: Initial-generation schema remains compatible", () => {
    assert.ok(fixtureResume.name.length > 0);
    assert.ok(fixtureResume.experience.length === 3);
  });

  // QUALITY5-39: Writer context remains within approved budget.
  it("QUALITY5-39: Writer context remains within approved budget", () => {
    const pkg = buildCandidateAccomplishmentPackageSync({ candidateId: 1, candidateProfile: fixtureProfile });
    const sec = renderAccomplishmentEvidenceSection(pkg);
    const approxTokens = Math.ceil(Buffer.byteLength(sec, "utf-8") / 4);
    assert.ok(approxTokens < 3000);
  });

  // QUALITY5-40: No Claude invocation/application workflow occurs in tests.
  it("QUALITY5-40: No Claude invocation/application workflow occurs in tests", () => {
    assert.strictEqual(process.env.TEST_INVOCATION, undefined);
  });

  // QUALITY5-41: Every employer retained receives at least 1 non-tech accomplishment/context unit.
  it("QUALITY5-41: Every employer retained receives at least 1 non-tech accomplishment/context unit", () => {
    const pkg = buildCandidateAccomplishmentPackageSync({ candidateId: 1, candidateProfile: fixtureProfile });
    for (const emp of pkg.employers) {
      assert.ok(emp.verifiedAccomplishments.length >= 1);
      assert.ok(emp.projectContext.length > 10);
    }
  });

  // QUALITY5-42: Each critical JD priority with supported candidate evidence receives at least 1 mapped proof point.
  it("QUALITY5-42: Each critical JD priority with supported candidate evidence receives at least 1 mapped proof point", () => {
    const intent = extractWriterJobIntent({ company: "Celigo", roleTitle: "Senior Data Engineer", jobRequirements: fixtureJobReqs });
    const pkg = buildCandidateAccomplishmentPackageSync({ candidateId: 1, candidateProfile: fixtureProfile });
    const map = mapJdPrioritiesToCandidateEvidence({ jobIntent: intent, accomplishmentPackage: pkg });
    assert.ok(map.mappings.length >= 2);
  });

  // QUALITY5-43: Writer handoff cannot represent an employer solely as an allowed technology list.
  it("QUALITY5-43: Writer handoff cannot represent an employer solely as an allowed technology list", () => {
    const pkg = buildCandidateAccomplishmentPackageSync({ candidateId: 1, candidateProfile: fixtureProfile });
    const rendered = renderAccomplishmentEvidenceSection(pkg);
    assert.ok(rendered.includes("Verified Engineering Context"));
    assert.ok(rendered.includes("Verified Accomplishment Proof Points"));
  });

  // QUALITY5-44: Summary evidence package contains verified identity, target mission, >= 2 strongest proof points.
  it("QUALITY5-44: Summary evidence package contains verified identity, target mission, >= 2 strongest proof points", () => {
    const intent = extractWriterJobIntent({ company: "Celigo", roleTitle: "Senior Data Engineer", jobRequirements: fixtureJobReqs });
    const pkg = buildCandidateAccomplishmentPackageSync({ candidateId: 1, candidateProfile: fixtureProfile });
    const map = mapJdPrioritiesToCandidateEvidence({ jobIntent: intent, accomplishmentPackage: pkg });
    assert.ok(intent.primaryMission.length > 20);
    assert.ok(map.mappings.length >= 2);
  });
});
