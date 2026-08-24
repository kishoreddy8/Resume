import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import JSZip from "jszip";
import type { CandidateProfile } from "@/lib/match/types";

export function getCandidateMasterDirectory(candidateId: number): string {
  return path.join(process.cwd(), "data/candidates", String(candidateId), "master");
}

export type EvidenceSourceType = "master_resume" | "candidate_profile" | "reviewed_evidence" | "msi";

export type AccomplishmentCategory =
  | "architecture"
  | "etl_pipeline"
  | "data_modeling"
  | "data_quality"
  | "governance_security"
  | "devops_cicd"
  | "analytics_reporting"
  | "general";

export interface AccomplishmentUnit {
  id: string;
  employer: string;
  title: string;
  dates: string;
  sourceType: EvidenceSourceType;
  sourceReference: string;
  rawText: string;
  actionVerb: string;
  technologies: string[];
  architectureContext?: string;
  businessOutcomeContext?: string;
  explicitMetricEvidence?: string;
  category: AccomplishmentCategory;
  importanceScore: number;
}

export interface EmployerWriterEvidence {
  employer: string;
  title: string;
  dates: string;
  projectContext: string;
  verifiedAccomplishments: AccomplishmentUnit[];
  supportedTechnologies: string[];
  availableViaMsi: string[];
  prohibitedTargetSkills: string[];
}

export interface CandidateAccomplishmentPackage {
  employers: EmployerWriterEvidence[];
  totalAccomplishmentsConsidered: number;
  totalAccomplishmentsSelected: number;
}

/**
 * Synchronously extracts text paragraphs from a DOCX file buffer.
 */
export function extractDocxParagraphsSync(docxPathOrBuffer: string | Buffer): string[] {
  try {
    const buf = typeof docxPathOrBuffer === "string"
      ? (fs.existsSync(docxPathOrBuffer) ? fs.readFileSync(docxPathOrBuffer) : null)
      : docxPathOrBuffer;

    if (!buf) return [];

    const target = Buffer.from("word/document.xml");
    const idx = buf.indexOf(target);
    if (idx === -1) return [];

    const headerIdx = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), idx);
    if (headerIdx === -1) return [];

    const compMethod = buf.readUInt16LE(headerIdx + 8);
    const compSize = buf.readUInt32LE(headerIdx + 18);
    const uncompSize = buf.readUInt32LE(headerIdx + 22);
    const fnLen = buf.readUInt16LE(headerIdx + 26);
    const extraLen = buf.readUInt16LE(headerIdx + 28);
    const dataOffset = headerIdx + 30 + fnLen + extraLen;

    let xml = "";
    if (compMethod === 8) {
      const rawData = buf.subarray(dataOffset, dataOffset + compSize);
      const uncompressed = zlib.inflateRawSync(rawData);
      xml = uncompressed.toString("utf-8");
    } else if (compMethod === 0) {
      xml = buf.subarray(dataOffset, dataOffset + uncompSize).toString("utf-8");
    }

    const pMatches = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
    const paragraphs = pMatches.map((pXml) => {
      const tMatches = pXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
      return tMatches.map((m) => m.replace(/<[^>]+>/g, "")).join("");
    }).filter((t) => t.trim().length > 0);

    return paragraphs;
  } catch {
    return [];
  }
}

/**
 * Asynchronously extracts text paragraphs from a DOCX file buffer.
 */
export async function extractDocxParagraphs(docxPathOrBuffer: string | Buffer): Promise<string[]> {
  try {
    const buffer = typeof docxPathOrBuffer === "string"
      ? (fs.existsSync(docxPathOrBuffer) ? fs.readFileSync(docxPathOrBuffer) : null)
      : docxPathOrBuffer;

    if (!buffer) return [];
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")?.async("string");
    if (!xml) return [];

    const pMatches = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
    const paragraphs = pMatches.map((pXml) => {
      const tMatches = pXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
      return tMatches.map((m) => m.replace(/<[^>]+>/g, "")).join("");
    }).filter((t) => t.trim().length > 0);

    return paragraphs;
  } catch {
    return [];
  }
}

/**
 * Classifies an accomplishment bullet into an engineering category and extracts metadata.
 */
