import fs from "node:fs";
import path from "node:path";
import { runGenericSourceValidationBatch } from "../src/lib/ats/genericSourceValidation";

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
  const batchSize = integerArg("--batch-size", 25, 100);
  const sampleSize = integerArg("--sample-size", 3, 3);
  const concurrency = integerArg("--concurrency", 1, 2);
  const persist = !process.argv.includes("--dry-run");
  const retryNow = process.argv.includes("--retry-now");
  console.log(
    `${persist ? "Validating" : "Dry-running"} up to ${batchSize} generic sources with ` +
      `${sampleSize} U.S. evidence sample(s), concurrency ${concurrency}...`
  );
  const summary = await runGenericSourceValidationBatch({
    batchSize,
    sampleSize,
    concurrency,
    persist,
    retryNow,
  });
  for (const result of summary.results) {
    console.log(
      `[${result.outcome.toLowerCase()}] ${result.canonicalName}: ` +
        `${result.samplesSaved} sample(s), ${result.extractorType ?? "no extractor"} — ${result.reason}`
    );
  }
  console.log(
    `Done: ${summary.attempted} attempted, ${summary.readyAdditive} additive-ready, ` +
      `${summary.needsAdapter} embedded ATS, ${summary.noUsJobs} no-US, ` +
      `${summary.pending} pending, ${summary.failedTemporary} temporary, ${summary.rejected} rejected.`
  );
  if (persist) {
    const reportDir = path.resolve("data/generic-source-validation-reports");
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, "latest.json"), `${JSON.stringify(summary, null, 2)}\n`);
    fs.appendFileSync(path.join(reportDir, "batches.jsonl"), `${JSON.stringify(summary)}\n`);
  }
}

main().catch((error) => {
  console.error("Generic source validation failed:", error);
  process.exit(1);
});
