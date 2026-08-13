import fs from "node:fs";
import path from "node:path";
import { runConnectorHealthBatch } from "../src/lib/ats/connectorHealthCheck";

function integerArg(name: string, fallback: number, max: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be from 1 to ${max}`);
  return value;
}

async function main(): Promise<void> {
  const persist = !process.argv.includes("--dry-run");
  const summary = await runConnectorHealthBatch({
    batchSize: integerArg("--batch-size", 10, 100),
    concurrency: integerArg("--concurrency", 2, 2),
    intervalHours: integerArg("--interval-hours", 24, 168),
    retryNow: process.argv.includes("--retry-now"),
    persist,
  });
  for (const result of summary.results) {
    console.log(`[${result.outcome.toLowerCase()}] ${result.canonicalName} (${result.provider}): ` +
      `${result.jobsSeen} sample job(s), ${result.latencyMs}ms${result.errorCategory ? `, ${result.errorCategory}` : ""}`);
  }
  console.log(`Done: ${summary.attempted} checked, ${summary.healthyJobs} healthy with jobs, ` +
    `${summary.healthyEmpty} healthy empty, ${summary.failedTemporary} temporary, ${summary.failedHard} hard failures.`);
  if (persist && summary.attempted > 0) {
    const dir = path.resolve("data/connector-health-reports");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "latest.json"), `${JSON.stringify(summary, null, 2)}\n`);
    fs.appendFileSync(path.join(dir, "batches.jsonl"), `${JSON.stringify(summary)}\n`);
  }
}

main().catch((error) => { console.error("Connector health check failed:", error); process.exit(1); });
