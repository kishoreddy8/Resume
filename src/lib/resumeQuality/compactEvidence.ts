import type { AccomplishmentUnit, CandidateAccomplishmentPackage } from "./accomplishmentEvidence";
import { classifyTechnology, type TechnologyCategory } from "./technologyClassification";

/**
 * PHASE 6.6B — DETERMINISTIC EVIDENCE COMPACTION.
 *
 * CAREER-OPS TRUTH STORE != CLAUDE WRITER CONTEXT. This module never touches the authoritative
 * AccomplishmentUnit / CandidateAccomplishmentPackage the deterministic reviewer, MSI validation,
 * metric-provenance checks, and repair planning all continue to read (see accomplishmentEvidence.ts
 * — untouched by this module). It ONLY builds a compact, cloud/ecosystem-neutral PROJECTION of that
 * same authoritative evidence for the writer prompt specifically.
 *
 * Cloud/ecosystem neutrality: technology-to-pipeline-stage classification is delegated entirely to
 * technologyClassification.ts's classifyTechnology() — the SAME shared, already-battle-tested
 * registry architecturePalette.ts itself uses to build "Approved Sources/Ingestion/Storage/..." per
 * employer (Phase 6.1). Nothing here is Azure-specific, or hard-codes any particular cloud's pipeline
 * shape; an AWS, GCP, Snowflake-centered, Databricks-centered, or multi-cloud accomplishment
 * classifies through the exact same code path.
 *
 * Never invents a missing pipeline stage: a stage array is populated ONLY from technologies the
 * ORIGINAL AccomplishmentUnit.technologies already lists (itself extracted from verified master
 * resume text — see accomplishmentEvidence.ts). An accomplishment with no recognized orchestration
 * technology simply has an empty `orchestration` array and renders no orchestration arrow segment —
 * never a synthesized one.
 */

/** Pipeline-role buckets a technology's classifyTechnology() category maps into. "other" catches any
 *  technology classifyTechnology() cannot categorize into a pipeline-shape role (governance, DevOps,
 *  languages, BI, etc.) — NEVER silently dropped; still rendered, just outside the arrow chain. */
const CATEGORY_TO_STAGE: Partial<Record<TechnologyCategory, "source" | "orchestration" | "processing" | "storage" | "warehouse">> = {
  DATABASE: "source",
  STREAMING: "source",
  ORCHESTRATION: "orchestration",
  PROCESSING_ENGINE: "processing",
  SERVERLESS: "processing",
  KUBERNETES: "processing",
  STORAGE: "storage",
  WAREHOUSE: "warehouse",
};

/** Deterministic, curated capability tags — reuses AccomplishmentUnit's OWN already-validated
 *  `category` field (accomplishmentEvidence.ts's own keyword classifier) rather than extracting a new
 *  free-text capability phrase via regex/NLP, which would risk misrepresenting the accomplishment.
 *  "general" carries no distinguishing capability signal and is omitted rather than forcing a label. */
const CAPABILITY_LABELS: Record<AccomplishmentUnit["category"], string | null> = {
  architecture: "architecture design",
  etl_pipeline: "ETL/pipeline engineering",
  data_modeling: "data modeling",
  data_quality: "data quality",
  governance_security: "governance & security",
  devops_cicd: "CI/CD & DevOps",
  analytics_reporting: "analytics/reporting",
  general: null,
};

export interface CompactAccomplishmentOutcome {
  /** The exact matched metric substring, byte-for-byte from the original verified text (e.g. "30%",
   *  "2TB", "billions of records") — never rounded, reworded, or reformatted. */
  metric: string;
  /** What the metric measures, expressed as the metric's containing clause with ONLY the metric
   *  substring removed — every remaining word is verbatim, in its original order, from the same
   *  authoritative sentence. Concatenating `meaning` back around `metric` reconstructs the original
   *  clause exactly; nothing is inferred, summarized, or paraphrased. */
  meaning: string;
}

export interface CompactAccomplishmentEvidence {
  employer: string;
  /** Same stable id accomplishmentEvidence.ts already assigns (`{employerSlug}_acc_{index}`) — the
   *  SAME identifier jobEvidenceMapping.ts's proof-point pointers already reference, so provenance
   *  stays traceable end to end without inventing a second ID scheme. */
  evidenceId: string;
  source: string[];
  orchestration: string[];
  processing: string[];
  storage: string[];
  warehouse: string[];
  /** Technologies classifyTechnology() cannot place into a pipeline-shape role (governance/DevOps/
   *  languages/BI/etc.) — never dropped, just outside the arrow chain. */
  other: string[];
  /** From AccomplishmentUnit.category — see CAPABILITY_LABELS. Absent (not empty-string) when the
   *  category carries no distinguishing signal ("general"). */
  capability?: string;
  outcome?: CompactAccomplishmentOutcome;
}

/** Buckets one accomplishment's already-extracted, already-verified technology list into pipeline
 *  stages via the shared classifyTechnology() registry. Order-preserving and dedup-safe within each
 *  bucket; a technology classifyTechnology() cannot resolve at all is preserved in `other`, never
 *  dropped. */
/** PHASE 6.8 — exported for reuse by reviewers/repetitionChecks.ts, which needs the same
 *  technology-stage bucketing (source/orchestration/processing/storage/warehouse) to build a
 *  bullet's architecture-stage signature. Kept as one shared helper rather than a second copy of
 *  this stage-mapping logic. */
