import fs from "node:fs";
import path from "node:path";
import { runPendingConnectorValidationBatch, type SupportedProvider } from "../src/lib/ats/pendingConnectorValidation";
import { CLI_VALIDATION_PROVIDERS } from "../src/lib/ats/scannableProviders";

/* ADMIN-OPS-3 — derived from the shared authority instead of a sixth hand-written copy.
 * CLI_VALIDATION_PROVIDERS preserves this script's exact current membership, including its
 * omission of recruitee — see src/lib/ats/scannableProviders.ts for why that is recorded rather
 * than corrected here. */
const PROVIDERS = CLI_VALIDATION_PROVIDERS as SupportedProvider[];

function integerArg(name: string, fallback: number, max: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

async function main() {
  const batchSize = integerArg("--batch-size", 100, 500);
  const sampleSize = integerArg("--sample-size", 3, 3);
  const concurrency = integerArg("--concurrency", 3, 10);
  const persist = !process.argv.includes("--dry-run");
  const retryPendingNow = process.argv.includes("--retry-pending-now");
  const providerIndex = process.argv.indexOf("--provider");
  const providerValue = providerIndex >= 0 ? process.argv[providerIndex + 1] : undefined;
  if (providerValue && !PROVIDERS.includes(providerValue as SupportedProvider)) {
    throw new Error(`--provider must be one of: ${PROVIDERS.join(", ")}`);
  }
  const provider = providerValue as SupportedProvider | undefined;
  console.log(
    `${persist ? "Validating" : "Dry-running"} up to ${batchSize} pending connectors ` +
      `with up to ${sampleSize} sample job(s) (U.S. first, global fallback), concurrency ${concurrency}...`
  );

  const summary = await runPendingConnectorValidationBatch({
    batchSize, sampleSize, concurrency, persist, retryPendingNow, provider,
  });
  for (const result of summary.results) {
    console.log(
      `[${result.outcome.toLowerCase()}] ${result.canonicalName} (${result.provider}): ` +
        `${result.sampleJobs} ${result.validationScope?.toLowerCase() ?? "no"}-scope sample(s) — ${result.reason}`
    );
  }
  console.log(
    `Done: ${summary.attempted} attempted, ${summary.approved} approved, ` +
      `${summary.rejected} rejected, ${summary.pending} still pending in ${Math.round(summary.durationMs / 1000)}s.`
  );

  if (persist) {
    const reportDir = path.resolve("data/connector-validation-reports");
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, "latest.json"), `${JSON.stringify(summary, null, 2)}\n`);
    fs.appendFileSync(path.join(reportDir, "batches.jsonl"), `${JSON.stringify(summary)}\n`);
  }
}

main().catch((error) => {
  console.error("Pending connector validation failed:", error);
  process.exit(1);
});
