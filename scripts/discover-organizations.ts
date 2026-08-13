import { organizationDiscoveryCounts } from "../src/db/queries/organizationDiscovery";
import { runOrganizationDiscoveryBatch } from "../src/lib/discovery/organizationBatch";

function readBatchSize(): number {
  const index = process.argv.indexOf("--batch-size");
  if (index < 0) return 2000;
  const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
  if (!Number.isInteger(value) || value < 1 || value > 5000) {
    throw new Error("--batch-size must be an integer from 1 to 5000");
  }
  return value;
}

async function main() {
  const before = organizationDiscoveryCounts();
  console.log(`Registry discovery: ${before.searched.toLocaleString()} searched, ${before.pending.toLocaleString()} pending.`);
  if (before.pending === 0) return;

  const summary = await runOrganizationDiscoveryBatch({ batchSize: readBatchSize(), useBrowserFallback: false });
  const after = organizationDiscoveryCounts();
  console.log(`Attempted ${summary.employersAttempted.toLocaleString()} organizations in ${summary.durationMs}ms.`);
  console.log(
    `Domains: ${summary.domainsVerified} verified, ${summary.domainsAmbiguous} ambiguous, ` +
      `${summary.domainsUnresolved} unresolved, ${summary.domainsFailedTemporary} temporary failures.`
  );
  console.log(
    `Sources: ${summary.atsVerified} structured pending review, ${summary.needsAdapter} need adapters, ` +
      `${summary.careersPagesResolved - summary.atsVerified} generic, ${summary.sourceUnresolved} unresolved.`
  );
  console.log(`Progress: ${after.searched.toLocaleString()} / ${(after.searched + after.pending).toLocaleString()} searched.`);
  if (summary.errors.length) console.log(`Per-organization errors: ${summary.errors.length}`);
}

main().catch((error) => {
  console.error("Registry discovery failed:", error);
  process.exit(1);
});
