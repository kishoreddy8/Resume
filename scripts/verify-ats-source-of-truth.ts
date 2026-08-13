import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse";

const DEFAULT_DIR = path.join(process.cwd(), "data", "exports", "ats-source-of-truth");

async function sha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function countCsvRows(filePath: string): Promise<number> {
  const parser = fs.createReadStream(filePath).pipe(
    parse({ bom: true, columns: true, relax_column_count: true, skip_empty_lines: true })
  );
  let rows = 0;
  for await (const row of parser) {
    if (row) rows++;
  }
  return rows;
}

async function main() {
  const dirArgIndex = process.argv.indexOf("--dir");
  const exportDir = dirArgIndex >= 0 ? path.resolve(process.argv[dirArgIndex + 1]) : DEFAULT_DIR;
  const manifestPath = path.join(exportDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    schemaVersion: string;
    integrityCheck: string;
    foreignKeyViolations: number;
    counts: { organizations: number; employer_provenance_records: number };
    files: { file: string; rows: number; sha256: string }[];
  };

  if (manifest.schemaVersion !== "careerops-ats-source-v1") throw new Error("Unsupported schema version");
  if (manifest.integrityCheck !== "ok" || manifest.foreignKeyViolations !== 0) {
    throw new Error("Manifest records a database integrity failure");
  }

  const seen = new Set<string>();
  const rowsByFile = new Map<string, number>();
  for (const entry of manifest.files) {
    if (seen.has(entry.file)) throw new Error(`Duplicate manifest file: ${entry.file}`);
    seen.add(entry.file);
    const filePath = path.join(exportDir, entry.file);
    if (!fs.existsSync(filePath)) throw new Error(`Missing export file: ${entry.file}`);
    const actualHash = await sha256(filePath);
    if (actualHash !== entry.sha256) throw new Error(`SHA-256 mismatch: ${entry.file}`);
    const actualRows = await countCsvRows(filePath);
    if (actualRows !== entry.rows) {
      throw new Error(`Row-count mismatch for ${entry.file}: manifest=${entry.rows}, actual=${actualRows}`);
    }
    rowsByFile.set(entry.file, actualRows);
    console.log(`[ok] ${entry.file}: ${actualRows.toLocaleString()} rows`);
  }

  for (const file of ["company_names.csv", "organizations.csv", "ats_discovery_queue.csv"]) {
    if (rowsByFile.get(file) !== manifest.counts.organizations) {
      throw new Error(`${file} does not contain exactly one row per organization`);
    }
  }
  if (rowsByFile.get("employer_provenance.csv") !== manifest.counts.employer_provenance_records) {
    throw new Error("Employer provenance row count does not reconcile to the manifest");
  }

  console.log("Source-of-truth package verified successfully.");
}

main().catch((error) => {
  console.error("ATS source-of-truth verification failed:", error);
  process.exit(1);
});