export function classifyTechnologiesIntoStages(technologies: string[]): Pick<CompactAccomplishmentEvidence, "source" | "orchestration" | "processing" | "storage" | "warehouse" | "other"> {
  const stages: Record<"source" | "orchestration" | "processing" | "storage" | "warehouse" | "other", string[]> = {
    source: [], orchestration: [], processing: [], storage: [], warehouse: [], other: [],
  };
  const seen = new Set<string>();
  for (const tech of technologies) {
    const entry = classifyTechnology(tech);
    const display = entry?.canonical ?? tech;
    const key = display.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const stage = entry ? CATEGORY_TO_STAGE[entry.category] : undefined;
    stages[stage ?? "other"].push(display);
  }
  return stages;
}

/** Extracts { metric, meaning } as described on CompactAccomplishmentOutcome — a bounded,
 *  verbatim-only operation over rawText, never a rewrite. Returns undefined when the unit carries no
 *  explicitMetricEvidence (never fabricates one). */
function extractOutcome(unit: AccomplishmentUnit): CompactAccomplishmentOutcome | undefined {
  const metric = unit.explicitMetricEvidence;
  if (!metric) return undefined;

  const text = unit.rawText;
  const idx = text.indexOf(metric);
  if (idx === -1) {
    // Defensive: the metric string should always be a literal substring of rawText (it was matched
    // FROM rawText in the first place) — if this ever isn't true, never guess at a meaning.
    return { metric, meaning: "" };
  }
  const metricEnd = idx + metric.length;

  // Clause boundaries: nearest preceding/following sentence- or clause-terminator, never crossing
  // into an adjacent, unrelated clause.
  const boundary = /[.,;]/;
  let clauseStart = 0;
  for (let i = idx - 1; i >= 0; i--) {
    if (boundary.test(text[i])) { clauseStart = i + 1; break; }
  }
  let clauseEnd = text.length;
  for (let i = metricEnd; i < text.length; i++) {
    if (boundary.test(text[i])) { clauseEnd = i; break; }
  }

  const before = text.slice(clauseStart, idx);
  const after = text.slice(metricEnd, clauseEnd);
  const meaning = (before + " " + after).replace(/\s+/g, " ").trim();
  return { metric, meaning };
}

/** The one deterministic transform: authoritative AccomplishmentUnit -> compact writer projection.
 *  Never invents a pipeline stage, never moves a metric, never changes employer ownership. */
export function buildCompactEvidence(unit: AccomplishmentUnit): CompactAccomplishmentEvidence {
  const stages = classifyTechnologiesIntoStages(unit.technologies);
  return {
    employer: unit.employer,
    evidenceId: unit.id,
    ...stages,
    capability: CAPABILITY_LABELS[unit.category] ?? undefined,
    outcome: extractOutcome(unit),
  };
}

/** Renders one compact evidence item as a single, dense, readable line — the "E1: SQL Server/
 *  PostgreSQL -> ADF -> ADLS Gen2 -> Databricks; metadata ingestion + CDC; batch runtime -30%" shape
 *  from the Phase 6.6B spec. Arrow segments appear ONLY for stages that have at least one technology
 *  — an accomplishment with no recognized orchestration tech renders no orchestration arrow segment,
 *  never a placeholder. */
export function renderCompactEvidenceLine(evidence: CompactAccomplishmentEvidence, label: string): string {
  const arrowParts: string[] = [];
  for (const bucket of [evidence.source, evidence.orchestration, evidence.processing, evidence.storage, evidence.warehouse]) {
    if (bucket.length > 0) arrowParts.push(bucket.join("/"));
  }
  const arrow = arrowParts.join(" -> ") || (evidence.other.length > 0 ? evidence.other.join("/") : "(no recognized technology stage)");

  const tail: string[] = [];
  if (evidence.other.length > 0 && arrowParts.length > 0) tail.push(evidence.other.join(", "));
  if (evidence.capability) tail.push(evidence.capability);
  if (evidence.outcome) tail.push(`${evidence.outcome.meaning} ${evidence.outcome.metric}`.trim());

  const tailText = tail.length > 0 ? `; ${tail.join("; ")}` : "";
  return `${label}: ${arrow}${tailText}`;
}

/**
 * PHASE 6.6B — the writer-facing compact projection, replacing renderAccomplishmentEvidenceSection's
 * full-prose rendering AT THE WRITER PROMPT SPECIFICALLY (see handoff/exporter.ts). The full-prose
 * renderer itself is UNCHANGED and remains the one preWriterDecisionPackage.ts (the human-facing
 * operator audit) uses — this function never becomes the new source of truth, only a smaller
 * representation of the same one.
 */
export function renderCompactAccomplishmentEvidenceSection(pkg: CandidateAccomplishmentPackage): string {
  if (!pkg.employers || pkg.employers.length === 0) return "";

  const lines: string[] = [
    "## VERIFIED EMPLOYER ACCOMPLISHMENT EVIDENCE — AUTHORITATIVE EXPERIENCE PROOF (COMPACT)",
    "",
    "The evidence below is a compact deterministic representation of candidate-approved accomplishments — real systems, scale, and delivery outcomes, not final resume wording. Treat every item as factual grounding: convert relevant evidence into natural resume accomplishments while preserving employer ownership, architecture relationships, and metrics exactly. Never copy the arrow notation into the final resume.",
    "",
  ];

  for (const emp of pkg.employers) {
    lines.push(`### ${emp.employer} (${emp.title}, ${emp.dates})`);
    emp.verifiedAccomplishments.forEach((acc, idx) => {
      const evidence = buildCompactEvidence(acc);
      lines.push(renderCompactEvidenceLine(evidence, `E${idx + 1}`));
    });
    lines.push("");
  }

  return lines.join("\n");
}
