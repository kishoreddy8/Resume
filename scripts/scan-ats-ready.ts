import { listScanReadyCompanies } from "../src/db/queries/organizationRegistry";
import { runScan } from "../src/lib/scan";

/**
 * Loads jobs only from structured, verified ATS sources in the organization registry. Generic
 * career pages, unresolved sources, and NEEDS_ADAPTER rows are intentionally excluded because they
 * cannot safely drive authoritative job lifecycle actions.
 */
async function main() {
  const companyIdIndex = process.argv.indexOf("--company-id");
  const requestedCompanyId =
    companyIdIndex >= 0 ? Number.parseInt(process.argv[companyIdIndex + 1] ?? "", 10) : null;
  if (companyIdIndex >= 0 && (!requestedCompanyId || requestedCompanyId < 1)) {
    throw new Error("--company-id must be a positive integer");
  }
  const sampleSizeIndex = process.argv.indexOf("--sample-size");
  const sampleSize =
    sampleSizeIndex >= 0 ? Number.parseInt(process.argv[sampleSizeIndex + 1] ?? "", 10) : null;
  if (sampleSizeIndex >= 0 && (!sampleSize || sampleSize < 1 || sampleSize > 10)) {
    throw new Error("--sample-size must be an integer from 1 to 10");
  }
  const companies = listScanReadyCompanies().filter(
    (company) => requestedCompanyId === null || company.id === requestedCompanyId
  );
  if (companies.length === 0) {
    console.log(
      requestedCompanyId === null
        ? "No verified structured ATS sources are ready to scan."
        : `Company ${requestedCompanyId} is not an active verified structured ATS source.`
    );
    return;
  }

  console.log(
    `Loading ${sampleSize === null ? "jobs" : `a maximum of ${sampleSize} verification job(s) per company`} ` +
      `from ${companies.length} verified structured ATS source(s)...`
  );
  const summary = await runScan(companies, { maxJobsPerCompany: sampleSize ?? undefined });
  for (const result of summary.results) {
    if (result.status === "ok") {
      console.log(
        `  [ok] ${result.companyName} (${result.sourceType}): ` +
          `+${result.jobsNew} new, ${result.jobsUpdated} refreshed, ${result.jobsClosed} closed`
      );
    } else {
      console.log(`  [error] ${result.companyName} (${result.sourceType}): ${result.error}`);
    }
  }
  console.log(
    `Done: ${summary.jobsNew} new, ${summary.jobsUpdated} refreshed, ` +
      `${summary.jobsClosed} closed, ${summary.errors} errors.`
  );
  process.exit(summary.errors > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Verified ATS job load failed:", error);
  process.exit(1);
});
