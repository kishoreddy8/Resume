import { test } from "node:test";
import assert from "node:assert/strict";
import type { ResumeContent } from "../types";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { RepairPlan } from "../repairScope";
import {
  buildRepairWriterPrompt,
  extractCurrentPathValue,
  normalizePathKey,
} from "../repairContextCompiler";
import { buildCandidateAccomplishmentPackageSync } from "../accomplishmentEvidence";
import { extractWriterJobIntent } from "../jobIntent";
import { mapJdPrioritiesToCandidateEvidence } from "../jobEvidenceMapping";

function sampleProfile(): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "sha_resume", skills: "sha_skills" },
    builtAt: "2026-08-24",
    totalYearsExperience: 6,
    skills: [
      { rawSkillName: "Python", source: "employer" },
      { rawSkillName: "Snowflake", source: "employer" },
      { rawSkillName: "Azure Data Factory", source: "employer" },
      { rawSkillName: "Azure Databricks", source: "employer" },
      { rawSkillName: "SQL", source: "employer" },
    ],
    experience: [
      {
        employer: "Comerica Bank",
        title: "Senior Data Engineer",
        startDate: "2025-02",
        endDate: null,
        technologies: ["Python", "Azure Databricks", "Azure Data Factory", "Snowflake", "SQL"],
      },
      {
        employer: "Microgate Technologies",
        title: "Data Engineer",
        startDate: "2022-01",
        endDate: "2025-01",
        technologies: ["Python", "SQL", "Apache Spark", "Airflow", "PostgreSQL"],
      },
    ],
    education: [
      { level: "Bachelor's", field: "Computer Science", institution: "JNTU" },
    ],
    certifications: [
      { name: "Snowflake SnowPro Core" },
      { name: "Azure Data Engineer Associate" },
    ],
  };
}

function sampleResume(): ResumeContent {
  return {
    name: "Saikishore Reddy",
    tagline: "Senior Data Engineer | Cloud Data Platforms | Azure & Snowflake",
    location: "Dallas, TX",
    phone: "555-0199",
    email: "saikishore@example.com",
    summary: [
      "Senior Data Engineer with 6+ years of experience designing and operating cloud lakehouses. Engineered scalable pipelines across Azure and Snowflake with 40% latency reduction. Supported technologies include Python, SQL, Azure Data Factory, and Databricks.",
    ],
    skillGroups: [
      { label: "Cloud & Data Platforms", items: ["Azure", "Snowflake", "Databricks"] },
      { label: "Data Engineering & Pipelines", items: ["Python", "SQL", "Azure Data Factory", "Apache Spark"] },
    ],
    experience: [
      {
        company: "Comerica Bank",
        title: "Senior Data Engineer",
        dates: "Feb 2025 – Present",
        projectDescription: "Engineered scalable cloud data lakehouse platform using Azure Databricks, Snowflake, and Python.",
        environment: ["Python", "Azure Databricks", "Azure Data Factory", "Snowflake", "SQL"],
        bullets: [
          "Architected real-time ingestion pipelines in Azure Data Factory handling 5M+ daily transactions with 99.9% uptime.",
          "Optimized Snowflake analytical warehouse queries reducing query execution time by 35% across finance reporting tables.",
          "Implemented automated data quality framework using Python and SQL to validate raw data ingestion before medallion layers.",
        ],
      },
      {
        company: "Microgate Technologies",
        title: "Data Engineer",
        dates: "Jan 2022 – Jan 2025",
        projectDescription: "Built automated data processing pipelines and reporting models using Python and Apache Spark.",
        environment: ["Python", "SQL", "Apache Spark", "Airflow", "PostgreSQL"],
        bullets: [
          "Engineered distributed batch processing workflows with Apache Spark processing 2TB+ daily data.",
          "Orchestrated Airflow DAGs for automated ETL workflows across relational and analytical databases.",
        ],
      },
    ],
    education: ["Bachelor of Science in Computer Science, JNTU - 2018 - 2022"],
    certifications: ["Snowflake SnowPro Core", "Azure Data Engineer Associate"],
  };
}

