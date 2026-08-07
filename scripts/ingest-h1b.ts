import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse";
import { normalizeEmployerName } from "../src/lib/h1b/normalizeEmployerName";
import { upsertSponsor } from "../src/db/queries/h1bSponsors";
import { getDb } from "../src/db";

/**
 * Ingests a DOL OFLC H-1B LCA disclosure CSV (public data, no auth — download manually from
 * https://www.dol.gov/agencies/eta/foreign-labor/performance, "LCA Programs (H-1B, H-1B1, E-3)"
 * section, then convert to CSV if you only have the .xlsx).
 *
 * DOL has renamed columns across fiscal years, so this looks up each field by a list of known
 * aliases (case-insensitive) rather than assuming one fixed header row.
 *
 * Usage: npm run ingest-h1b -- --file /path/to/LCA_Disclosure_Data_FY2024.csv [--fiscal-year 2024]
 */

const COLUMN_ALIASES: Record<string, string[]> = {
  visaClass: ["VISA_CLASS"],
  caseStatus: ["CASE_STATUS"],
  employerName: ["EMPLOYER_NAME", "LCA_CASE_EMPLOYER_NAME", "PETITIONER_NAME"],
};

function parseArgs() {
  const args = process.argv.slice(2);
  const out: { file?: string; fiscalYear?: number } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file") out.file = args[++i];
    if (args[i] === "--fiscal-year") out.fiscalYear = Number(args[++i]);
  }
  return out;
}

function buildColumnMap(header: string[]): Record<string, number> {
  const upper = header.map((h) => h.trim().toUpperCase());
  const map: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const idx = upper.indexOf(alias);
      if (idx !== -1) {
        map[field] = idx;
        break;
      }
    }
  }
  return map;
}

/** DOL publishes one disclosure file per fiscal year — try to read it out of the filename. */
function inferYearFromFilename(filename: string, fallback: number): number {
  const match = filename.match(/20\d{2}/);
  return match ? Number(match[0]) : fallback;
}

interface Aggregate {
  raw: string;
  certified: number;
  denied: number;
  withdrawn: number;
}

async function main() {
  const { file, fiscalYear } = parseArgs();
  if (!file) {
    console.error("Usage: npm run ingest-h1b -- --file /path/to/disclosure.csv [--fiscal-year 2024]");
    process.exit(1);
  }
  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const sourceFile = path.basename(filePath);
  const year = fiscalYear ?? inferYearFromFilename(sourceFile, new Date().getFullYear());
  console.log(`Fiscal year: ${year} (pass --fiscal-year to override if this is wrong)`);

  console.log(`Ingesting ${filePath}...`);

  const aggregates = new Map<string, Aggregate>();
  let columnMap: Record<string, number> | null = null;
  let rowsSeen = 0;
  let h1bRowsSeen = 0;
  let skippedMissingColumns = 0;

  const parser = fs.createReadStream(filePath).pipe(
    parse({
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
    })
  );

  for await (const row of parser as AsyncIterable<string[]>) {
    if (!columnMap) {
      columnMap = buildColumnMap(row);
      const missing = ["visaClass", "caseStatus", "employerName"].filter((f) => !(f in columnMap!));
      if (missing.length > 0) {
        console.error(
          `Could not find expected columns in the header: ${missing.join(", ")}. ` +
            `Found header: ${row.slice(0, 15).join(", ")}...`
        );
        process.exit(1);
      }
      continue;
    }

    rowsSeen++;
    const visaClass = row[columnMap.visaClass]?.trim();
    if (!visaClass || !/^H-?1B$/i.test(visaClass)) continue;
    h1bRowsSeen++;

    const employerRaw = row[columnMap.employerName]?.trim();
    const caseStatus = row[columnMap.caseStatus]?.trim().toUpperCase() ?? "";
    if (!employerRaw) {
      skippedMissingColumns++;
      continue;
    }

    const normalized = normalizeEmployerName(employerRaw);
    if (!normalized) continue;

    let agg = aggregates.get(normalized);
    if (!agg) {
      agg = { raw: employerRaw, certified: 0, denied: 0, withdrawn: 0 };
      aggregates.set(normalized, agg);
    }

    if (caseStatus.startsWith("CERTIFIED")) agg.certified++;
    else if (caseStatus.startsWith("DENIED")) agg.denied++;
    else if (caseStatus.startsWith("WITHDRAWN")) agg.withdrawn++;

    if (rowsSeen % 100000 === 0) {
      console.log(`  ...${rowsSeen} rows scanned, ${aggregates.size} unique employers so far`);
    }
  }

  console.log(
    `Parsed ${rowsSeen} rows (${h1bRowsSeen} H-1B), ${aggregates.size} unique employers. Writing to DB...`
  );

  const db = getDb();
  const writeAll = db.transaction(() => {
    for (const [normalized, agg] of aggregates) {
      upsertSponsor({
        employerNameRaw: agg.raw,
        employerNameNormalized: normalized,
        certified: agg.certified,
        denied: agg.denied,
        withdrawn: agg.withdrawn,
        fiscalYear: year,
        sourceFile,
      });
    }
  });
  writeAll();

  if (skippedMissingColumns > 0) {
    console.log(`Skipped ${skippedMissingColumns} H-1B rows with a blank employer name.`);
  }
  console.log("Done. Run `npm run match-h1b` next to match companies against this data.");
}

main().catch((err) => {
  console.error("H1B ingestion failed:", err);
  process.exit(1);
});