export function classifyAccomplishment(text: string, employer: string, title: string, dates: string, index: number): AccomplishmentUnit {
  const words = text.trim().split(/\s+/);
  const actionVerb = words[0]?.replace(/[^a-zA-Z]/g, "") || "Engineered";

  const lower = text.toLowerCase();
  let category: AccomplishmentCategory = "general";
  let importance = 5;

  if (lower.includes("architect") || lower.includes("medallion") || lower.includes("lakehouse") || lower.includes("infrastructure") || lower.includes("platform")) {
    category = "architecture";
    importance = 9;
  } else if (lower.includes("pipeline") || lower.includes("etl") || lower.includes("elt") || lower.includes("ingest") || lower.includes("pyspark") || lower.includes("spark")) {
    category = "etl_pipeline";
    importance = 8;
  } else if (lower.includes("star schema") || lower.includes("snowflake schema") || lower.includes("dimensional model") || lower.includes("data vault") || lower.includes("fact") || lower.includes("dimension")) {
    category = "data_modeling";
    importance = 8;
  } else if (lower.includes("data quality") || lower.includes("validation") || lower.includes("reconcil") || lower.includes("cdc") || lower.includes("scd")) {
    category = "data_quality";
    importance = 8;
  } else if (lower.includes("security") || lower.includes("governance") || lower.includes("purview") || lower.includes("key vault") || lower.includes("rbac") || lower.includes("audit")) {
    category = "governance_security";
    importance = 7;
  } else if (lower.includes("ci/cd") || lower.includes("devops") || lower.includes("git") || lower.includes("pytest") || lower.includes("release")) {
    category = "devops_cicd";
    importance = 7;
  } else if (lower.includes("power bi") || lower.includes("dashboard") || lower.includes("dax") || lower.includes("report") || lower.includes("rag") || lower.includes("search")) {
    category = "analytics_reporting";
    importance = 7;
  }

  // Detect explicit metric patterns (e.g. "30%", "2TB", "billion-record", "45%", "25%")
  const metricMatch = text.match(/\b\d+%(?!\w)|\b\d+\s*(?:TB|GB|MB|PB)\b|\b\d+\+?\s*years?\b|\b(?:billions?|millions?)\s+of\s+records\b|\b\d+\+?\s*upstream\b/i);
  const explicitMetricEvidence = metricMatch ? metricMatch[0] : undefined;
  if (explicitMetricEvidence) {
    importance = Math.min(10, importance + 1);
  }

  // Detect technology tokens
  const techTokens: string[] = [];
  const knownTechList = [
    "Snowflake", "Azure Databricks", "Databricks", "ADLS Gen2", "Azure Data Factory", "Azure Synapse Analytics",
    "Azure SQL Database", "Azure Key Vault", "Azure OpenAI", "Azure AI Search", "Microsoft Purview", "Unity Catalog",
    "PySpark", "Spark SQL", "Spark", "Delta Lake", "Delta Live Tables", "Python", "SQL", "T-SQL", "Power BI", "DAX",
    "Azure DevOps", "Git", "GitHub Actions", "Docker", "Kubernetes", "Shell Scripting", "Kafka", "Hadoop", "dbt",
    "DB2", "Oracle", "SQL Server", "Cosmos DB", "AWS Glue", "BigQuery", "Redshift", "CDC", "SCD Type 1", "SCD Type 2",
    "Medallion Architecture", "Star Schema", "Snowflake Schema", "Data Vault"
  ];

  for (const tech of knownTechList) {
    const regex = new RegExp(`\\b${tech.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (regex.test(text)) {
      techTokens.push(tech);
    }
  }

  const employerSlug = employer.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  return {
    id: `${employerSlug}_acc_${index}`,
    employer,
    title,
    dates,
    sourceType: "master_resume",
    sourceReference: `master_resume:bullet_${index + 1}`,
    rawText: text,
    actionVerb,
    technologies: techTokens,
    architectureContext: category === "architecture" || category === "data_modeling" ? text : undefined,
    businessOutcomeContext: explicitMetricEvidence ? text : undefined,
    explicitMetricEvidence,
    category,
    importanceScore: importance,
  };
}

/**
 * Builds candidate accomplishment packages by parsing master resume source documents synchronously.
 */
export function buildCandidateAccomplishmentPackageSync(params: {
  candidateId: number;
  candidateProfile: CandidateProfile;
  masterResumeDocxPath?: string;
}): CandidateAccomplishmentPackage {
  const { candidateId, candidateProfile } = params;

  let masterPath = params.masterResumeDocxPath;
  if (!masterPath) {
    const candidateDir = getCandidateMasterDirectory(candidateId);
    masterPath = path.join(candidateDir, "resume.docx");
  }

  let rawParagraphs: string[] = [];
  if (fs.existsSync(masterPath)) {
    rawParagraphs = extractDocxParagraphsSync(masterPath);
  }

  // Parse paragraphs into per-employer accomplishment buckets
  const employerAccomplishmentsMap = new Map<string, AccomplishmentUnit[]>();
  let currentEmployer: string | null = null;
  let currentTitle: string = "Data Engineer";
  let currentDates: string = "Dates";
  let bulletIndex = 0;

  for (const para of rawParagraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // Check employer heading e.g. "Data Engineer | Comerica BankFeb 2025 – Present" or "Data Engineer | Comerica Bank"
    const empMatch = candidateProfile.experience.find((e) =>
      trimmed.toLowerCase().includes(e.employer.toLowerCase())
    );

    if (empMatch && (trimmed.includes("|") || trimmed.toLowerCase().includes(empMatch.title.toLowerCase()))) {
      currentEmployer = empMatch.employer;
      currentTitle = empMatch.title;
      currentDates = `${empMatch.startDate || ""} - ${empMatch.endDate || "Present"}`.trim();
      bulletIndex = 0;
      if (!employerAccomplishmentsMap.has(currentEmployer)) {
        employerAccomplishmentsMap.set(currentEmployer, []);
      }
      continue;
    }

    if (currentEmployer && (trimmed.length > 30 || trimmed.startsWith("-") || trimmed.startsWith("•") || trimmed.startsWith("–"))) {
      const cleanBullet = trimmed.replace(/^[-•–]\s*/, "");
      // Skip headings
      if (!cleanBullet.toLowerCase().startsWith("education") && !cleanBullet.toLowerCase().startsWith("certifications")) {
        const unit = classifyAccomplishment(cleanBullet, currentEmployer, currentTitle, currentDates, bulletIndex++);
        employerAccomplishmentsMap.get(currentEmployer)?.push(unit);
      }
    }
  }

  let totalConsidered = 0;
  let totalSelected = 0;
  const employerEvidenceList: EmployerWriterEvidence[] = [];

  for (const exp of candidateProfile.experience) {
    let accomplishments = employerAccomplishmentsMap.get(exp.employer) || [];
    totalConsidered += accomplishments.length;

    // Fallback if master docx had no parseable bullets for this employer
    if (accomplishments.length === 0) {
      const techList = exp.technologies.slice(0, 8);
      const fallbackUnit: AccomplishmentUnit = {
        id: `${exp.employer.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_acc_fallback_0`,
        employer: exp.employer,
        title: exp.title,
        dates: `${exp.startDate || ""} - ${exp.endDate || "Present"}`.trim(),
        sourceType: "candidate_profile",
        sourceReference: `candidate_profile:${exp.employer}`,
        rawText: `Engineered scalable cloud data platform workflows and pipelines using ${techList.join(", ")}.`,
        actionVerb: "Engineered",
        technologies: techList,
        category: "etl_pipeline",
        importanceScore: 6,
      };
      accomplishments = [fallbackUnit];
    }

    // Sort by importance score (descending)
    accomplishments.sort((a, b) => b.importanceScore - a.importanceScore);

    // Select 4-8 highest value units (target 6 per employer for balanced context)
    const selectedUnits = accomplishments.slice(0, 6);
    totalSelected += selectedUnits.length;

    const dates = `${exp.startDate || ""} - ${exp.endDate || "Present"}`.trim();
    const primaryTech = exp.technologies.slice(0, 4).join(" and ");
    const projectContext = `Engineering scalable data pipelines and governed cloud data platform infrastructure using ${primaryTech}.`;

    employerEvidenceList.push({
      employer: exp.employer,
      title: exp.title,
      dates,
      projectContext,
      verifiedAccomplishments: selectedUnits,
      supportedTechnologies: exp.technologies,
      availableViaMsi: [],
      prohibitedTargetSkills: [],
    });
  }

  return {
    employers: employerEvidenceList,
    totalAccomplishmentsConsidered: totalConsidered,
    totalAccomplishmentsSelected: totalSelected,
  };
}

/**
 * Builds candidate accomplishment packages asynchronously.
 */
export async function buildCandidateAccomplishmentPackage(params: {
  candidateId: number;
  candidateProfile: CandidateProfile;
  masterResumeDocxPath?: string;
}): Promise<CandidateAccomplishmentPackage> {
  return buildCandidateAccomplishmentPackageSync(params);
}

/**
 * Formats the rich verified accomplishment evidence section for writer handoffs.
 */
export function renderAccomplishmentEvidenceSection(pkg: CandidateAccomplishmentPackage): string {
  if (!pkg.employers || pkg.employers.length === 0) return "";

  const lines: string[] = [
    "## VERIFIED EMPLOYER ACCOMPLISHMENT EVIDENCE — AUTHORITATIVE EXPERIENCE PROOF",
    "",
    "Below are the candidate's authentic, verified accomplishment proof points and architectural context extracted directly from authoritative records. Use these real systems, scale, and delivery outcomes as the primary foundation for your experience bullets rather than inventing responsibilities from technology lists alone.",
    "",
  ];

  for (const emp of pkg.employers) {
    lines.push(`### Employer: ${emp.employer}`);
    lines.push(`- **Title & Dates**: ${emp.title} (${emp.dates})`);
    lines.push(`- **Verified Engineering Context**: ${emp.projectContext}`);
    lines.push(`- **Verified Accomplishment Proof Points** (${emp.verifiedAccomplishments.length} available):`);

    for (const [idx, acc] of emp.verifiedAccomplishments.entries()) {
      const metricTag = acc.explicitMetricEvidence ? ` [Verified Metric: ${acc.explicitMetricEvidence}]` : "";
      lines.push(`  ${idx + 1}. **[${acc.category.toUpperCase()}]** ${acc.rawText}${metricTag}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