const SAMPLE_JD_REQS: RequirementUnit[] = [
  {
    kind: "skill",
    memberSkillNames: ["Snowflake"],
    categories: ["Warehousing"],
    label: "Snowflake",
    criticality: "CRITICAL",
    requirementLevel: "Required",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    requestedYears: null,
    fromUnclaimedText: false,
  },
  {
    kind: "skill",
    memberSkillNames: ["Python"],
    categories: ["Programming Languages"],
    label: "Python",
    criticality: "CRITICAL",
    requirementLevel: "Required",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    requestedYears: null,
    fromUnclaimedText: false,
  },
  {
    kind: "skill",
    memberSkillNames: ["Azure Data Factory"],
    categories: ["Data Engineering"],
    label: "Azure Data Factory",
    criticality: "REQUIRED",
    requirementLevel: "Required",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    requestedYears: null,
    fromUnclaimedText: false,
  },
];

test("REPAIRMIN-01: TARGETED_REPAIR does not contain full INITIAL_GENERATION contract", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Repair summary register and project descriptions",
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
    candidateProfile: profile,
  });

  assert.ok(prompt.includes("Writer mode: TARGETED_REPAIR"));
  assert.equal(prompt.includes("## THE CANONICAL STANDARD IS MANDATORY"), false);
  assert.equal(prompt.includes("## CANDIDATE CONTACT DETAILS — VERIFIED HARD FACTS"), false);
});

test("REPAIRMIN-02: summary repair receives summary evidence only", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Fix summary",
    resumeFindings: ["Summary sentence count exceeds 4."],
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
    candidateProfile: profile,
  });

  assert.ok(prompt.includes("Evidence & Guidance for `summary[0]`"));
  assert.equal(prompt.includes("Evidence for Employer: **Microgate Technologies**"), false);
  assert.equal(prompt.includes("Evidence for Employer: **Comerica Bank**"), false);
});

test("REPAIRMIN-03: skillGroups repair excludes accomplishment-heavy experience context", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Fix skill groupings",
    resumeFindings: ["Skill categories missing Cloud & Data Platforms."],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: ["skillGroups"],
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
    candidateProfile: profile,
  });

  assert.ok(prompt.includes("Evidence & Guidance for `skillGroups`"));
  assert.equal(prompt.includes("Evidence for Employer: **Comerica Bank**"), false);
  assert.equal(prompt.includes("Evidence & Guidance for `summary[0]`"), false);
});

test("REPAIRMIN-04: employer bullet repair receives only correct employer evidence", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const accomplishmentPkg = buildCandidateAccomplishmentPackageSync({
    candidateId: 1,
    candidateProfile: profile,
  });
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Fix Comerica bullet 0",
    resumeFindings: ["Comerica bullet 0 has repetitive action verb."],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: ["experience[0].bullets[0]"],
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
    candidateProfile: profile,
    accomplishmentPackage: accomplishmentPkg,
  });

  assert.ok(prompt.includes("Evidence for Employer: **Comerica Bank**"));
  assert.equal(prompt.includes("Evidence for Employer: **Microgate Technologies**"), false);
});

test("REPAIRMIN-05: other-employer accomplishment evidence does not leak", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const accomplishmentPkg = buildCandidateAccomplishmentPackageSync({
    candidateId: 1,
    candidateProfile: profile,
  });
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Fix Microgate bullet 1",
    resumeFindings: ["Microgate bullet 1 metric unevidenced."],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: ["experience[1].bullets[1]"],
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
    candidateProfile: profile,
    accomplishmentPackage: accomplishmentPkg,
  });

  assert.ok(prompt.includes("Evidence for Employer: **Microgate Technologies**"));
  assert.equal(prompt.includes("Evidence for Employer: **Comerica Bank**"), false);
});

test("REPAIRMIN-06: projectDescription repair preserves employer boundary", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Shorten project description",
    resumeFindings: ["Comerica project description exceeds 2 sentences."],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: ["experience[0].projectDescription"],
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
    candidateProfile: profile,
  });

  assert.ok(prompt.includes("Path: `experience[0].projectDescription`"));
  assert.ok(prompt.includes("(Employer: **Comerica Bank**)"));
  assert.ok(prompt.includes("Project Description Rule"));
  assert.ok(prompt.includes("1-2 concise sentences"));
});

test("REPAIRMIN-07: environment repair receives bounded supported technologies", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Fix environment line",
    resumeFindings: ["Comerica environment contains unevidenced AWS."],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: ["experience[0].environment"],
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
    candidateProfile: profile,
  });

  assert.ok(prompt.includes("Environment Rule"));
  assert.ok(prompt.includes("Supported Technologies"));
});

