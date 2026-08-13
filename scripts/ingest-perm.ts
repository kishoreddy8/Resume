import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse";
import { getDb } from "../src/db";
import {
  recomputeAllPermEmployerSummaries,
  upsertPermEmployerFiling,
} from "../src/db/queries/permEmployers";
import { clearNormalizeCache, normalizeEmployerNameCached } from "../src/lib/h1b/normalizeEmployerName";

/**
 * Imports an official DOL OFLC PERM disclosure CSV. DOL publishes XLSX files, so convert the first
 * worksheet to CSV before running this command. Only employer identity and determination totals are
 * retained; personal/contact fields in the source file are intentionally not stored.
 *
 * FY2024 has two official form datasets. Import them with different --dataset-variant values
 * (for example legacy-form and revised-form) so both contribute without overwriting one another.
 *
 * Usage:
 * npm run ingest-perm -- --file /path/PERM_FY2025.csv --fiscal-year 2025
 * npm run ingest-perm -- --file /path/PERM_FY2024_revised.csv --fiscal-year 2024 --dataset-variant revised-form
 */

const COLUMN_ALIASES: Record<string, string[]> = {
  caseStatus: ["CASE_STATUS", "STATUS"],
  employerName: ["EMPLOYER_NAME", "EMPLOYER_BUSINESS_NAME", "EMP_BUSINESS_NAME"],
};

interface Aggregate {
  raw: string;
  certified: number;
  denied: number;
  withdrawn: number;
}

function parseArgs(): { file?: string; fiscalYear?: number; datasetVariant: string } {
  const args = process.argv.slice(2);
  const out: { file?: string; fiscalYear?: number; datasetVariant: string } = {
    datasetVariant: "main",
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file") out.file = args[++i];
    if (args[i] === "--fiscal-year") out.fiscalYear = Number(args[++i]);
    if (args[i] === "--dataset-variant") out.datasetVariant = args[++i];
  }
  return out;
}

function buildColumnMap(header: string[]): Record<string, number> {
  const upper = header.map((value) => value.trim().toUpperCase());
  const result: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const index = aliases.map((alias) => upper.indexOf(alias)).find((candidate) => candidate >= 0);
    if (index !== undefined) result[field] = index;
  }
  return result;
}

function inferYearFromFilename(filename: string): number | undefined {
  const match = filename.match(/20\d{2}/);
  return match ? Number(match[0]) : undefined;
}

async function main() {
  const { file, fiscalYear, datasetVariant } = parseArgs();
  if (!file) {
    console.error(
      "Usage: npm run ingest-perm -- --file /path/to/PERM.csv [--fiscal-year 2025] " +
        "[--dataset-variant main]"
    );
    process.exit(1);
  }

  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const sourceFile = path.basename(filePath);
  const year = fiscalYear ?? inferYearFromFilename(sourceFile);
  if (!year || !Number.isInteger(year)) {
    console.error("Could not infer a fiscal year; pass --fiscal-year explicitly.");
    process.exit(1);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(datasetVariant)) {
    console.error("--dataset-variant must contain only letters, numbers, underscore, or hyphen.");
    process.exit(1);
  }

  console.log(`Ingesting ${filePath} as FY${year}/${datasetVariant}...`);
  const aggregates = new Map<string, Aggregate>();
  let columnMap: Record<string, number> | null = null;
  let rowsSeen = 0;
  let skippedBlankEmployer = 0;

  const parser = fs.createReadStream(filePath).pipe(
    parse({ bom: true, relax_column_count: true, skip_empty_lines: true })
  );

  for await (const row of parser as AsyncIterable<string[]>) {
    if (!columnMap) {
      columnMap = buildColumnMap(row);
      const missing = ["caseStatus", "employerName"].filter((field) => !(field in columnMap!));
      if (missing.length > 0) {
        throw new Error(
          `Missing expected columns: ${missing.join(", ")}. Header begins: ${row.slice(0, 15).join(", ")}`
        );
      }
      continue;
    }

    rowsSeen++;
    const employerRaw = row[columnMap.employerName]?.trim();
    if (!employerRaw) {
      skippedBlankEmployer++;
      continue;
    }
    const normalized = normalizeEmployerNameCached(employerRaw);
    if (!normalized) continue;

    let aggregate = aggregates.get(normalized);
    if (!aggregate) {
      aggregate = { raw: employerRaw, certified: 0, denied: 0, withdrawn: 0 };
      aggregates.set(normalized, aggregate);
    }

    const status = row[columnMap.caseStatus]?.trim().toUpperCase() ?? "";
    if (status.startsWith("CERTIFIED")) aggregate.certified++;
    else if (status.startsWith("DENIED")) aggregate.denied++;
    else if (status.startsWith("WITHDRAWN")) aggregate.withdrawn++;

    if (rowsSeen % 100_000 === 0) {
      console.log(`  ...${rowsSeen} rows, ${aggregates.size} normalized employers`);
    }
  }
  clearNormalizeCache();

  const db = getDb();
  db.transaction(() => {
    for (const [employerNameNormalized, aggregate] of aggregates) {
      upsertPermEmployerFiling({
        employerNameRaw: aggregate.raw,
        employerNameNormalized,
        fiscalYear: year,
        datasetVariant,
        certified: aggregate.certified,
        denied: aggregate.denied,
        withdrawn: aggregate.withdrawn,
        sourceFile,
      });
    }
  })();
  recomputeAllPermEmployerSummaries();

  console.log(
    `Done: ${rowsSeen} filings scanned, ${aggregates.size} employers, ` +
      `${skippedBlankEmployer} blank employer rows skipped.`
  );
}

main().catch((error) => {
  console.error("PERM ingestion failed:", error);
  process.exit(1);
});
