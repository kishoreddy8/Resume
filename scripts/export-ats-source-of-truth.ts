import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import Database from "better-sqlite3";

const SCHEMA_VERSION = "careerops-ats-source-v1";
const DEFAULT_DB = path.join(process.cwd(), "data", "app.db");
const DEFAULT_OUTPUT = path.join(process.cwd(), "data", "exports", "ats-source-of-truth");

interface ExportDefinition {
  file: string;
  description: string;
  sql: string;
}

function parseArgs(): { dbPath: string; outputDir: string } {
  const args = process.argv.slice(2);
  let dbPath = DEFAULT_DB;
  let outputDir = DEFAULT_OUTPUT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db") dbPath = path.resolve(args[++i]);
    if (args[i] === "--output") outputDir = path.resolve(args[++i]);
  }
  return { dbPath, outputDir };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function exportCsv(
  db: Database.Database,
  outputPath: string,
  sql: string
): Promise<{ rows: number; columns: string[] }> {
  const statement = db.prepare(sql);
  const columns = statement.columns().map((column) => column.name);
  const stream = fs.createWriteStream(outputPath, { encoding: "utf8" });
  stream.write(`${columns.map(csvCell).join(",")}\n`);
  let rows = 0;
  for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
    const line = `${columns.map((column) => csvCell(row[column])).join(",")}\n`;
    if (!stream.write(line)) await once(stream, "drain");
    rows++;
  }
  stream.end();
  await once(stream, "finish");
  return { rows, columns };
}

async function sha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

const ORGANIZATION_CTES = `
WITH
lca AS (
  SELECT er.organization_id, hs.id AS h1b_sponsor_id, hs.employer_name_raw AS h1b_employer_name,
         hs.employer_name_normalized AS h1b_normalized_name,
         hs.total_lca_certified, hs.total_lca_denied, hs.total_lca_withdrawn,
         hs.fiscal_years_covered AS h1b_fiscal_years, hs.most_recent_fiscal_year AS h1b_recent_year
  FROM organization_employer_records er
  JOIN h1b_sponsors hs ON hs.id = er.source_record_id
  WHERE er.source_type = 'dol_lca'
),
perm AS (
  SELECT er.organization_id, pe.id AS perm_employer_id, pe.employer_name_raw AS perm_employer_name,
         pe.employer_name_normalized AS perm_normalized_name,
         pe.total_certified AS perm_certified, pe.total_denied AS perm_denied,
         pe.total_withdrawn AS perm_withdrawn, pe.fiscal_years_covered AS perm_fiscal_years,
         pe.most_recent_fiscal_year AS perm_recent_year
  FROM organization_employer_records er
  JOIN perm_employers pe ON pe.id = er.source_record_id
  WHERE er.source_type = 'dol_perm'
),
domain_stats AS (
  SELECT organization_id, COUNT(*) AS domain_count,
         SUM(CASE WHEN identity_status = 'VERIFIED' THEN 1 ELSE 0 END) AS verified_domain_count,
         MIN(CASE WHEN identity_status = 'VERIFIED' THEN domain END) AS verified_domain
  FROM organization_domains GROUP BY organization_id
),
source_stats AS (
  SELECT organization_id, COUNT(*) AS job_source_count,
         SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_job_source_count,
         SUM(CASE WHEN is_active = 1 AND resolution_status = 'VERIFIED' THEN 1 ELSE 0 END)
           AS verified_job_source_count,
         SUM(CASE WHEN is_active = 1 AND resolution_status = 'VERIFIED'
                    AND review_status = 'APPROVED' THEN 1 ELSE 0 END)
           AS approved_job_source_count
  FROM job_sources GROUP BY organization_id
),
company_stats AS (
  SELECT organization_id, COUNT(*) AS legacy_company_count
  FROM organization_company_links GROUP BY organization_id
),
alias_stats AS (
  SELECT organization_id, COUNT(*) AS alias_count
  FROM organization_aliases GROUP BY organization_id
)
`;

