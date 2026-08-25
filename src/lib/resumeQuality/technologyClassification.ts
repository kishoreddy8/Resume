import { resolveSkillForReview } from "./reviewers/skillAliases";

export type CloudAffiliation = "AWS" | "AZURE" | "GCP" | "MULTI_CLOUD" | "CLOUD_NEUTRAL";

export type TechnologyCategory =
  | "ORCHESTRATION"
  | "STORAGE"
  | "WAREHOUSE"
  | "PROCESSING_ENGINE"
  | "DATABASE"
  | "STREAMING"
  | "SERVERLESS"
  | "KUBERNETES"
  | "DEVOPS"
  | "SECRETS_SECURITY"
  | "MONITORING"
  | "DATA_MODELING"
  | "DATA_QUALITY"
  | "GOVERNANCE"
  | "LANGUAGE"
  | "ANALYTICS_BI";

export interface TechnologyClassificationEntry {
  canonical: string;
  category: TechnologyCategory;
  cloud: CloudAffiliation;
  family?: string;
  aliases: string[];
}

/**
 * Authoritative capability-equivalence registry for data engineering service families.
 * Maps equivalent services across major cloud ecosystems and neutral platforms.
 */
export interface ServiceEquivalenceFamily {
  familyId: string;
  category: TechnologyCategory;
  description: string;
  aws?: string[];
  azure?: string[];
  gcp?: string[];
  neutral?: string[];
}

export const SERVICE_EQUIVALENCE_FAMILIES: ServiceEquivalenceFamily[] = [
  {
    familyId: "ETL_ORCHESTRATION",
    category: "ORCHESTRATION",
    description: "Data pipeline ingestion, workflow scheduling, and ETL/ELT orchestration",
    aws: ["AWS Glue", "AWS Step Functions", "Amazon Managed Workflows for Apache Airflow"],
    azure: ["Azure Data Factory", "Azure Synapse Pipelines", "Microsoft Fabric"],
    gcp: ["Cloud Data Fusion", "Cloud Composer", "Cloud Workflows"],
    neutral: ["Airflow", "dbt", "Prefect", "Dagster"],
  },
  {
    familyId: "OBJECT_STORAGE",
    category: "STORAGE",
    description: "Cloud object and lake storage layers",
    aws: ["Amazon S3", "AWS Lake Formation"],
    azure: ["ADLS Gen2", "Azure Blob Storage"],
    gcp: ["Google Cloud Storage"],
    neutral: ["MinIO", "Ceph"],
  },
  {
    familyId: "ANALYTIC_WAREHOUSE",
    category: "WAREHOUSE",
    description: "Cloud data warehouses and OLAP analytical query engines",
    aws: ["Amazon Redshift", "Amazon Athena"],
    azure: ["Azure Synapse Analytics", "Azure SQL Data Warehouse"],
    gcp: ["BigQuery"],
    neutral: ["Snowflake", "Databricks SQL", "ClickHouse", "DuckDB", "Trino", "Presto"],
  },
  {
    familyId: "DISTRIBUTED_PROCESSING",
    category: "PROCESSING_ENGINE",
    description: "Large-scale distributed Spark and data computation engines",
    aws: ["EMR", "AWS Glue Spark"],
    azure: ["Azure Databricks", "Synapse Spark", "HDInsight"],
    gcp: ["Dataproc", "Dataflow"],
    neutral: ["Databricks", "Apache Spark", "Spark", "PySpark", "Delta Lake", "Hadoop"],
  },
  {
    familyId: "STREAMING_INGESTION",
    category: "STREAMING",
    description: "Real-time event streaming and message queuing",
    aws: ["Amazon Kinesis", "Amazon MSK"],
    azure: ["Azure Event Hubs", "Azure Service Bus"],
    gcp: ["Google Cloud Pub/Sub"],
    neutral: ["Apache Kafka", "Kafka", "RabbitMQ", "Flink", "Spark Streaming"],
  },
  {
    familyId: "SERVERLESS_COMPUTE",
    category: "SERVERLESS",
    description: "Event-driven serverless functions and lightweight execution",
    aws: ["AWS Lambda", "AWS Fargate"],
    azure: ["Azure Functions", "Azure Container Instances"],
    gcp: ["Google Cloud Functions", "Cloud Run"],
    neutral: ["Docker", "Kubernetes"],
  },
  {
    familyId: "CONTAINER_ORCHESTRATION",
    category: "KUBERNETES",
    description: "Managed Kubernetes and container orchestration",
    aws: ["Amazon EKS", "AWS ECS"],
    azure: ["Azure Kubernetes Service", "AKS"],
    gcp: ["Google Kubernetes Engine", "GKE"],
    neutral: ["Kubernetes", "Docker", "Docker Swarm"],
  },
  {
    familyId: "SECRETS_MANAGEMENT",
    category: "SECRETS_SECURITY",
    description: "Secrets, cryptographic key vaults, and credential management",
    aws: ["AWS Secrets Manager", "AWS KMS", "AWS IAM"],
    azure: ["Azure Key Vault", "Azure Active Directory", "Microsoft Entra ID"],
    gcp: ["Google Secret Manager", "Google Cloud KMS", "Cloud IAM"],
    neutral: ["HashiCorp Vault"],
  },
  {
    familyId: "OBSERVABILITY_MONITORING",
    category: "MONITORING",
    description: "Metrics, log aggregation, and pipeline observability",
    aws: ["Amazon CloudWatch", "AWS CloudTrail"],
    azure: ["Azure Monitor", "Log Analytics", "Application Insights"],
    gcp: ["Google Cloud Monitoring", "Cloud Logging"],
    neutral: ["Prometheus", "Grafana", "Datadog", "Splunk", "ELK Stack"],
  },
  {
    familyId: "CI_CD_PLATFORMS",
    category: "DEVOPS",
    description: "Automated build, test, infrastructure-as-code, and release pipelines",
    aws: ["AWS CodePipeline", "AWS CodeBuild"],
    azure: ["Azure DevOps", "Azure Pipelines"],
    gcp: ["Google Cloud Build"],
    neutral: ["GitHub Actions", "GitLab CI", "Jenkins", "Terraform", "Git"],
  },
];

