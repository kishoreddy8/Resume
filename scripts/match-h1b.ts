import { listCompanies, updateCompanyH1bSignal } from "../src/db/queries/companies";
import { countSponsors } from "../src/db/queries/h1bSponsors";
import { matchCompanyToSponsor } from "../src/lib/h1b/fuzzyMatch";

async function main() {
  const sponsorCount = countSponsors();
  if (sponsorCount === 0) {
    console.log("No H1B sponsor data ingested yet. Run `npm run ingest-h1b -- --file <path>` first.");
    return;
  }
  console.log(`Matching companies against ${sponsorCount} known H1B sponsors...`);

  const companies = listCompanies();
  let matched = 0;
  for (const company of companies) {
    const result = matchCompanyToSponsor(company.name);
    if (result) {
      updateCompanyH1bSignal(
        company.id,
        result.signal,
        result.sponsor.employer_name_raw,
        result.score,
        result.sponsor.total_lca_certified
      );
      console.log(
        `  ${company.name} -> ${result.signal} (matched "${result.sponsor.employer_name_raw}", score ${result.score}, ${result.sponsor.total_lca_certified} certified LCAs)`
      );
      matched++;
    } else {
      updateCompanyH1bSignal(company.id, "Unknown", null, null, 0);
      console.log(`  ${company.name} -> Unknown (no confident match)`);
    }
  }

  console.log(`\nDone. ${matched}/${companies.length} companies matched to sponsor history.`);
}

main().catch((err) => {
  console.error("H1B matching failed:", err);
  process.exit(1);
});
