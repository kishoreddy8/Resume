import type Database from "better-sqlite3";
import { normalizeEmployerName } from "@/lib/h1b/normalizeEmployerName";
import { normalizeOrganizationAlias } from "./organizationRegistryCore";

interface EmployerSourceRow {
  id: number;
  employer_name_raw: string;
  employer_name_normalized: string;
}

export interface EmployerRegistrySeedStats {
  sourceRecords: number;
  organizationsCreated: number;
  exactLinksCreated: number;
  existingLinksRefreshed: number;
  ambiguousNamesKeptSeparate: number;
}

function addCandidate(map: Map<string, Set<number>>, normalized: string, organizationId: number): void {
  if (!normalized) return;
  let ids = map.get(normalized);
  if (!ids) {
    ids = new Set<number>();
    map.set(normalized, ids);
  }
  ids.add(organizationId);
}

/**
 * Projects DOL employer rollups into the organization registry using exact normalized-name matches
 * only. No fuzzy, domain, parent/subsidiary, or ATS inference occurs here. If a normalized name is
 * already associated with multiple organizations, a new candidate is kept separate instead of
 * making an arbitrary merge. The generic source-record link makes the operation idempotent.
 */
export function seedOrganizationRegistryFromEmployerSources(
  db: Database.Database
): EmployerRegistrySeedStats {
  const stats: EmployerRegistrySeedStats = {
    sourceRecords: 0,
    organizationsCreated: 0,
    exactLinksCreated: 0,
    existingLinksRefreshed: 0,
    ambiguousNamesKeptSeparate: 0,
  };

  const candidates = new Map<string, Set<number>>();

  const existingRecords = db
    .prepare(
      `SELECT organization_id, employer_name_normalized
       FROM organization_employer_records`
    )
    .all() as { organization_id: number; employer_name_normalized: string }[];
  for (const record of existingRecords) {
    addCandidate(candidates, record.employer_name_normalized, record.organization_id);
  }

  // Existing application organizations get a chance to match by exact DOL-normalized canonical
  // name. Multiple candidates remain ambiguous and are never auto-merged.
  const existingOrganizations = db
    .prepare("SELECT id, canonical_name FROM organizations")
    .all() as { id: number; canonical_name: string }[];
  for (const organization of existingOrganizations) {
    addCandidate(candidates, normalizeEmployerName(organization.canonical_name), organization.id);
  }

  const findExistingLink = db.prepare(
    `SELECT organization_id FROM organization_employer_records
     WHERE source_type = ? AND source_record_id = ?`
  );
  const createOrganization = db.prepare(
    `INSERT INTO organizations (canonical_name, status) VALUES (?, 'candidate') RETURNING id`
  );
  const upsertRecord = db.prepare(
    `INSERT INTO organization_employer_records (
       organization_id, source_type, source_record_id, employer_name_raw, employer_name_normalized
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_type, source_record_id) DO UPDATE SET
       employer_name_raw = excluded.employer_name_raw,
       employer_name_normalized = excluded.employer_name_normalized,
       updated_at = datetime('now')`
  );
  const upsertAlias = db.prepare(
    `INSERT INTO organization_aliases (
       organization_id, alias, alias_normalized, alias_type, provenance_source, provenance_key,
       evidence, is_primary
     ) VALUES (?, ?, ?, 'legal', ?, ?, ?, 1)
     ON CONFLICT(provenance_source, provenance_key) WHERE provenance_key IS NOT NULL DO UPDATE SET
       alias = excluded.alias,
       alias_normalized = excluded.alias_normalized,
       evidence = excluded.evidence,
       updated_at = datetime('now')`
  );

  const seedRows = (sourceType: "dol_lca" | "dol_perm", rows: EmployerSourceRow[]) => {
    for (const row of rows) {
      stats.sourceRecords++;
      const existing = findExistingLink.get(sourceType, row.id) as
        | { organization_id: number }
        | undefined;
      let organizationId: number;

      if (existing) {
        organizationId = existing.organization_id;
        stats.existingLinksRefreshed++;
      } else {
        const exactCandidates = candidates.get(row.employer_name_normalized);
        if (exactCandidates?.size === 1) {
          organizationId = exactCandidates.values().next().value as number;
          stats.exactLinksCreated++;
        } else {
          organizationId = (
            createOrganization.get(row.employer_name_raw) as { id: number }
          ).id;
          stats.organizationsCreated++;
          if (exactCandidates && exactCandidates.size > 1) stats.ambiguousNamesKeptSeparate++;
        }
      }

      upsertRecord.run(
        organizationId,
        sourceType,
        row.id,
        row.employer_name_raw,
        row.employer_name_normalized
      );
      upsertAlias.run(
        organizationId,
        row.employer_name_raw,
        normalizeOrganizationAlias(row.employer_name_raw),
        sourceType,
        String(row.id),
        `Exact normalized employer identity from ${sourceType} record ${row.id}`
      );
      addCandidate(candidates, row.employer_name_normalized, organizationId);
    }
  };

  db.transaction(() => {
    seedRows(
      "dol_lca",
      db
        .prepare(
          `SELECT id, employer_name_raw, employer_name_normalized
           FROM h1b_sponsors ORDER BY id`
        )
        .all() as EmployerSourceRow[]
    );
    seedRows(
      "dol_perm",
      db
        .prepare(
          `SELECT id, employer_name_raw, employer_name_normalized
           FROM perm_employers ORDER BY id`
        )
        .all() as EmployerSourceRow[]
    );
  })();

  return stats;
}
