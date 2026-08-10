import type { CoverLetterContent, ResumeContent } from "../types";

export interface Fixture {
  name: string;
  resume: ResumeContent;
  coverLetter: CoverLetterContent;
}

const baseCoverLetter = (roleLabel: string): CoverLetterContent => ({
  name: "Fixture Candidate",
  location: "Austin, TX",
  phone: "+1 (555) 010-0100",
  email: "fixture@example.com",
  linkedin: "linkedin.com/in/fixture",
  salutation: "Dear Hiring Team,",
  paragraphs: [
    `I'm applying for the ${roleLabel} role and believe my background is a strong match.`,
    "This is fixture content used only to exercise the rendering and validation engine — not a real application.",
  ],
  closing: "Best,",
});

// Fixture 1: Azure-heavy data engineer — mirrors the real Ostium-style content shape, no
// certifications field omitted (tests the optional-section-present path), no LinkedIn to test the
// optional-field-absent path in the contact line.
const azureDataEngineer: Fixture = {
  name: "Azure Data Engineer",
  resume: {
    name: "Fixture Candidate",
    tagline: "Senior Data Engineer | Azure Data Platforms & Distributed Processing",
    location: "Austin, TX",
    phone: "+1 (555) 010-0100",
    email: "fixture@example.com",
    // linkedin intentionally omitted — tests optional field absence
    summary: [
      "Senior data engineer with production Azure Data Factory and Databricks experience at scale.",
      "Owns governance and security end to end, from Key Vault to Purview lineage.",
    ],
    skillGroups: [
      { label: "Cloud & Data Platform (Azure)", items: ["Azure Data Factory", "Azure Databricks", "ADLS Gen2"] },
      { label: "Big Data & ETL/ELT", items: ["Apache Spark", "PySpark", "Delta Lake"] },
      { label: "Databases", items: ["Azure SQL Database", "SQL Server"] },
    ],
    certifications: ["Microsoft Certified: Azure Data Engineer Associate (DP-203)"],
    experience: [
      {
        title: "Data Engineer",
        company: "Fixture Bank",
        dates: "Feb 2025 – Present",
        bullets: [
          "Owned a production Azure Databricks pipeline processing banking data at scale, cutting batch time 30%.",
          "Shipped an internal RAG chatbot that cut issue-research time 45%.",
          "Implemented CDC and SCD Type 1/2 patterns across production Delta tables, cutting full-table reloads 35%.",
        ],
      },
      {
        title: "Data Engineer",
        company: "Fixture Fintech",
        dates: "Jul 2023 – Jan 2025",
        bullets: [
          "Processed billions of records nightly through Azure Databricks Delta Lake pipelines.",
          "Built Azure DevOps CI/CD pipelines, cutting deployment errors 22%.",
        ],
      },
    ],
    education: ["M.S. Computer Science, Fixture University — 2022 – 2023"],
  },
  coverLetter: baseCoverLetter("Azure Data Engineer"),
};

// Fixture 2: Databricks/Spark specialist — different skill-group ordering (orchestration/big-data
// first instead of cloud-platform-first), longer bullet list on the current role (tests the 8-bullet
// upper bound), a single-bullet older role (tests the low end of the bullet-count range).
const databricksSparkEngineer: Fixture = {
  name: "Databricks/Spark Engineer",
  resume: {
    name: "Fixture Candidate",
    tagline: "Data Engineer | Databricks, Spark & Distributed Data Processing",
    location: "Austin, TX",
    phone: "+1 (555) 010-0100",
    email: "fixture@example.com",
    linkedin: "linkedin.com/in/fixture",
    summary: [
      "Data engineer specializing in large-scale Spark processing on Databricks.",
      "Deep experience with Delta Lake, structured streaming, and cluster cost optimization.",
    ],
    skillGroups: [
      { label: "Big Data & Distributed Processing", items: ["Apache Spark", "Databricks", "Delta Lake", "Structured Streaming"] },
      { label: "Orchestration", items: ["Databricks Workflows", "Apache Airflow"] },
      { label: "Cloud Platform", items: ["AWS", "S3", "EMR"] },
      { label: "Languages", items: ["Python", "Scala", "SQL"] },
    ],
    experience: [
      {
        title: "Senior Data Engineer",
        company: "Fixture Streaming Co",
        dates: "Mar 2022 – Present",
        bullets: [
          "Redesigned a Spark structured-streaming pipeline processing 2M events/minute, cutting p99 latency 40%.",
          "Tuned Databricks cluster autoscaling policies, cutting compute cost 25% with no throughput regression.",
          "Migrated a legacy batch ETL job to Delta Lake MERGE operations, cutting nightly runtime 3 hours to 40 minutes.",
          "Built a schema-evolution framework for Delta tables, eliminating manual DDL changes for new event types.",
          "Led incident response for a production data-quality regression, restoring correct output within 90 minutes.",
          "Established unit and integration test coverage for core Spark jobs using pytest and local Delta tables.",
          "Documented pipeline architecture and on-call runbooks, cutting new-hire ramp time by half.",
          "Partnered with the ML team to expose feature-store tables consumable by their training pipelines.",
        ],
      },
      {
        title: "Data Engineer",
        company: "Fixture Analytics Inc",
        dates: "Jun 2019 – Feb 2022",
        bullets: ["Built the company's first Spark-based ETL pipeline, replacing a single-threaded Python script."],
      },
    ],
    education: ["B.S. Computer Science, Fixture State University — 2015 – 2019"],
  },
  coverLetter: baseCoverLetter("Databricks/Spark Engineer"),
};

// Fixture 3: AI/GenAI engineer — smallest resume (tests the low end of everything: 2 skill groups,
// short summary, no certifications), and a bullet right at the ~32-word density ceiling to make
// sure long lines still render/validate correctly.
const aiGenAiEngineer: Fixture = {
  name: "AI/GenAI Engineer",
  resume: {
    name: "Fixture Candidate",
    tagline: "AI Engineer | RAG Systems & LLM Application Development",
    location: "Austin, TX",
    phone: "+1 (555) 010-0100",
    email: "fixture@example.com",
    linkedin: "linkedin.com/in/fixture",
    summary: [
      "AI engineer building production retrieval-augmented generation systems on top of existing data platforms.",
    ],
    skillGroups: [
      { label: "Generative AI", items: ["RAG", "Azure OpenAI", "Embeddings", "Vector Search"] },
      { label: "Languages", items: ["Python"] },
    ],
    experience: [
      {
        title: "AI Engineer",
        company: "Fixture Labs",
        dates: "Jan 2024 – Present",
        bullets: [
          "Built a production retrieval-augmented generation system combining Azure AI Search hybrid retrieval with GPT-4o generation, cutting internal support-ticket research time 45% for the operations team.",
          "Implemented a chunking and reranking pipeline that improved retrieval precision 18% over naive top-k similarity search.",
        ],
      },
    ],
    education: ["B.S. Computer Science, Fixture State University — 2019 – 2023"],
  },
  coverLetter: baseCoverLetter("AI/GenAI Engineer"),
};

export const FIXTURES: Fixture[] = [azureDataEngineer, databricksSparkEngineer, aiGenAiEngineer];
