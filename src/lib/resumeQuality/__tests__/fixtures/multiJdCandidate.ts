import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { ResumeContent } from "../../../../../tools/tailoring-engine/types";

/**
 * Stage 21 (Evidence-Grounded Resume Quality V2) — shared fixture used by positioning, skill-ranking,
 * bullet-ranking, and the multi-JD regression matrix (NEXT 10). ONE fixed candidate evidence base
 * (Master Resume/Skills Inventory) with real, varied, cross-technology experience spanning three
 * employers, plus four differently-shaped JDs (Snowflake-heavy, Azure Databricks, AI/Data, Platform/
 * Infrastructure-heavy) — proving the SAME evidence base can be truthfully repositioned per role
 * without any fact ever changing (per the mission's own explicit multi-JD acceptance example).
 */

export const MULTI_JD_MASTER_PROFILE: CandidateProfile = {
  schemaVersion: 1,
  sourceHashes: { resume: "multi-jd-r", skills: "multi-jd-s" },
  builtAt: "2015-01-01T00:00:00Z",
  skills: [
    { rawSkillName: "Kubernetes", source: "inventory_only" },
    { rawSkillName: "PostgreSQL", source: "inventory_only" },
  ],
  experience: [
    {
      employer: "Northwind Logistics Analytics",
      title: "Senior Data Engineer",
      startDate: "2022-01",
      endDate: null,
      technologies: ["Snowflake", "dbt", "Airflow", "Python", "SQL"],
    },
    {
      employer: "Meridian Health Systems",
      title: "Data Engineer",
      startDate: "2019-01",
      endDate: "2021-12",
      technologies: ["Azure Data Factory", "Databricks", "PySpark", "Python", "SQL"],
    },
    {
      employer: "Solstice Cloud Platforms",
      title: "Platform Engineer",
      startDate: "2015-06",
      endDate: "2018-12",
      technologies: ["Terraform", "Docker", "AKS", "Prometheus", "Grafana", "Python"],
    },
  ],
  education: [{ level: "Bachelor's", field: "Computer Science", institution: "Riverside State University" }],
  certifications: [],
  totalYearsExperience: 10,
};

// Master resume prose (bullets/summary) an external writer would draw from — deliberately generic,
// so per-JD tailoring output is visibly different from this un-tailored baseline.
export const MULTI_JD_BASELINE_RESUME: ResumeContent = {
  name: "Priya Anand",
  tagline: "Data Engineer",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "priya.anand@gmail.com",
  summary: ["Data engineer with experience across cloud data platforms and infrastructure."],
  skillGroups: [
    { label: "Technical Skills", items: ["Snowflake", "dbt", "Airflow", "Azure Data Factory", "Databricks", "PySpark", "Terraform", "Docker", "AKS", "Prometheus", "Grafana", "Python", "SQL"] },
  ],
  experience: [
    {
      title: "Senior Data Engineer",
      company: "Northwind Logistics Analytics",
      dates: "2022 - Present",
      bullets: [
        "Built Snowflake data warehouse for logistics analytics.",
        "Wrote dbt transformation models.",
        "Orchestrated pipelines with Airflow.",
      ],
    },
    {
      title: "Data Engineer",
      company: "Meridian Health Systems",
      dates: "2019 - 2021",
      bullets: ["Built Azure Data Factory pipelines.", "Used Databricks and PySpark for transformations."],
    },
    {
      title: "Platform Engineer",
      company: "Solstice Cloud Platforms",
      dates: "2015 - 2018",
      bullets: ["Managed infrastructure with Terraform and Docker on AKS.", "Set up Prometheus and Grafana monitoring."],
    },
  ],
  education: ["B.S. Computer Science, Riverside State University"],
};

function req(overrides: Partial<RequirementUnit> & { criticality: RequirementUnit["criticality"] }): RequirementUnit {
  // requirementLevel defaults from criticality when not explicitly overridden — CRITICAL/REQUIRED
  // belong in the "Required" coverage pool atsChecks.ts scores against, PREFERRED/OPTIONAL in the
  // "Preferred" pool, matching how a real JD extraction would tag them (Phase 2's own two fields are
  // correlated, not independent, in real data — a fixture that decouples them entirely would produce
  // an ATS score atsChecks.ts never actually sees in production).
  const defaultLevel = overrides.criticality === "CRITICAL" || overrides.criticality === "REQUIRED" ? "Required" : "Preferred";
  return {
    kind: "skill",
    memberSkillNames: [],
    categories: [],
    label: "requirement",
    requirementLevel: defaultLevel,
    evidenceSnippets: [],
    experienceDepthRequired: false,
    requestedYears: null,
    fromUnclaimedText: false,
    ...overrides,
  };
}

