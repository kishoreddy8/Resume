import { getDb } from "../src/db";
import { recordDiscoveryResult } from "../src/db/queries/companies";
import { detectAtsFromUrlString } from "../src/lib/ats/detect";

interface Row {
  organization_id: number;
  resolved_company_id: number;
  discovered_jobs_url: string;
  canonical_name: string;
}

function stringArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim().toLowerCase() || null : null;
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const provider = stringArg("--provider");
  if (!provider) throw new Error("--provider is required so saved-source promotion stays connector-scoped");
  const rows = getDb().prepare(
    `SELECT ods.organization_id, ods.resolved_company_id, ods.discovered_jobs_url, o.canonical_name
     FROM organization_discovery_state ods
     JOIN organizations o ON o.id=ods.organization_id
     WHERE ods.source_resolution_status='NEEDS_ADAPTER'
       AND ods.resolved_company_id IS NOT NULL
       AND ods.discovered_jobs_url IS NOT NULL
     ORDER BY ods.organization_id`
  ).all() as Row[];
  const matches = rows.flatMap((row) => {
    const detection = detectAtsFromUrlString(row.discovered_jobs_url);
    return detection?.sourceType === provider ? [{ row, detection }] : [];
  });
  console.log(`${apply ? "Applying" : "Previewing"} ${matches.length} saved ${provider} source promotion(s).`);
  for (const { row, detection } of matches) {
    console.log(`${row.resolved_company_id}\t${row.canonical_name}\t${detection.atsBoardToken}\t${detection.canonicalSourceUrl ?? row.discovered_jobs_url}`);
  }
  if (!apply) {
    console.log("No database changes made. Re-run with --apply after reviewing this preview.");
    return;
  }
  for (const { row, detection } of matches) {
    recordDiscoveryResult(row.resolved_company_id, {
      status: "VERIFIED",
      sourceType: detection.sourceType,
      atsBoardToken: detection.atsBoardToken,
      discoveredJobsUrl: detection.canonicalSourceUrl ?? row.discovered_jobs_url,
      reason: `Promoted from saved discovery evidence after ${provider} connector implementation`,
      suspectedAts: null,
    });
  }
  console.log(`Applied ${matches.length} ${provider} promotion(s) transactionally per company.`);
}

main();
