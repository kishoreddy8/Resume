import { listCompanies, updateCompanyH1bConfidence } from "../src/db/queries/companies";
import { countSponsors } from "../src/db/queries/h1bSponsors";
import { matchCompanyToSponsor, scoreCompanyConfidence } from "../src/lib/h1b/fuzzyMatch";

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
    const match = matchCompanyToSponsor(company.name);
    const { confidence, evidence } = scoreCompanyConfidence(match);

    updateCompanyH1bConfidence(company.id, {
      confidence,
      matchEmployerName: match?.sponsor.employer_name_raw ?? null,
      matchNormalized: match?.matchedNormalized ?? null,
      matchTier: match?.tier ?? null,
      matchScore: match?.score ?? null,
      lcaCount: match?.sponsor.total_lca_certified ?? 0,
      latestFiscalYear: match?.sponsor.most_recent_fiscal_year ?? null,
      evidence,
    });

    if (match) {
      console.log(`  ${company.name} -> ${confidence} [${match.tier}] (${evidence})`);
      matched++;
    } else {
      console.log(`  ${company.name} -> Unknown (no confident match)`);
    }
  }

  console.log(`\nDone. ${matched}/${companies.length} companies matched to sponsor history.`);
}

main().catch((err) => {
  console.error("H1B matching failed:", err);
  process.exit(1);
});