/**
 * Standard registry of classified technologies.
 */
export const CLASSIFIED_TECHNOLOGY_REGISTRY: TechnologyClassificationEntry[] = [
  // AWS
  { canonical: "AWS Glue", category: "ORCHESTRATION", cloud: "AWS", family: "ETL_ORCHESTRATION", aliases: ["glue", "aws glue"] },
  { canonical: "Amazon S3", category: "STORAGE", cloud: "AWS", family: "OBJECT_STORAGE", aliases: ["s3", "amazon s3", "aws s3"] },
  { canonical: "Amazon Redshift", category: "WAREHOUSE", cloud: "AWS", family: "ANALYTIC_WAREHOUSE", aliases: ["redshift", "amazon redshift", "aws redshift"] },
  { canonical: "Amazon Athena", category: "WAREHOUSE", cloud: "AWS", family: "ANALYTIC_WAREHOUSE", aliases: ["athena", "amazon athena"] },
  { canonical: "EMR", category: "PROCESSING_ENGINE", cloud: "AWS", family: "DISTRIBUTED_PROCESSING", aliases: ["emr", "amazon emr", "elastic mapreduce"] },
  { canonical: "AWS Lambda", category: "SERVERLESS", cloud: "AWS", family: "SERVERLESS_COMPUTE", aliases: ["lambda", "aws lambda"] },
  { canonical: "Amazon Kinesis", category: "STREAMING", cloud: "AWS", family: "STREAMING_INGESTION", aliases: ["kinesis", "amazon kinesis", "aws kinesis"] },
  { canonical: "Amazon EKS", category: "KUBERNETES", cloud: "AWS", family: "CONTAINER_ORCHESTRATION", aliases: ["eks", "amazon eks", "elastic kubernetes service"] },
  { canonical: "Amazon CloudWatch", category: "MONITORING", cloud: "AWS", family: "OBSERVABILITY_MONITORING", aliases: ["cloudwatch", "amazon cloudwatch"] },
  { canonical: "AWS Secrets Manager", category: "SECRETS_SECURITY", cloud: "AWS", family: "SECRETS_MANAGEMENT", aliases: ["aws secrets manager", "secrets manager"] },
  { canonical: "AWS IAM", category: "SECRETS_SECURITY", cloud: "AWS", family: "SECRETS_MANAGEMENT", aliases: ["iam", "aws iam"] },
  { canonical: "AWS Step Functions", category: "ORCHESTRATION", cloud: "AWS", family: "ETL_ORCHESTRATION", aliases: ["step functions", "aws step functions"] },
  { canonical: "DynamoDB", category: "DATABASE", cloud: "AWS", aliases: ["dynamodb", "amazon dynamodb"] },
  { canonical: "Amazon RDS", category: "DATABASE", cloud: "AWS", aliases: ["rds", "amazon rds"] },
  { canonical: "Amazon Aurora", category: "DATABASE", cloud: "AWS", aliases: ["aurora", "amazon aurora"] },
  { canonical: "AWS", category: "DEVOPS", cloud: "AWS", aliases: ["aws", "amazon web services"] },

  // Azure
  { canonical: "Azure Data Factory", category: "ORCHESTRATION", cloud: "AZURE", family: "ETL_ORCHESTRATION", aliases: ["adf", "azure data factory", "data factory"] },
  // PHASE 8.2 — "azure data lake" (no "Storage") added: the live Phase 8.1 repair wrote exactly
  // "a single governed Azure Data Lake" and no alias matched it, so the summary drift went unseen.
  { canonical: "ADLS Gen2", category: "STORAGE", cloud: "AZURE", family: "OBJECT_STORAGE", aliases: ["adls", "adls gen2", "azure data lake", "azure data lake storage", "azure data lake storage gen2"] },
  { canonical: "Azure Synapse Analytics", category: "WAREHOUSE", cloud: "AZURE", family: "ANALYTIC_WAREHOUSE", aliases: ["synapse", "azure synapse", "azure synapse analytics", "synapse analytics"] },
  { canonical: "Azure Databricks", category: "PROCESSING_ENGINE", cloud: "AZURE", family: "DISTRIBUTED_PROCESSING", aliases: ["azure databricks"] },
  { canonical: "Azure Functions", category: "SERVERLESS", cloud: "AZURE", family: "SERVERLESS_COMPUTE", aliases: ["azure functions", "azure function"] },
  { canonical: "Azure Event Hubs", category: "STREAMING", cloud: "AZURE", family: "STREAMING_INGESTION", aliases: ["event hubs", "azure event hubs"] },
  { canonical: "Azure Kubernetes Service", category: "KUBERNETES", cloud: "AZURE", family: "CONTAINER_ORCHESTRATION", aliases: ["aks", "azure kubernetes service"] },
  { canonical: "Azure Key Vault", category: "SECRETS_SECURITY", cloud: "AZURE", family: "SECRETS_MANAGEMENT", aliases: ["azure key vault", "key vault"] },
  { canonical: "Azure Monitor", category: "MONITORING", cloud: "AZURE", family: "OBSERVABILITY_MONITORING", aliases: ["azure monitor", "log analytics"] },
  { canonical: "Azure DevOps", category: "DEVOPS", cloud: "AZURE", family: "CI_CD_PLATFORMS", aliases: ["azure devops", "azure pipelines", "vsts"] },
  { canonical: "Azure SQL", category: "DATABASE", cloud: "AZURE", aliases: ["azure sql", "azure sql database"] },
  { canonical: "Cosmos DB", category: "DATABASE", cloud: "AZURE", aliases: ["cosmos db", "azure cosmos db"] },
  { canonical: "Microsoft Fabric", category: "ORCHESTRATION", cloud: "AZURE", family: "ETL_ORCHESTRATION", aliases: ["fabric", "microsoft fabric", "fabric pipelines"] },
  { canonical: "Azure", category: "DEVOPS", cloud: "AZURE", aliases: ["azure", "microsoft azure"] },

  // GCP
  { canonical: "BigQuery", category: "WAREHOUSE", cloud: "GCP", family: "ANALYTIC_WAREHOUSE", aliases: ["bigquery", "google bigquery", "gbq"] },
  { canonical: "Cloud Data Fusion", category: "ORCHESTRATION", cloud: "GCP", family: "ETL_ORCHESTRATION", aliases: ["data fusion", "cloud data fusion", "google cloud data fusion"] },
  { canonical: "Google Cloud Storage", category: "STORAGE", cloud: "GCP", family: "OBJECT_STORAGE", aliases: ["gcs", "google cloud storage"] },
  { canonical: "Dataproc", category: "PROCESSING_ENGINE", cloud: "GCP", family: "DISTRIBUTED_PROCESSING", aliases: ["dataproc", "google dataproc", "cloud dataproc"] },
  { canonical: "Dataflow", category: "PROCESSING_ENGINE", cloud: "GCP", family: "DISTRIBUTED_PROCESSING", aliases: ["dataflow", "google dataflow", "cloud dataflow"] },
  { canonical: "Cloud Composer", category: "ORCHESTRATION", cloud: "GCP", family: "ETL_ORCHESTRATION", aliases: ["cloud composer", "google cloud composer"] },
  { canonical: "Google Cloud Pub/Sub", category: "STREAMING", cloud: "GCP", family: "STREAMING_INGESTION", aliases: ["pub/sub", "google pub/sub", "cloud pub/sub", "pubsub"] },
  { canonical: "Google Cloud Functions", category: "SERVERLESS", cloud: "GCP", family: "SERVERLESS_COMPUTE", aliases: ["cloud functions", "google cloud functions"] },
  { canonical: "Google Kubernetes Engine", category: "KUBERNETES", cloud: "GCP", family: "CONTAINER_ORCHESTRATION", aliases: ["gke", "google kubernetes engine"] },
  { canonical: "Google Secret Manager", category: "SECRETS_SECURITY", cloud: "GCP", family: "SECRETS_MANAGEMENT", aliases: ["secret manager", "google secret manager"] },
  { canonical: "Google Cloud Monitoring", category: "MONITORING", cloud: "GCP", family: "OBSERVABILITY_MONITORING", aliases: ["cloud monitoring", "google cloud monitoring"] },
  { canonical: "Cloud Spanner", category: "DATABASE", cloud: "GCP", aliases: ["cloud spanner", "spanner"] },
  { canonical: "Cloud SQL", category: "DATABASE", cloud: "GCP", aliases: ["cloud sql"] },
  { canonical: "GCP", category: "DEVOPS", cloud: "GCP", aliases: ["gcp", "google cloud platform", "google cloud"] },

  // Cloud-Neutral / Multi-Cloud Platforms
  { canonical: "Databricks", category: "PROCESSING_ENGINE", cloud: "CLOUD_NEUTRAL", family: "DISTRIBUTED_PROCESSING", aliases: ["databricks"] },
  { canonical: "Snowflake", category: "WAREHOUSE", cloud: "CLOUD_NEUTRAL", family: "ANALYTIC_WAREHOUSE", aliases: ["snowflake", "snowflake data cloud"] },
  { canonical: "PySpark", category: "PROCESSING_ENGINE", cloud: "CLOUD_NEUTRAL", family: "DISTRIBUTED_PROCESSING", aliases: ["pyspark"] },
  { canonical: "Apache Spark", category: "PROCESSING_ENGINE", cloud: "CLOUD_NEUTRAL", family: "DISTRIBUTED_PROCESSING", aliases: ["spark", "apache spark"] },
  { canonical: "Delta Lake", category: "STORAGE", cloud: "CLOUD_NEUTRAL", aliases: ["delta lake", "delta tables", "delta"] },
  { canonical: "dbt", category: "ORCHESTRATION", cloud: "CLOUD_NEUTRAL", aliases: ["dbt", "dbt core", "dbt cloud"] },
  { canonical: "Airflow", category: "ORCHESTRATION", cloud: "CLOUD_NEUTRAL", family: "ETL_ORCHESTRATION", aliases: ["airflow", "apache airflow"] },
  { canonical: "Apache Kafka", category: "STREAMING", cloud: "CLOUD_NEUTRAL", family: "STREAMING_INGESTION", aliases: ["kafka", "apache kafka"] },
  { canonical: "Python", category: "LANGUAGE", cloud: "CLOUD_NEUTRAL", aliases: ["python"] },
  { canonical: "SQL", category: "LANGUAGE", cloud: "CLOUD_NEUTRAL", aliases: ["sql"] },
  { canonical: "Scala", category: "LANGUAGE", cloud: "CLOUD_NEUTRAL", aliases: ["scala"] },
  { canonical: "Java", category: "LANGUAGE", cloud: "CLOUD_NEUTRAL", aliases: ["java"] },
  { canonical: "PostgreSQL", category: "DATABASE", cloud: "CLOUD_NEUTRAL", aliases: ["postgresql", "postgres"] },
  { canonical: "MySQL", category: "DATABASE", cloud: "CLOUD_NEUTRAL", aliases: ["mysql"] },
  { canonical: "SQL Server", category: "DATABASE", cloud: "CLOUD_NEUTRAL", aliases: ["sql server", "mssql", "microsoft sql server"] },
  { canonical: "Oracle", category: "DATABASE", cloud: "CLOUD_NEUTRAL", aliases: ["oracle", "oracle database"] },
  { canonical: "MongoDB", category: "DATABASE", cloud: "CLOUD_NEUTRAL", aliases: ["mongodb"] },
  { canonical: "Redis", category: "DATABASE", cloud: "CLOUD_NEUTRAL", aliases: ["redis"] },
  { canonical: "Cassandra", category: "DATABASE", cloud: "CLOUD_NEUTRAL", aliases: ["cassandra", "apache cassandra"] },
  { canonical: "Hadoop", category: "PROCESSING_ENGINE", cloud: "CLOUD_NEUTRAL", aliases: ["hadoop", "apache hadoop"] },
  { canonical: "Hive", category: "WAREHOUSE", cloud: "CLOUD_NEUTRAL", aliases: ["hive", "apache hive"] },
  { canonical: "Docker", category: "DEVOPS", cloud: "CLOUD_NEUTRAL", aliases: ["docker"] },
  { canonical: "Kubernetes", category: "KUBERNETES", cloud: "CLOUD_NEUTRAL", aliases: ["kubernetes", "k8s"] },
  { canonical: "Terraform", category: "DEVOPS", cloud: "CLOUD_NEUTRAL", aliases: ["terraform"] },
  { canonical: "Git", category: "DEVOPS", cloud: "CLOUD_NEUTRAL", aliases: ["git"] },
  { canonical: "GitHub Actions", category: "DEVOPS", cloud: "CLOUD_NEUTRAL", family: "CI_CD_PLATFORMS", aliases: ["github actions"] },
  { canonical: "GitLab CI", category: "DEVOPS", cloud: "CLOUD_NEUTRAL", family: "CI_CD_PLATFORMS", aliases: ["gitlab ci", "gitlab"] },
  { canonical: "Jenkins", category: "DEVOPS", cloud: "CLOUD_NEUTRAL", family: "CI_CD_PLATFORMS", aliases: ["jenkins"] },
  { canonical: "CI/CD", category: "DEVOPS", cloud: "CLOUD_NEUTRAL", aliases: ["ci/cd", "ci cd", "continuous integration"] },
  { canonical: "CDC", category: "DATA_MODELING", cloud: "CLOUD_NEUTRAL", aliases: ["cdc", "change data capture"] },
  { canonical: "SCD Type 2", category: "DATA_MODELING", cloud: "CLOUD_NEUTRAL", aliases: ["scd type 2", "scd", "slowly changing dimensions"] },
  { canonical: "Dimensional Modeling", category: "DATA_MODELING", cloud: "CLOUD_NEUTRAL", aliases: ["dimensional modeling", "star schema", "data modeling"] },
  { canonical: "Data Quality", category: "DATA_QUALITY", cloud: "CLOUD_NEUTRAL", aliases: ["data quality", "great expectations", "data validation"] },
  { canonical: "Data Governance", category: "GOVERNANCE", cloud: "CLOUD_NEUTRAL", aliases: ["data governance", "governance", "data lineage"] },
  { canonical: "Power BI", category: "ANALYTICS_BI", cloud: "AZURE", aliases: ["power bi", "powerbi"] },
  { canonical: "Tableau", category: "ANALYTICS_BI", cloud: "CLOUD_NEUTRAL", aliases: ["tableau"] },
  { canonical: "Looker", category: "ANALYTICS_BI", cloud: "GCP", aliases: ["looker"] },
  { canonical: "QuickSight", category: "ANALYTICS_BI", cloud: "AWS", aliases: ["quicksight", "amazon quicksight"] },
];

