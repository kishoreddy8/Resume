import fs from "node:fs";
import path from "node:path";
import { runAdapterProfileBatch } from "../src/lib/ats/adapterProfiler";

function integerArg(name: string, fallback: number, max: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be from 1 to ${max}`);
  return value;
}

async function main(): Promise<void> {
  const persist = !process.argv.includes("--dry-run");
  const summary = await runAdapterProfileBatch({
    batchSize: integerArg("--batch-size", 6, 50),
    samplesPerProvider: integerArg("--samples-per-provider", 3, 10),
    concurrency: integerArg("--concurrency", 1, 2),
    persist,
    retryCompleted: process.argv.includes("--retry-completed"),
  });
  for (const result of summary.results) {
    console.log(`[${result.outcome.toLowerCase()}] ${result.suspectedAts} / ${result.canonicalName}: ` +
      `${result.endpointCandidates} endpoint shape(s), api=${result.apiEvidence}, ` +
      `pagination=${result.paginationEvidence}, tenant=${result.tenantEvidence}`);
  }
  console.log(`Done: ${summary.attempted} profiled, ${summary.publicEndpointEvidence} with endpoint evidence, ` +
    `${summary.pageReachable} reachable, ${summary.blockedOrEmpty} blocked/empty, ` +
    `${summary.failedTemporary} temporary, ${summary.unsafeUrl} unsafe.`);
  if (persist && summary.attempted > 0) {
    const reportDir = path.resolve("data/adapter-profiler-reports");
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, "latest.json"), `${JSON.stringify(summary, null, 2)}\n`);
    fs.appendFileSync(path.join(reportDir, "batches.jsonl"), `${JSON.stringify(summary)}\n`);
  }
}

main().catch((error) => {
  console.error("ATS adapter profiling failed:", error);
  process.exit(1);
});