const EXPORTS: ExportDefinition[] = [
  {
    file: "company_names.csv",
    description: "Compact one-row-per-company catalog for human and agent consumption.",
    sql: `${ORGANIZATION_CTES}
      SELECT o.id AS organization_id, o.canonical_name, o.status AS organization_status,
             CASE WHEN lca.h1b_sponsor_id IS NULL THEN 0 ELSE 1 END AS has_h1b_provenance,
             CASE WHEN perm.perm_employer_id IS NULL THEN 0 ELSE 1 END AS has_perm_provenance,
             lca.total_lca_certified, perm.perm_certified, ds.verified_domain,
             CASE
               WHEN COALESCE(ss.approved_job_source_count, 0) > 0 THEN 'READY_TO_SCAN'
               WHEN COALESCE(ss.job_source_count, 0) > 0 THEN 'REVIEW_EXISTING_SOURCE'
               WHEN COALESCE(ds.verified_domain_count, 0) > 0 THEN 'NEEDS_ATS_DISCOVERY'
               ELSE 'NEEDS_DOMAIN_DISCOVERY' END AS discovery_state
      FROM organizations o
      LEFT JOIN lca ON lca.organization_id = o.id
      LEFT JOIN perm ON perm.organization_id = o.id
      LEFT JOIN domain_stats ds ON ds.organization_id = o.id
      LEFT JOIN source_stats ss ON ss.organization_id = o.id
      ORDER BY o.id`,
  },
  {
    file: "organizations.csv",
    description: "One row per canonical organization; this is the authoritative company count.",
    sql: `${ORGANIZATION_CTES}
      SELECT o.id AS organization_id, o.canonical_name, o.status AS organization_status,
             CASE WHEN lca.h1b_sponsor_id IS NULL THEN 0 ELSE 1 END AS has_h1b_provenance,
             lca.h1b_sponsor_id, lca.h1b_employer_name, lca.h1b_normalized_name,
             lca.total_lca_certified, lca.total_lca_denied, lca.total_lca_withdrawn,
             lca.h1b_fiscal_years, lca.h1b_recent_year,
             CASE WHEN perm.perm_employer_id IS NULL THEN 0 ELSE 1 END AS has_perm_provenance,
             perm.perm_employer_id, perm.perm_employer_name, perm.perm_normalized_name,
             perm.perm_certified, perm.perm_denied, perm.perm_withdrawn,
             perm.perm_fiscal_years, perm.perm_recent_year,
             COALESCE(ds.domain_count, 0) AS domain_count,
             COALESCE(ds.verified_domain_count, 0) AS verified_domain_count,
             ds.verified_domain,
             COALESCE(ss.job_source_count, 0) AS job_source_count,
             COALESCE(ss.active_job_source_count, 0) AS active_job_source_count,
             COALESCE(ss.verified_job_source_count, 0) AS verified_job_source_count,
             COALESCE(ss.approved_job_source_count, 0) AS approved_job_source_count,
             COALESCE(cs.legacy_company_count, 0) AS live_company_count,
             COALESCE(a.alias_count, 0) AS alias_count,
             o.created_at, o.updated_at
      FROM organizations o
      LEFT JOIN lca ON lca.organization_id = o.id
      LEFT JOIN perm ON perm.organization_id = o.id
      LEFT JOIN domain_stats ds ON ds.organization_id = o.id
      LEFT JOIN source_stats ss ON ss.organization_id = o.id
      LEFT JOIN company_stats cs ON cs.organization_id = o.id
      LEFT JOIN alias_stats a ON a.organization_id = o.id
      ORDER BY o.id`,
  },
  {
    file: "employer_provenance.csv",
    description: "One row per DOL employer source record linked to a canonical organization.",
    sql: `SELECT id AS provenance_id, organization_id, source_type, source_record_id,
                 employer_name_raw, employer_name_normalized, created_at, updated_at
          FROM organization_employer_records
          ORDER BY organization_id, source_type, source_record_id`,
  },
  {
    file: "domains.csv",
    description: "All candidate and verified organization domains with evidence and status.",
    sql: `SELECT id AS domain_id, organization_id, domain, identity_status, resolution_method,
                 resolution_confidence, evidence, is_primary, verified_at, created_at, updated_at
          FROM organization_domains ORDER BY organization_id, is_primary DESC, id`,
  },
  {
    file: "job_sources.csv",
    description: "All known ATS boards and generic careers sources; one organization may have many.",
    sql: `SELECT id AS job_source_id, organization_id, provider, source_key, source_url,
                 resolution_status, suspected_ats, is_authoritative, is_active, review_status,
                 reviewed_at, review_evidence, legacy_company_id, last_validated_at, created_at,
                 updated_at
          FROM job_sources ORDER BY organization_id, is_authoritative DESC, id`,
  },
  {
    file: "ats_discovery_queue.csv",
    description: "Deterministic one-row-per-organization queue with the next safe discovery action.",
    sql: `${ORGANIZATION_CTES}
      SELECT CASE
               WHEN COALESCE(ss.approved_job_source_count, 0) > 0 THEN 5
               WHEN COALESCE(ss.job_source_count, 0) > 0 THEN 1
               WHEN COALESCE(ds.verified_domain_count, 0) > 0 THEN 0
               ELSE 3 END AS priority_tier,
             o.id AS organization_id, o.canonical_name,
             CASE
               WHEN COALESCE(ss.approved_job_source_count, 0) > 0 THEN 'READY_TO_SCAN'
               WHEN COALESCE(ss.job_source_count, 0) > 0 THEN 'REVIEW_EXISTING_SOURCE'
               WHEN COALESCE(ds.verified_domain_count, 0) > 0 THEN 'NEEDS_ATS_DISCOVERY'
               ELSE 'NEEDS_DOMAIN_DISCOVERY' END AS discovery_state,
             CASE
               WHEN COALESCE(ss.approved_job_source_count, 0) > 0 THEN 'scan_jobs'
               WHEN COALESCE(ss.job_source_count, 0) > 0 THEN 'review_job_sources_csv'
               WHEN COALESCE(ds.verified_domain_count, 0) > 0 THEN 'discover_ats_from_verified_domain'
               ELSE 'resolve_and_verify_domain' END AS next_action,
             ds.verified_domain, COALESCE(ss.job_source_count, 0) AS job_source_count,
             COALESCE(ss.verified_job_source_count, 0) AS verified_job_source_count,
             COALESCE(ss.approved_job_source_count, 0) AS approved_job_source_count,
             lca.h1b_sponsor_id, lca.h1b_employer_name, lca.h1b_normalized_name,
             lca.total_lca_certified, lca.h1b_recent_year,
             perm.perm_employer_id, perm.perm_employer_name, perm.perm_normalized_name,
             perm.perm_certified, perm.perm_recent_year
      FROM organizations o
      LEFT JOIN lca ON lca.organization_id = o.id
      LEFT JOIN perm ON perm.organization_id = o.id
      LEFT JOIN domain_stats ds ON ds.organization_id = o.id
      LEFT JOIN source_stats ss ON ss.organization_id = o.id
      WHERE o.status <> 'inactive'
      ORDER BY o.id`,
  },
  {
    file: "scan_ready_sources.csv",
    description: "Structured connector sources that are verified and safe to pass to the scanner.",
    sql: `SELECT js.id AS job_source_id, js.organization_id, o.canonical_name, js.provider,
                 js.source_key, js.source_url, js.last_validated_at, js.legacy_company_id
          FROM job_sources js
          JOIN organizations o ON o.id = js.organization_id
          WHERE js.is_active = 1 AND js.resolution_status = 'VERIFIED'
            AND js.review_status = 'APPROVED'
            AND js.provider IN ('greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'adp_wfn', 'adp_rm', 'eightfold', 'cornerstone', 'avature', 'paylocity', 'icims', 'ukg_pro', 'bamboohr', 'oracle_recruiting_cloud', 'workable', 'rippling', 'paycom', 'jazzhr', 'jobvite', 'breezy', 'teamtailor', 'applicantpro', 'pinpoint', 'clearcompany', 'personio', 'applicantstack', 'comeet', 'cats', 'gohire', 'newton', 'silkroad', 'jobdiva', 'taleo', 'successfactors')
          ORDER BY js.provider, o.canonical_name COLLATE NOCASE, js.id`,
  },
  {
    file: "generic_additive_ready_sources.csv",
    description: "Validated generic sources allowed to add/update U.S. jobs but never close missing jobs.",
    sql: `SELECT js.id AS job_source_id, js.organization_id, o.canonical_name, js.source_url,
                 js.last_validated_at, js.legacy_company_id, js.is_authoritative,
                 vr.id AS latest_validation_run_id, vr.extractor_type, vr.samples_saved,
                 vr.can_ingest, vr.can_close_missing, vr.connector_version, vr.finished_at
          FROM job_sources js
          JOIN organizations o ON o.id = js.organization_id
          JOIN job_source_validation_runs vr ON vr.id = (
            SELECT vr2.id FROM job_source_validation_runs vr2
            WHERE vr2.job_source_id = js.id ORDER BY vr2.id DESC LIMIT 1
          )
          WHERE js.is_active = 1 AND js.provider='career_link'
            AND js.resolution_status='GENERIC_SUPPORTED' AND js.review_status='APPROVED'
            AND vr.outcome='READY_ADDITIVE' AND vr.can_ingest=1 AND vr.can_close_missing=0
          ORDER BY o.canonical_name COLLATE NOCASE, js.id`,
  },
  {
    file: "organization_discovery_state.csv",
    description: "One durable discovery checkpoint per searched canonical organization.",
    sql: `SELECT organization_id, resolved_company_id, domain_identity_status, domain,
                 resolution_method, resolution_confidence, evidence, channels_checked,
                 source_resolution_status, discovered_jobs_url, attempted_at, resolved_at,
                 created_at, updated_at
          FROM organization_discovery_state ORDER BY organization_id`,
  },
  {
    file: "browser_source_discovery_attempts.csv",
    description: "Append-only rendered-browser second-pass audit trail for verified domains.",
    sql: `SELECT id AS attempt_id, organization_id, company_id, pass_type, input_url,
                 prior_status, result_status, provider, source_key, source_url, suspected_ats,
                 reason, error_message, started_at, finished_at, duration_ms, created_at
          FROM organization_source_discovery_attempts ORDER BY id`,
  },
  {
    file: "job_source_validation_runs.csv",
    description: "Append-only validation outcomes and production capability flags for structured and generic sources.",
    sql: `SELECT id AS validation_run_id, job_source_id, validation_kind, connector_version,
                 outcome, extractor_type, validation_scope, sample_limit, jobs_seen, us_jobs_seen,
                 samples_saved, pagination_verified, completeness_verified, can_ingest,
                 can_close_missing, error_category, reason, evidence_json, started_at, finished_at,
                 duration_ms, created_at
          FROM job_source_validation_runs ORDER BY id`,
  },
  {
    file: "job_source_validation_samples.csv",
    description: "At most three evidence-only jobs per validation run; never production board rows.",
    sql: `SELECT id AS validation_sample_id, validation_run_id, sample_index, external_id,
                 title, location, location_scope, job_url, description_present, posted_at,
                 evidence_json, created_at
          FROM job_source_validation_samples ORDER BY validation_run_id, sample_index`,
  },
  {
    file: "ats_adapter_profile_runs.csv",
    description: "Passive endpoint-shape evidence for unsupported ATS families; never scan authorization.",
    sql: `SELECT id AS profile_run_id, job_source_id, organization_id, suspected_ats,
                 profiler_version, outcome, source_host, final_url_shape, http_status,
                 endpoint_candidates, api_evidence, pagination_evidence, tenant_evidence,
                 evidence_json, error_category, error_message, started_at, finished_at,
                 duration_ms, created_at
          FROM ats_adapter_profile_runs ORDER BY id`,
  },
  {
    file: "connector_health_check_runs.csv",
    description: "Read-only health probes for approved structured connectors; never job ingestion or approval mutation.",
    sql: `SELECT id AS health_check_id, job_source_id, organization_id, company_id, provider,
                 checker_version, outcome, jobs_seen, sample_external_id, sample_title, latency_ms,
                 error_category, error_message, evidence_json, started_at, finished_at, created_at
          FROM connector_health_check_runs ORDER BY id`,
  },
  {
    file: "current_jobs.csv",
    description: "Current normalized job snapshot without descriptions or candidate-specific state.",
    sql: `SELECT j.id AS job_id, l.organization_id, j.company_id, c.name AS company_name,
                 j.source_type, j.external_id, j.title, j.location, j.department, j.url,
                 j.employment_type, j.workplace_type, j.salary_text, j.posted_at,
                 j.first_seen_at, j.last_seen_at, j.is_active, j.closed_at, j.is_archived,
                 j.dedupe_key, j.created_at, j.updated_at
          FROM jobs j
          JOIN companies c ON c.id = j.company_id
          LEFT JOIN organization_company_links l ON l.company_id = c.id
          WHERE j.is_active = 1 AND j.is_archived = 0
          ORDER BY l.organization_id, j.company_id, j.id`,
  },
];

