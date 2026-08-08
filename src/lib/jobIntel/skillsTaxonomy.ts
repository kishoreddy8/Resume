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
  // Cloud Platforms
  { canonical: "AWS", category: "Cloud Platforms", aliases: ["aws", "amazon web services"] },
  { canonical: "Azure", category: "Cloud Platforms", aliases: ["microsoft azure", "azure"] },
  { canonical: "GCP", category: "Cloud Platforms", aliases: ["gcp", "google cloud platform", "google cloud"] },
  // Data Engineering
  { canonical: "PySpark", category: "Data Engineering", aliases: ["pyspark"] },
  { canonical: "Spark", category: "Data Engineering", aliases: ["apache spark", "spark"] },
  { canonical: "Kafka", category: "Data Engineering", aliases: ["apache kafka", "kafka"] },
  { canonical: "dbt", category: "Data Engineering", aliases: ["dbt"] },
  { canonical: "Azure Data Factory", category: "Data Engineering", aliases: ["azure data factory"] },
  { canonical: "Hadoop", category: "Data Engineering", aliases: ["hadoop"] },
  // Big Data
  { canonical: "Hive", category: "Big Data", aliases: ["apache hive", "hive"] },
  // Warehousing
  { canonical: "Snowflake", category: "Warehousing", aliases: ["snowflake"] },
  { canonical: "Databricks", category: "Warehousing", aliases: ["databricks"] },
  { canonical: "Redshift", category: "Warehousing", aliases: ["amazon redshift", "redshift"] },
  { canonical: "BigQuery", category: "Warehousing", aliases: ["bigquery", "big query"] },
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
  // DevOps
  { canonical: "Docker", category: "DevOps", aliases: ["docker"] },
  { canonical: "Kubernetes", category: "DevOps", aliases: ["kubernetes", "k8s"] },
  { canonical: "Jenkins", category: "DevOps", aliases: ["jenkins"] },
  { canonical: "CI/CD", category: "DevOps", aliases: ["ci/cd", "ci-cd", "continuous integration"] },
  { canonical: "GitHub Actions", category: "DevOps", aliases: ["github actions"] },
  { canonical: "GitLab CI", category: "DevOps", aliases: ["gitlab ci"] },
  // Infrastructure
  { canonical: "Terraform", category: "Infrastructure", aliases: ["terraform"] },
  { canonical: "CloudFormation", category: "Infrastructure", aliases: ["cloudformation"] },
  { canonical: "Ansible", category: "Infrastructure", aliases: ["ansible"] },
  // BI / Reporting
  { canonical: "Power BI", category: "BI / Reporting", aliases: ["power bi", "powerbi"] },
  { canonical: "Tableau", category: "BI / Reporting", aliases: ["tableau"] },
  { canonical: "Looker", category: "BI / Reporting", aliases: ["looker"] },
  // APIs
  { canonical: "REST", category: "APIs", aliases: ["restful api", "rest api", "restful"] },
  { canonical: "GraphQL", category: "APIs", aliases: ["graphql"] },
  { canonical: "gRPC", category: "APIs", aliases: ["grpc"] },
  // Governance
  { canonical: "Data Governance", category: "Governance", aliases: ["data governance"] },
  { canonical: "Collibra", category: "Governance", aliases: ["collibra"] },
  // Security
  { canonical: "IAM", category: "Security", aliases: ["iam", "identity and access management"] },
  { canonical: "SOC 2", category: "Security", aliases: ["soc 2", "soc2"] },
  // Monitoring
  { canonical: "Datadog", category: "Monitoring", aliases: ["datadog"] },
  { canonical: "Prometheus", category: "Monitoring", aliases: ["prometheus"] },
  { canonical: "Grafana", category: "Monitoring", aliases: ["grafana"] },
  { canonical: "CloudWatch", category: "Monitoring", aliases: ["cloudwatch"] },
  // Testing
  { canonical: "Pytest", category: "Testing", aliases: ["pytest"] },
  { canonical: "Selenium", category: "Testing", aliases: ["selenium"] },
];