/** Lookup map by normalized canonical or alias. */
const CLASSIFICATION_LOOKUP = new Map<string, TechnologyClassificationEntry>();
for (const entry of CLASSIFIED_TECHNOLOGY_REGISTRY) {
  CLASSIFICATION_LOOKUP.set(entry.canonical.toLowerCase(), entry);
  for (const alias of entry.aliases) {
    CLASSIFICATION_LOOKUP.set(alias.toLowerCase(), entry);
  }
}

/**
 * Classifies a technology string into its canonical entry, category, and cloud affiliation.
 */
export function classifyTechnology(tech: string): TechnologyClassificationEntry | null {
  if (!tech || tech.trim().length === 0) return null;
  const rawLower = tech.trim().toLowerCase();
  
  // Direct lookup in registry
  const direct = CLASSIFICATION_LOOKUP.get(rawLower);
  if (direct) return direct;

  // Try resolving via skillAliases
  const resolved = resolveSkillForReview(tech);
  if (resolved) {
    const canonicalLower = resolved.canonical.toLowerCase();
    const match = CLASSIFICATION_LOOKUP.get(canonicalLower);
    if (match) return match;

    // Fallback classification by category
    const cloud: CloudAffiliation =
      canonicalLower.includes("aws") || canonicalLower.includes("amazon")
        ? "AWS"
        : canonicalLower.includes("azure")
        ? "AZURE"
        : canonicalLower.includes("gcp") || canonicalLower.includes("google cloud")
        ? "GCP"
        : "CLOUD_NEUTRAL";

    return {
      canonical: resolved.canonical,
      category: "DATA_MODELING",
      cloud,
      aliases: [rawLower],
    };
  }

  return null;
}

