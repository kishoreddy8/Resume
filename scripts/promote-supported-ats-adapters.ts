import { getDb } from "../src/db";
import { detectAtsFromUrlString } from "../src/lib/ats/detect";

interface CandidateRow {
  job_source_id: number;
  organization_id: number;
  legacy_company_id: number;
  source_url: string;
  suspected_ats: string;
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const providerIndex = process.argv.indexOf("--provider");
  const provider = providerIndex >= 0 ? process.argv[providerIndex + 1] : null;
  if (providerIndex >= 0 && !provider) throw new Error("--provider requires a provider name");
  const db = getDb();
  const rows = db.prepare(
    `SELECT id AS job_source_id, organization_id, legacy_company_id, source_url, suspected_ats
     FROM job_sources
     WHERE provider='career_link' AND resolution_status='NEEDS_ADAPTER'
       AND source_url IS NOT NULL AND suspected_ats IS NOT NULL
     ORDER BY id`
  ).all() as CandidateRow[];
  const candidates = rows.flatMap((row) => {
    const detection = detectAtsFromUrlString(row.source_url);
    return detection && (!provider || detection.sourceType === provider) ? [{ ...row, detection }] : [];
  });
  const conflicts = candidates.filter((candidate) => {
    const existing = db.prepare(
      `SELECT organization_id FROM job_sources
       WHERE provider=? AND source_key=? AND id<>?`
    ).get(
      candidate.detection.sourceType,
      candidate.detection.atsBoardToken,
      candidate.job_source_id
    ) as { organization_id: number } | undefined;
    return Boolean(existing && existing.organization_id !== candidate.organization_id);
  });
  const conflictIds = new Set(conflicts.map((row) => row.job_source_id));
  const promotable = candidates.filter((row) => !conflictIds.has(row.job_source_id));
  console.log(
    `${apply ? "Applying" : "Previewing"} ${promotable.length} supported-adapter promotion(s); ` +
      `${conflicts.length} cross-organization identity conflict(s) remain blocked.`
  );
  const byProvider = new Map<string, number>();
  for (const row of promotable) {
    byProvider.set(row.detection.sourceType, (byProvider.get(row.detection.sourceType) ?? 0) + 1);
  }
  for (const [provider, count] of byProvider) console.log(`  ${provider}: ${count}`);
  if (!apply) {
    console.log("No database changes made. Re-run with --apply after reviewing the preview.");
    return;
  }

  db.transaction(() => {
    const updateSource = db.prepare(
      `UPDATE job_sources
       SET provider=?, source_key=?, source_url=?, resolution_status='VERIFIED', suspected_ats=NULL,
           is_authoritative=1, review_status='PENDING', reviewed_at=NULL, review_evidence=NULL,
           last_validated_at=NULL, updated_at=datetime('now')
       WHERE id=?`
    );
    const updateCompany = db.prepare(
      `UPDATE companies
       SET source_type=?, ats_board_token=?, career_page_url=NULL, resolution_status='VERIFIED',
           discovered_jobs_url=?, suspected_ats=NULL,
           discovery_reason='Promoted after provider adapter implementation; pending bounded validation',
           updated_at=datetime('now')
       WHERE id=?`
    );
    const updateState = db.prepare(
      `UPDATE organization_discovery_state
       SET source_resolution_status='VERIFIED', discovered_jobs_url=?, updated_at=datetime('now')
       WHERE organization_id=?`
    );
    for (const row of promotable) {
      const canonicalUrl = row.detection.canonicalSourceUrl ?? row.source_url;
      updateSource.run(
        row.detection.sourceType,
        row.detection.atsBoardToken,
        canonicalUrl,
        row.job_source_id
      );
      updateCompany.run(
        row.detection.sourceType,
        row.detection.atsBoardToken,
        canonicalUrl,
        row.legacy_company_id
      );
      updateState.run(canonicalUrl, row.organization_id);
    }
  })();
  console.log(`Promoted ${promotable.length} source(s) to PENDING structured validation.`);
}

main();