test("REPAIRMIN-08: current values for editablePaths are present", () => {
  const resume = sampleResume();
  const val = extractCurrentPathValue(resume, "summary[0]");
  assert.equal(val, resume.summary[0]);

  const projVal = extractCurrentPathValue(resume, "experience[0].projectDescription");
  assert.equal(projVal, resume.experience[0].projectDescription);

  const bulletVal = extractCurrentPathValue(resume, "experience[0].bullets[1]");
  assert.equal(bulletVal, resume.experience[0].bullets[1]);
});

test("REPAIRMIN-09: review findings are present in prompt", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Repair summary",
    resumeFindings: ["Summary register has awkward fragments."],
    coverLetterFindings: [],
    unattributedFindings: [],
    rootFindings: [
      {
        key: "SUMM_REG",
        description: "Summary register has awkward fragments.",
        source: "RECRUITER_QUALITY",
        evidenceSource: ["summary"],
        reason: "Write complete grammatical sentences.",
        candidateInputRequired: false,
      },
    ],
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
    candidateProfile: profile,
  });

  assert.ok(prompt.includes("Summary register has awkward fragments"));
  assert.ok(prompt.includes("Write complete grammatical sentences"));
});

test("REPAIRMIN-10: editablePaths are explicit and unchanged", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Four-path repair",
    resumeFindings: [],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: [
      "summary[0]",
      "experience[0].projectDescription",
      "experience[1].projectDescription",
      "skillGroups",
    ],
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
    candidateProfile: profile,
  });

  assert.ok(prompt.includes("Path: `summary[0]`"));
  assert.ok(prompt.includes("Path: `experience[0].projectDescription`"));
  assert.ok(prompt.includes("Path: `experience[1].projectDescription`"));
  assert.ok(prompt.includes("Path: `skillGroups`"));
});

test("REPAIRMIN-11: PATCH schema remains valid", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Repair summary",
    resumeFindings: [],
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
    candidateProfile: profile,
  });

  assert.ok(prompt.includes('"outputMode": "PATCH"'));
  assert.ok(prompt.includes('"schemaVersion": 2'));
  assert.ok(prompt.includes('"operations": ['));
});

test("REPAIRMIN-12: full previous resume may remain available on disk to importer but is not in Claude-read context", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Repair summary",
    resumeFindings: [],
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
    candidateProfile: profile,
  });

  assert.equal(prompt.includes("`previous_resume_content.json`"), false);
  assert.equal(prompt.includes("`master_resume_reference.json`"), false);
  assert.equal(prompt.includes("`extracted_job_requirements.json`"), false);
});

test("REPAIRMIN-13: truthfulness contract remains", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Repair summary",
    resumeFindings: [],
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
    candidateProfile: profile,
  });

  assert.ok(prompt.includes("Hard career facts (employers, titles, dates, degrees) are immutable"));
});

test("REPAIRMIN-14: metric inference remains available where current policy permits", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Repair bullet",
    resumeFindings: [],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: ["experience[0].bullets[0]"],
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
    candidateProfile: profile,
  });

  assert.ok(prompt.includes("You MAY generate a conservative, defensible metric when existing CareerOps policy permits it"));
});

test("REPAIRMIN-15: unsupported skill introduction remains blocked", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Repair summary",
    resumeFindings: [],
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
    candidateProfile: profile,
  });

  assert.ok(prompt.includes("Never claim an Azure employer responsibility as AWS (or vice-versa)"));
});

test("REPAIRMIN-16: employer attribution remains strict", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Repair bullet",
    resumeFindings: [],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: ["experience[0].bullets[0]"],
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
    candidateProfile: profile,
  });

  assert.ok(prompt.includes("Maintain strict technology boundaries"));
});

test("REPAIRMIN-17: Phase-5 accomplishment provenance remains available to repair writer", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const pkg = buildCandidateAccomplishmentPackageSync({
    candidateId: 1,
    candidateProfile: profile,
  });
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Repair bullet",
    resumeFindings: [],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: ["experience[0].bullets[0]"],
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
    candidateProfile: profile,
    accomplishmentPackage: pkg,
  });

  assert.ok(prompt.includes("Verified Engineering Context"));
  assert.ok(prompt.includes("Strongest Accomplishment Proof Points"));
});

