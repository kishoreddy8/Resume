import type { SkillCategory } from "@/types";

export interface SkillTaxonomyEntry {
  canonical: string;
  category: SkillCategory;
  /** Lowercase match strings, longest-first isn't required here — matching sorts globally by alias
   *  length so e.g. "Azure Data Factory" is tried before the bare "azure" alias also present in a
   *  different entry, avoiding a shorter alias stealing part of a longer one's match. */
  aliases: string[];
}

// Deliberately excludes single-letter/common-word aliases that would false-positive constantly in
// ordinary prose (bare "Go", bare "R", bare "Oracle", bare "support") — each entry's aliases are
// specific enough that a match is real evidence, not noise.
export const SKILL_TAXONOMY: SkillTaxonomyEntry[] = [
  // Programming Languages
  { canonical: "Python", category: "Programming Languages", aliases: ["python"] },
  { canonical: "Java", category: "Programming Languages", aliases: ["java"] },
  { canonical: "Scala", category: "Programming Languages", aliases: ["scala"] },
  { canonical: "SQL", category: "Programming Languages", aliases: ["sql"] },
  { canonical: "JavaScript", category: "Programming Languages", aliases: ["javascript"] },
  { canonical: "TypeScript", category: "Programming Languages", aliases: ["typescript"] },
  { canonical: "Go", category: "Programming Languages", aliases: ["golang"] },
  { canonical: "R", category: "Programming Languages", aliases: ["r programming language", "r programming"] },
  { canonical: "C#", category: "Programming Languages", aliases: ["c#", "c-sharp"] },
  { canonical: "C++", category: "Programming Languages", aliases: ["c++"] },
  // Databases
  { canonical: "PostgreSQL", category: "Databases", aliases: ["postgresql", "postgres"] },
  { canonical: "MySQL", category: "Databases", aliases: ["mysql"] },
  { canonical: "MongoDB", category: "Databases", aliases: ["mongodb"] },
  { canonical: "Redis", category: "Databases", aliases: ["redis"] },
  { canonical: "Cassandra", category: "Databases", aliases: ["cassandra"] },
  { canonical: "DynamoDB", category: "Databases", aliases: ["dynamodb"] },
  { canonical: "SQL Server", category: "Databases", aliases: ["sql server", "mssql"] },
  { canonical: "SQLite", category: "Databases", aliases: ["sqlite"] },
  // Added during Phase 2 real-data taxonomy coverage pass — see the pass's own report for the full
  // classification. Oracle/DB2/Cosmos DB/Azure SQL are major, unambiguous, industry-standard
  // databases that were previously entirely absent from this taxonomy (found via real employer-
  // attributed candidate evidence going unrecognized).
  { canonical: "Oracle", category: "Databases", aliases: ["oracle"] },
  { canonical: "DB2", category: "Databases", aliases: ["db2"] },
  { canonical: "Cosmos DB", category: "Databases", aliases: ["cosmos db"] },
  { canonical: "Azure SQL", category: "Databases", aliases: ["azure sql database", "azure sql"] },
  // Cloud Platforms
  { canonical: "AWS", category: "Cloud Platforms", aliases: ["aws", "amazon web services"] },
  { canonical: "Azure", category: "Cloud Platforms", aliases: ["microsoft azure", "azure"] },
  { canonical: "GCP", category: "Cloud Platforms", aliases: ["gcp", "google cloud platform", "google cloud"] },
  // ADLS Gen2 is a distinct, commonly-named Azure storage service — deliberately given its own
  // entry rather than left to collapse into the generic "Azure" match (see Phase 2's real-data
  // taxonomy coverage pass: several distinct Azure services were previously indistinguishable from
  // bare "Azure" in matching output).
  { canonical: "ADLS Gen2", category: "Cloud Platforms", aliases: ["azure data lake storage gen2", "azure data lake storage", "adls gen2", "adls"] },
  // Data Engineering
  { canonical: "PySpark", category: "Data Engineering", aliases: ["pyspark"] },
  { canonical: "Spark", category: "Data Engineering", aliases: ["apache spark", "spark"] },
  { canonical: "Kafka", category: "Data Engineering", aliases: ["apache kafka", "kafka"] },
  { canonical: "dbt", category: "Data Engineering", aliases: ["dbt"] },
  { canonical: "Azure Data Factory", category: "Data Engineering", aliases: ["azure data factory"] },
  { canonical: "Hadoop", category: "Data Engineering", aliases: ["hadoop"] },
  // Added during Phase 2 real-data taxonomy coverage pass. The two duplicate real-world phrasings
  // ("CDC" and "Change Data Capture (CDC)") both resolve to one canonical entry.
  //
  // STAGE 25B — the bare "scd" alias is REMOVED. That pass called these acronyms "unambiguous"; the
  // real corpus disagreed. Across 20,410 jobs the bare alias produced exactly ONE match, and it was
  // wrong: "experience with a PhD, DrPH, PharmD, MD, ScD, or equivalent advanced training" on a
  // Senior Clinical Research Scientist posting, where ScD is a Doctor of Science degree. Matching is
  // case-insensitive, so a two-letter-plus acronym that collides with a common credential cannot
  // carry itself. The unambiguous expansions are kept and still match every genuine usage.
  //
  // "cdc" is deliberately KEPT despite the same shape: it earns its place (12 matches, of which the
  // Kafka/Flink/streaming ones are genuine), but see the Stage 25B report for the hardware
  // "Clock Domain Crossing" collisions it still produces on digital-design postings.
  { canonical: "CDC", category: "Data Engineering", aliases: ["change data capture", "cdc"] },
  { canonical: "SCD", category: "Data Engineering", aliases: ["slowly changing dimension", "scd type 1", "scd type 2"] },
  // Data-modeling pattern terms — legitimate, commonly-named JD requirements, not tools, but real
  // matchable technical concepts. "Snowflake Schema" is deliberately its own entry with its own
  // full-phrase alias so it can never be confused with the "Snowflake" warehouse product (see the
  // taxonomy pass report's false-positive audit for the explicit verification of this).
  { canonical: "Star Schema", category: "Data Engineering", aliases: ["star schema"] },
  { canonical: "Snowflake Schema", category: "Data Engineering", aliases: ["snowflake schema"] },
  { canonical: "Data Vault", category: "Data Engineering", aliases: ["data vault"] },
  { canonical: "Kimball Methodology", category: "Data Engineering", aliases: ["kimball methodology", "kimball"] },
  { canonical: "Fact and Dimension Tables", category: "Data Engineering", aliases: ["fact and dimension tables", "fact/dimension tables", "fact tables", "dimension tables"] },
  { canonical: "Surrogate Keys", category: "Data Engineering", aliases: ["surrogate keys", "surrogate key"] },
  { canonical: "Medallion Architecture", category: "Data Engineering", aliases: ["medallion architecture", "bronze-silver-gold"] },
  // Big Data
  { canonical: "Hive", category: "Big Data", aliases: ["apache hive", "hive"] },
  // Warehousing
  { canonical: "Snowflake", category: "Warehousing", aliases: ["snowflake"] },
  { canonical: "Databricks", category: "Warehousing", aliases: ["databricks"] },
  { canonical: "Redshift", category: "Warehousing", aliases: ["amazon redshift", "redshift"] },
  { canonical: "BigQuery", category: "Warehousing", aliases: ["bigquery", "big query"] },
  // Added during Phase 2 real-data taxonomy coverage pass. Azure Synapse Analytics and Microsoft
  // Fabric were previously collapsing into the generic "Azure" match despite being distinct,
  // commonly-named analytics platforms (Synapse's short "synapse" alias is intentionally included
  // per the pass's explicit scope — Fabric's bare "fabric" alias is deliberately EXCLUDED, only
  // multi-word phrasings, since the bare word is too generic/collision-prone on its own).
  { canonical: "Azure Synapse Analytics", category: "Warehousing", aliases: ["azure synapse analytics", "azure synapse", "synapse"] },
  { canonical: "Microsoft Fabric", category: "Warehousing", aliases: ["microsoft fabric", "fabric data factory", "fabric lakehouse"] },
  { canonical: "OneLake", category: "Warehousing", aliases: ["onelake"] },
  { canonical: "Delta Lake", category: "Warehousing", aliases: ["delta lake"] },
  { canonical: "Delta Live Tables", category: "Warehousing", aliases: ["delta live tables", "dlt"] },
  // Orchestration
  { canonical: "Airflow", category: "Orchestration", aliases: ["apache airflow", "airflow"] },
  { canonical: "Prefect", category: "Orchestration", aliases: ["prefect"] },
  { canonical: "Dagster", category: "Orchestration", aliases: ["dagster"] },
  // AI / ML
  { canonical: "TensorFlow", category: "AI / ML", aliases: ["tensorflow"] },
  { canonical: "PyTorch", category: "AI / ML", aliases: ["pytorch"] },
  { canonical: "scikit-learn", category: "AI / ML", aliases: ["scikit-learn", "sklearn"] },
  { canonical: "MLflow", category: "AI / ML", aliases: ["mlflow"] },
  { canonical: "Machine Learning", category: "AI / ML", aliases: ["machine learning"] },
  // Added during Phase 2 real-data taxonomy coverage pass — RAG is a real, unambiguous, employer-
  // attributed term for this candidate (a production RAG chatbot). Azure OpenAI/AI Search/Document
  // Intelligence were previously collapsing into generic "Azure".
  { canonical: "RAG", category: "AI / ML", aliases: ["retrieval augmented generation", "retrieval-augmented generation", "rag"] },
  { canonical: "Azure OpenAI", category: "AI / ML", aliases: ["azure openai"] },
  { canonical: "Azure AI Search", category: "AI / ML", aliases: ["azure ai search"] },
  { canonical: "Azure AI Document Intelligence", category: "AI / ML", aliases: ["azure ai document intelligence", "document intelligence"] },
  // DevOps
  { canonical: "Docker", category: "DevOps", aliases: ["docker"] },
  { canonical: "Kubernetes", category: "DevOps", aliases: ["kubernetes", "k8s", "aks"] },
  { canonical: "Jenkins", category: "DevOps", aliases: ["jenkins"] },
  { canonical: "CI/CD", category: "DevOps", aliases: ["ci/cd", "ci-cd", "continuous integration"] },
  { canonical: "GitHub Actions", category: "DevOps", aliases: ["github actions"] },
  { canonical: "GitLab CI", category: "DevOps", aliases: ["gitlab ci"] },
  // Added during Phase 2 real-data taxonomy coverage pass. "aks" added to Kubernetes' own aliases
  // above (Azure Kubernetes Service is genuinely the same underlying technology, not a distinct
  // Azure-branded reskin the way Key Vault/DevOps/OpenAI are — see the pass report for the
  // reasoning distinguishing this case from the generic-"Azure"-collapse problem).
  { canonical: "Azure DevOps", category: "DevOps", aliases: ["azure devops", "azure pipelines"] },
  { canonical: "Git", category: "DevOps", aliases: ["git"] },
  { canonical: "Shell Scripting", category: "DevOps", aliases: ["shell scripting"] },
  // Infrastructure
  { canonical: "Terraform", category: "Infrastructure", aliases: ["terraform"] },
  { canonical: "CloudFormation", category: "Infrastructure", aliases: ["cloudformation"] },
  { canonical: "Ansible", category: "Infrastructure", aliases: ["ansible"] },
  // BI / Reporting
  { canonical: "Power BI", category: "BI / Reporting", aliases: ["power bi", "powerbi"] },
  { canonical: "DAX", category: "BI / Reporting", aliases: ["dax"] },
  { canonical: "Tableau", category: "BI / Reporting", aliases: ["tableau"] },
  { canonical: "Looker", category: "BI / Reporting", aliases: ["looker"] },
  // APIs
  // "rest apis" (plural) added during the Phase 2 taxonomy pass — the existing "rest api" alias's
  // word-boundary regex doesn't match the plural form, so real employer-attributed evidence
  // ("REST APIs") was going unrecognized.
  { canonical: "REST", category: "APIs", aliases: ["restful api", "rest apis", "rest api", "restful"] },
  { canonical: "GraphQL", category: "APIs", aliases: ["graphql"] },
  { canonical: "gRPC", category: "APIs", aliases: ["grpc"] },
  // Governance
  { canonical: "Data Governance", category: "Governance", aliases: ["data governance"] },
  { canonical: "Collibra", category: "Governance", aliases: ["collibra"] },
  // Added during Phase 2 real-data taxonomy coverage pass — Microsoft Purview is a real, distinct,
  // employer-attributed governance product for this candidate; previously collapsed into "Azure".
  { canonical: "Microsoft Purview", category: "Governance", aliases: ["microsoft purview", "purview"] },
  { canonical: "Unity Catalog", category: "Governance", aliases: ["unity catalog"] },
  { canonical: "Data Quality", category: "Governance", aliases: ["data quality", "data validation"] },
  // Security
  { canonical: "IAM", category: "Security", aliases: ["iam", "identity and access management"] },
  { canonical: "SOC 2", category: "Security", aliases: ["soc 2", "soc2"] },
  // Added during Phase 2 real-data taxonomy coverage pass — RBAC/Managed Identity/Service Principal
  // are real, distinct, employer-attributed Azure security/IAM concepts for this candidate;
  // Key Vault was previously collapsing into generic "Azure".
  { canonical: "Azure Key Vault", category: "Security", aliases: ["azure key vault", "key vault"] },
  { canonical: "RBAC", category: "Security", aliases: ["role-based access control", "rbac"] },
  { canonical: "Managed Identity", category: "Security", aliases: ["managed identity"] },
  { canonical: "Service Principal", category: "Security", aliases: ["service principal"] },
  // Monitoring
  { canonical: "Datadog", category: "Monitoring", aliases: ["datadog"] },
  { canonical: "Prometheus", category: "Monitoring", aliases: ["prometheus"] },
  { canonical: "Grafana", category: "Monitoring", aliases: ["grafana"] },
  { canonical: "CloudWatch", category: "Monitoring", aliases: ["cloudwatch"] },
  // Testing
  { canonical: "Pytest", category: "Testing", aliases: ["pytest"] },
  { canonical: "Selenium", category: "Testing", aliases: ["selenium"] },
];
