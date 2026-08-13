import { getDb } from "../src/db";
import { detectAtsFromUrlString } from "../src/lib/ats/detect";
import { detectUnsupportedAtsUrl, isKnownVendorAssetFalsePositive } from "../src/lib/ats/unsupportedCatalog";

interface DiscoveryRow {
  organization_id: number;
  resolved_company_id: number | null;
  source_resolution_status: string | null;
  discovered_jobs_url: string;
  existing_suspected_ats: string | null;
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const falsePositivesOnly = process.argv.includes("--false-positives-only");
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ods.organization_id, ods.resolved_company_id, ods.source_resolution_status,
              ods.discovered_jobs_url, c.suspected_ats AS existing_suspected_ats
       FROM organization_discovery_state ods
       LEFT JOIN companies c ON c.id = ods.resolved_company_id
       WHERE ods.discovered_jobs_url IS NOT NULL
         AND ods.source_resolution_status IN ('GENERIC_SUPPORTED', 'UNRESOLVED', 'NEEDS_ADAPTER')`
    )
    .all() as DiscoveryRow[];

  const changes: { organizationId: number; companyId: number | null; from: string | null; to: string; suspectedAts: string | null; url: string }[] = [];
  for (const row of rows) {
    const suspectedAts = detectUnsupportedAtsUrl(row.discovered_jobs_url);
    const supportedConflict = row.source_resolution_status === "NEEDS_ADAPTER"
      ? detectAtsFromUrlString(row.discovered_jobs_url)
      : null;
    const falsePositive = isKnownVendorAssetFalsePositive(row.discovered_jobs_url);
    if (falsePositivesOnly && !falsePositive) continue;
    if (!suspectedAts && !supportedConflict && !falsePositive) continue;
    const desiredSuspectedAts = supportedConflict ? "connector_identity_conflict" : suspectedAts;
    const to = desiredSuspectedAts ? "NEEDS_ADAPTER" : "UNRESOLVED";
    if (row.source_resolution_status === to && row.existing_suspected_ats === desiredSuspectedAts) continue;
    changes.push({
      organizationId: row.organization_id,
      companyId: row.resolved_company_id,
      from: row.source_resolution_status,
      to,
      suspectedAts: desiredSuspectedAts,
      url: row.discovered_jobs_url,
    });
  }

  const byProvider = new Map<string, number>();
  for (const change of changes) {
    const key = change.suspectedAts ?? "false-positive removed";
    byProvider.set(key, (byProvider.get(key) ?? 0) + 1);
  }

  console.log(`${apply ? "Applying" : "Previewing"} ${changes.length} ATS reclassification(s).`);
  for (const [provider, count] of [...byProvider].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`  ${provider}: ${count}`);
  }
  if (!apply || changes.length === 0) {
    if (!apply) console.log("No database changes made. Re-run with --apply after reviewing this preview.");
    return;
  }

  db.transaction(() => {
    const updateState = db.prepare(
      `UPDATE organization_discovery_state
       SET source_resolution_status = ?, updated_at = datetime('now')
       WHERE organization_id = ?`
    );
    const updateCompany = db.prepare(
      `UPDATE companies
       SET resolution_status = ?, suspected_ats = ?, discovery_reason = ?, updated_at = datetime('now')
       WHERE id = ?`
    );
    const updateSources = db.prepare(
      `UPDATE job_sources
       SET resolution_status = ?, suspected_ats = ?, updated_at = datetime('now')
       WHERE organization_id = ? AND provider = 'career_link'`
    );
    for (const change of changes) {
      updateState.run(change.to, change.organizationId);
      if (change.companyId) {
        updateCompany.run(
          change.to,
          change.suspectedAts,
          change.suspectedAts
            ? `Reclassified from saved discovery URL by expanded ATS catalog: ${change.suspectedAts}`
            : `Removed vendor legal/static-asset false positive from saved discovery URL`,
          change.companyId
        );
      }
      updateSources.run(change.to, change.suspectedAts, change.organizationId);
    }
  })();
  console.log(`Applied ${changes.length} ATS reclassification(s) transactionally.`);
}

main();
