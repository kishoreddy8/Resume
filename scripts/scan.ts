import { listActiveCompanies } from "../src/db/queries/companies";
import { runScan } from "../src/lib/scan";

async function main() {
  const companies = listActiveCompanies();
  if (companies.length === 0) {
    console.log("No active companies configured. Add some via the /companies page first.");
    return;
  }

  console.log(`Scanning ${companies.length} companies...`);
  const summary = await runScan(companies);

  for (const r of summary.results) {
    if (r.status === "ok") {
      console.log(
        `  [ok]    ${r.companyName} (${r.sourceType}): +${r.jobsNew} new, ${r.jobsUpdated} updated, ${r.jobsClosed} closed, ${r.jobsArchived} archived, ${r.jobsSuppressed} suppressed`
      );
    } else {
      console.log(`  [error] ${r.companyName} (${r.sourceType}): ${r.error}`);
    }
  }

  console.log(
    `\nDone. ${summary.jobsNew} new, ${summary.jobsUpdated} updated, ${summary.jobsClosed} closed, ${summary.jobsArchived} archived, ${summary.jobsSuppressed} suppressed, ${summary.jobsDeletedByAge} deleted (aged out), ${summary.errors} errors.`
  );
  process.exit(summary.errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Scan failed:", err);
  process.exit(1);
});