async function main() {
  const { dbPath, outputDir } = parseArgs();
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("foreign_keys = ON");

  const integrity = db.pragma("integrity_check") as { integrity_check: string }[];
  const foreignKeyViolations = db.pragma("foreign_key_check") as unknown[];
  if (integrity[0]?.integrity_check !== "ok" || foreignKeyViolations.length > 0) {
    throw new Error("Database integrity check failed; refusing to export a source of truth.");
  }

  const files: Record<string, unknown>[] = [];
  for (const definition of EXPORTS) {
    const outputPath = path.join(outputDir, definition.file);
    const result = await exportCsv(db, outputPath, definition.sql);
    files.push({
      file: definition.file,
      description: definition.description,
      rows: result.rows,
      columns: result.columns,
      bytes: fs.statSync(outputPath).size,
      sha256: await sha256(outputPath),
    });
    console.log(`${definition.file}: ${result.rows.toLocaleString()} rows`);
  }

  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM organizations) AS organizations,
         (SELECT COUNT(*) FROM organization_employer_records) AS employer_provenance_records,
         (SELECT COUNT(*) FROM organization_employer_records WHERE source_type = 'dol_lca') AS h1b_provenance_records,
         (SELECT COUNT(*) FROM organization_employer_records WHERE source_type = 'dol_perm') AS perm_provenance_records,
         (SELECT COUNT(*) FROM organization_domains WHERE identity_status = 'VERIFIED') AS verified_domains,
         (SELECT COUNT(*) FROM organization_discovery_state) AS organizations_searched,
         (SELECT COUNT(*) FROM organization_source_discovery_attempts) AS browser_source_attempts,
         (SELECT COUNT(*) FROM job_source_validation_runs) AS source_validation_runs,
         (SELECT COUNT(*) FROM job_source_validation_samples) AS source_validation_samples,
         (SELECT COUNT(*) FROM ats_adapter_profile_runs) AS adapter_profile_runs,
         (SELECT COUNT(*) FROM connector_health_check_runs) AS connector_health_checks,
         (SELECT COUNT(*) FROM organizations WHERE status <> 'inactive') -
           (SELECT COUNT(*) FROM organization_discovery_state) AS organizations_pending_discovery,
         (SELECT COUNT(*) FROM job_sources WHERE is_active = 1 AND resolution_status = 'VERIFIED') AS verified_job_sources,
         (SELECT COUNT(*) FROM job_sources WHERE is_active = 1 AND resolution_status = 'VERIFIED'
            AND review_status = 'APPROVED') AS approved_job_sources,
         (SELECT COUNT(*) FROM organizations o WHERE NOT EXISTS (
            SELECT 1 FROM organization_domains d
            WHERE d.organization_id = o.id AND d.identity_status = 'VERIFIED'
          )) AS organizations_needing_domain_discovery,
         (SELECT COUNT(*) FROM jobs WHERE is_active = 1 AND is_archived = 0) AS current_jobs`
    )
    .get();

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceDatabase: path.relative(process.cwd(), dbPath),
    sourcePolicy: {
      canonicalCompanyCount: "Count rows in organizations; never count aliases or provenance rows as companies.",
      verifiedDomain: "organization_domains.identity_status = VERIFIED",
      verifiedJobSource: "job_sources.is_active = 1 and resolution_status = VERIFIED",
      approvedJobSource: "Verified job source with review_status = APPROVED",
      scanReady: "Approved verified source using a supported structured connector, including ADP Recruiting Management (adp_rm).",
      genericAdditiveReady: "Approved generic source whose latest validation allows U.S.-only add/update but never closure.",
      adapterProfileEvidence: "Passive unsupported-ATS research only; cannot approve a source or authorize job loading.",
      connectorHealthEvidence: "Read-only approved-connector probes; cannot load/close jobs or change review approval.",
      warning: "Registry membership does not imply a verified domain, ATS source, active hiring, or active jobs.",
    },
    officialSources: [
      "https://www.dol.gov/agencies/eta/foreign-labor/performance",
      "https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/PERM_Disclosure_Data_FY2025_Q4.xlsx",
    ],
    integrityCheck: "ok",
    foreignKeyViolations: 0,
    counts,
    files,
  };
  const manifestPath = path.join(outputDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`manifest.json: ${await sha256(manifestPath)}`);
  db.close();
}

main().catch((error) => {
  console.error("ATS source-of-truth export failed:", error);
  process.exit(1);
});