export interface JdShapeFixture {
  name: string;
  targetRoleTitle: string;
  requirements: RequirementUnit[];
  /** Canonical skills this JD shape's tailoring should cause to rise toward the top. */
  expectedRisingSkills: string[];
  /** Canonical skills this JD shape should NOT lead with, even though the candidate has them. */
  expectedNotLeading: string[];
}

export const JD_SHAPES: JdShapeFixture[] = [
  {
    name: "A. Snowflake-heavy Senior Data Engineer",
    targetRoleTitle: "Senior Data Engineer",
    requirements: [
      req({ label: "Snowflake", memberSkillNames: ["Snowflake"], criticality: "CRITICAL" }),
      req({ label: "dbt", memberSkillNames: ["dbt"], criticality: "CRITICAL" }),
      req({ label: "Airflow", memberSkillNames: ["Airflow"], criticality: "REQUIRED" }),
      req({ label: "Python", memberSkillNames: ["Python"], criticality: "REQUIRED" }),
      req({ label: "Docker", memberSkillNames: ["Docker"], criticality: "OPTIONAL" }),
      req({ label: "Kubernetes", memberSkillNames: ["Kubernetes"], criticality: "OPTIONAL" }),
    ],
    expectedRisingSkills: ["Snowflake", "dbt", "Airflow"],
    expectedNotLeading: ["Terraform", "Prometheus", "Grafana"],
  },
  {
    name: "B. Azure Databricks Data Engineer",
    targetRoleTitle: "Data Engineer",
    requirements: [
      req({ label: "Azure Data Factory", memberSkillNames: ["Azure Data Factory"], criticality: "CRITICAL" }),
      req({ label: "Databricks", memberSkillNames: ["Databricks"], criticality: "CRITICAL" }),
      req({ label: "PySpark", memberSkillNames: ["PySpark"], criticality: "REQUIRED" }),
      req({ label: "Python", memberSkillNames: ["Python"], criticality: "REQUIRED" }),
      req({ label: "Snowflake", memberSkillNames: ["Snowflake"], criticality: "OPTIONAL" }),
    ],
    expectedRisingSkills: ["Azure Data Factory", "Databricks", "PySpark"],
    expectedNotLeading: ["Terraform", "Prometheus", "Grafana", "Snowflake"],
  },
  {
    // Deliberately a JD the candidate has NO grounded evidence for on its own two hallmark
    // technologies (Azure OpenAI, RAG) — this shape exists to prove UNSUPPORTED requirements are
    // reported honestly rather than fabricated, while genuinely-shared adjacent skills (Python) still
    // surface correctly. See ATS coverage report tests (NEXT 9) for the direct assertion on this.
    name: "C. AI/Data Engineer",
    targetRoleTitle: "AI Data Engineer",
    requirements: [
      req({ label: "Azure OpenAI", memberSkillNames: ["Azure OpenAI"], criticality: "CRITICAL" }),
      req({ label: "RAG", memberSkillNames: ["RAG"], criticality: "CRITICAL" }),
      req({ label: "Python", memberSkillNames: ["Python"], criticality: "REQUIRED" }),
      req({ label: "Azure AI Search", memberSkillNames: ["Azure AI Search"], criticality: "PREFERRED" }),
    ],
    expectedRisingSkills: ["Python"],
    expectedNotLeading: ["Terraform", "Prometheus", "Grafana"],
  },
  {
    name: "D. Data Platform/Infrastructure-heavy role",
    targetRoleTitle: "Platform Engineer",
    requirements: [
      req({ label: "Terraform", memberSkillNames: ["Terraform"], criticality: "CRITICAL" }),
      req({ label: "Docker", memberSkillNames: ["Docker"], criticality: "CRITICAL" }),
      req({ label: "AKS", memberSkillNames: ["AKS"], criticality: "REQUIRED" }),
      req({ label: "Prometheus", memberSkillNames: ["Prometheus"], criticality: "REQUIRED" }),
      req({ label: "Grafana", memberSkillNames: ["Grafana"], criticality: "PREFERRED" }),
    ],
    expectedRisingSkills: ["Terraform", "Docker", "AKS", "Prometheus"],
    expectedNotLeading: ["Snowflake", "dbt", "Databricks"],
  },
];