/**
 * Checks if a technology is cloud-neutral or multi-cloud.
 */
export function isCloudNeutral(tech: string): boolean {
  const entry = classifyTechnology(tech);
  if (!entry) return true;
  return entry.cloud === "CLOUD_NEUTRAL" || entry.cloud === "MULTI_CLOUD";
}

/**
 * Gets equivalent technologies for a given technology in a target cloud ecosystem.
 */
export function getEquivalentTechnologies(tech: string, targetCloud: CloudAffiliation): string[] {
  const entry = classifyTechnology(tech);
  if (!entry || !entry.family) return [];

  const family = SERVICE_EQUIVALENCE_FAMILIES.find((f) => f.familyId === entry.family);
  if (!family) return [];

  if (targetCloud === "AWS") return family.aws ?? [];
  if (targetCloud === "AZURE") return family.azure ?? [];
  if (targetCloud === "GCP") return family.gcp ?? [];
  if (targetCloud === "CLOUD_NEUTRAL" || targetCloud === "MULTI_CLOUD") return family.neutral ?? [];

  return [];
}

/**
 * Checks a list of technologies for duplicate alias pairings (e.g. ['ADF', 'Azure Data Factory']).
 */
export function findAliasDuplicates(techList: string[]): Array<{ canonical: string; duplicates: string[] }> {
  const map = new Map<string, string[]>();
  for (const item of techList) {
    const entry = classifyTechnology(item);
    const canonical = entry?.canonical ?? item.trim();
    const existing = map.get(canonical) ?? [];
    existing.push(item);
    map.set(canonical, existing);
  }

  const results: Array<{ canonical: string; duplicates: string[] }> = [];
  for (const [canonical, items] of map.entries()) {
    if (items.length > 1) {
      results.push({ canonical, duplicates: items });
    }
  }
  return results;
}