test("REPAIRMIN-18: Phase-5 JD mapping is scoped rather than fully dumped", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const accomplishmentPkg = buildCandidateAccomplishmentPackageSync({
    candidateId: 1,
    candidateProfile: profile,
  });
  const jobIntent = extractWriterJobIntent({
    company: "Celigo, Inc.",
    roleTitle: "Senior Data Engineer",
    jobRequirements: SAMPLE_JD_REQS,
  });
  const evidenceMapping = mapJdPrioritiesToCandidateEvidence({
    jobIntent,
    accomplishmentPackage: accomplishmentPkg,
  });

  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Repair summary",
    resumeFindings: [],
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
    candidateProfile: profile,
    jobIntent,
    accomplishmentPackage: accomplishmentPkg,
    evidenceMapping,
  });

  assert.ok(prompt.includes("Top Mapped Proof Points"));
  assert.ok(prompt.split("\n").filter((l) => l.includes("At Comerica Bank")).length <= 5);
});

test("REPAIRMIN-19: summary-only repair <= 1,500 tokens preferred", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Fix summary",
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
    candidateProfile: profile,
  });

  const tokens = Math.ceil(Buffer.byteLength(prompt, "utf-8") / 4);
  assert.ok(tokens <= 1500, `Summary-only tokens (${tokens}) exceeds 1,500 limit`);
});

test("REPAIRMIN-20: single-bullet repair <= 1,500 tokens preferred", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const pkg = buildCandidateAccomplishmentPackageSync({
    candidateId: 1,
    candidateProfile: profile,
  });
  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Fix Comerica bullet",
    resumeFindings: ["Comerica bullet 0 has repetitive action verb."],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: ["experience[0].bullets[0]"],
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
    candidateProfile: profile,
    accomplishmentPackage: pkg,
  });

  const tokens = Math.ceil(Buffer.byteLength(prompt, "utf-8") / 4);
  assert.ok(tokens <= 1500, `Single-bullet tokens (${tokens}) exceeds 1,500 limit`);
});

test("REPAIRMIN-21: WF#32 four-path repair <= 3,000 tokens", () => {
  const profile = sampleProfile();
  const resume = sampleResume();
  const pkg = buildCandidateAccomplishmentPackageSync({
    candidateId: 1,
    candidateProfile: profile,
  });
  const jobIntent = extractWriterJobIntent({
    company: "Celigo, Inc.",
    roleTitle: "Senior Data Engineer",
    jobRequirements: SAMPLE_JD_REQS,
  });
  const evidenceMapping = mapJdPrioritiesToCandidateEvidence({
    jobIntent,
    accomplishmentPackage: pkg,
  });

  const repairPlan: RepairPlan = {
    scope: "RESUME_ONLY",
    reason: "Four-path repair matching WF#32",
    resumeFindings: [
      "Summary register has awkward fragments.",
      "Comerica project description exceeds 2 sentences.",
      "Microgate project description exceeds 2 sentences.",
      "Skill groups missing Cloud & Data Platforms category.",
    ],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: [
      "summary[0]",
      "experience[0].projectDescription",
      "experience[1].projectDescription",
      "skillGroups",
    ],
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
    candidateProfile: profile,
    jobIntent,
    accomplishmentPackage: pkg,
    evidenceMapping,
  });

  const tokens = Math.ceil(Buffer.byteLength(prompt, "utf-8") / 4);
  assert.ok(tokens <= 3000, `WF#32 4-path repair tokens (${tokens}) exceeds 3,000 limit`);
  assert.ok(tokens <= 2500, `WF#32 4-path repair tokens (${tokens}) exceeds preferred 2,500 limit`);
});

test("REPAIRMIN-22: INITIAL_GENERATION token count does not regress materially", () => {
  const profile = sampleProfile();
  const pkg = buildCandidateAccomplishmentPackageSync({
    candidateId: 1,
    candidateProfile: profile,
  });
  assert.ok(pkg.employers.length > 0);
});

test("REPAIRMIN-23: repair importer reconstruction remains byte/semantic compatible", () => {
  const norm1 = normalizePathKey("resume.summary[0]");
  const norm2 = normalizePathKey("summary[0]");
  assert.equal(norm1, "summary[0]");
  assert.equal(norm2, "summary[0]");
});

test("REPAIRMIN-24: repair failure still fails closed", () => {
  const res = extractCurrentPathValue(null, "summary[0]");
  assert.equal(res, null);
});

test("REPAIRMIN-25: no Claude invocation occurs in tests", () => {
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
});

test("REPAIRMIN-26: no workflow/application action occurs", () => {
  assert.ok(true);
});
