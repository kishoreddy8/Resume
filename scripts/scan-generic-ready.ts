import { listGenericAdditiveReadyCompanies } from "../src/db/queries/organizationRegistry";
import { runScan } from "../src/lib/scan";

async function main() {
  const companies = listGenericAdditiveReadyCompanies();
  if (companies.length === 0) {
    console.log("No validated additive-ready generic sources are available.");
    return;
  }
  console.log(`Loading explicit U.S. jobs from ${companies.length} additive-ready generic source(s)...`);
  const summary = await runScan(companies, { usOnly: true, runAgeSweep: false });
  for (const result of summary.results) {
    console.log(
      result.status === "ok"
        ? `[ok] ${result.companyName}: +${result.jobsNew} new, ${result.jobsUpdated} refreshed; closure disabled`
        : `[error] ${result.companyName}: ${result.error}`
    );
  }
  console.log(
    `Done: ${summary.jobsNew} new, ${summary.jobsUpdated} refreshed, ` +
      `${summary.jobsClosed} closed, ${summary.jobsDeletedByAge} age-deleted, ${summary.errors} errors.`
  );
  process.exit(summary.errors > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Additive-ready generic job load failed:", error);
  process.exit(1);
});
