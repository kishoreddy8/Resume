import { exportExternalWriterPackage } from "../../src/lib/resumeQuality/handoff/exporter";
import { importExternalWriterResult } from "../../src/lib/resumeQuality/handoff/importer";

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const subcommand = argv[0];

  if (!subcommand || (subcommand !== "export" && subcommand !== "import")) {
    process.stderr.write(
      "Usage:\n" +
        "  npx tsx tools/tailoring-engine/external-handoff.ts export --candidate-id <id> --workflow-id <id> [--iteration <n>] [--overwrite]\n" +
        "  npx tsx tools/tailoring-engine/external-handoff.ts import --candidate-id <id> --workflow-id <id> --input <path> [--iteration <n>]\n"
    );
    return 1;
  }

  const candidateIdStr = parseFlag(argv, "--candidate-id");
  const workflowIdStr = parseFlag(argv, "--workflow-id");
  const iterationStr = parseFlag(argv, "--iteration");

  if (!candidateIdStr || !workflowIdStr) {
    process.stderr.write(JSON.stringify({ status: "error", message: "--candidate-id and --workflow-id are required" }) + "\n");
    return 1;
  }

  const candidateId = Number.parseInt(candidateIdStr, 10);
  const workflowId = Number.parseInt(workflowIdStr, 10);
  const targetIteration = iterationStr ? Number.parseInt(iterationStr, 10) : undefined;

  if (Number.isNaN(candidateId) || candidateId <= 0 || Number.isNaN(workflowId) || workflowId <= 0) {
    process.stderr.write(JSON.stringify({ status: "error", message: "candidate-id and workflow-id must be positive integers" }) + "\n");
    return 1;
  }

  try {
    if (subcommand === "export") {
      const overwrite = hasFlag(argv, "--overwrite");
      const result = exportExternalWriterPackage({
        candidateId,
        workflowId,
        targetIterationNumber: targetIteration,
        overwriteExisting: overwrite,
      });

      process.stdout.write(
        JSON.stringify(
          {
            status: "exported",
            candidateId: result.candidateId,
            applicationId: result.applicationId,
            jobId: result.jobId,
            tailoringRunId: result.tailoringRunId,
            workflowId: result.workflowId,
            targetIterationNumber: result.targetIterationNumber,
            handoffDirectory: result.handoffDirectory,
            packageFiles: result.packageFiles,
            waitingStatus: result.waitingStatus,
          },
          null,
          2
        ) + "\n"
      );
      return 0;
    }

    if (subcommand === "import") {
      const inputPath = parseFlag(argv, "--input");
      if (!inputPath) {
        process.stderr.write(JSON.stringify({ status: "error", message: "--input <path> is required for import" }) + "\n");
        return 1;
      }

      const result = importExternalWriterResult({
        candidateId,
        workflowId,
        expectedIterationNumber: targetIteration,
        inputPath,
      });

      process.stdout.write(
        JSON.stringify(
          {
            status: "imported",
            candidateId: result.candidateId,
            applicationId: result.applicationId,
            jobId: result.jobId,
            tailoringRunId: result.tailoringRunId,
            workflowId: result.workflowId,
            iterationNumber: result.iterationNumber,
            agentMetadata: result.agentMetadata,
            validated: true,
          },
          null,
          2
        ) + "\n"
      );
      return 0;
    }
  } catch (err) {
    process.stderr.write(
      JSON.stringify(
        {
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        },
        null,
        2
      ) + "\n"
    );
    return 1;
  }

  return 0;
}

if (process.env.NODE_ENV !== "test" && require.main === module) {
  main().then((code) => process.exit(code));
}
