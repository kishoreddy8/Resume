import fs from "node:fs";
import path from "node:path";
import { runBrowserSourceSecondPassBatch } from "../src/lib/discovery/browserSourceSecondPass";

function integerArg(name: string, fallback: number, max: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be 1-${max}`);
  return value;
}

async function main() {
  const batchSize = integerArg("--batch-size", 50, 250);
  const concurrency = integerArg("--concurrency", 1, 2);
  const persist = !process.argv.includes("--dry-run");
  const retryCompleted = process.argv.includes("--retry-completed");
  const summary = await runBrowserSourceSecondPassBatch({ batchSize, concurrency, persist, retryCompleted });
  for (const result of summary.results) {
    console.log(
      `[${result.resultStatus.toLowerCase()}] ${result.canonicalName}: ` +
        `${result.provider ?? "no provider"} — ${result.reason}`
    );
  }
  console.log(
    `Browser second pass: ${summary.attempted} attempted, ${summary.verified} verified, ` +
      `${summary.needsAdapter} need adapters, ${summary.generic} generic, ` +
      `${summary.unresolved} unresolved, ${summary.failedTemporary} temporary failures.`
  );
  if (persist) {
    const reportDir = path.resolve("data/browser-source-discovery-reports");
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, "latest.json"), `${JSON.stringify(summary, null, 2)}\n`);
    fs.appendFileSync(path.join(reportDir, "batches.jsonl"), `${JSON.stringify(summary)}\n`);
  }
}

main().catch((error) => {
  console.error("Browser source discovery failed:", error);
  process.exit(1);
});
