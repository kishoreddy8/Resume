import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
// tools/ -> src/ cross-import, same direction generate.ts already uses for slugify.ts — this is
// the Phase 3 Stage 6 bridge, so it deliberately reaches into the app's execution orchestration
// rather than reimplementing any part of it.
import { executeTailoringRun, TailoringRunAuthorizationError } from "../../src/lib/tailoringExecution";
import type { CoverLetterContent, ResumeContent } from "./types";

/**
 * Phase 3 Stage 6 — the execution bridge between the /tailor-resume ($tailor-resume) skill's
 * reasoning (Claude Code / Codex, entirely outside this app — see SKILL.md) and Stage 5's
 * executeTailoringRun(). This script does no tailoring reasoning itself: it takes ALREADY-FINALIZED
 * structured resume/cover-letter content the skill produced, and a candidateId/jobId, and hands them
 * straight to executeTailoringRun(), which owns authorization, run persistence, artifact-path
 * resolution (Stage 4), deterministic rendering (the existing engine), and completing/failing the
 * run. This script never creates a tailoring_runs row, never computes an artifact path, and never
 * calls completeTailoringRun/failTailoringRun directly — those stay exactly where Stages 3-5 put
 * them.
 *
 * Usage:
 *   npx tsx tools/tailoring-engine/execute-run.ts \
 *     --candidate-id <id> --job-id <id> --input <content.json> \
 *     [--executed-by claude-code|codex] [--selected-track <name>] [--methodology-version <n>]
 *
 * <content.json> shape: { "resume": ResumeContent, "coverLetter": CoverLetterContent } — the exact
 * same ResumeContent/CoverLetterContent types generate.ts's legacy content.json already uses (see
 * ./types.ts) — no duplicate schema. candidateId/jobId are CLI flags, not part of the JSON, so the
 * identity the run is created under is never ambiguous with whatever the content payload contains.
 */

export interface BridgeArgs {
  candidateId: number;
  jobId: number;
  inputPath: string;
  selectedTrack?: string;
  executedBy?: "claude-code" | "codex";
  methodologyVersion?: number;
}

// Only the outer envelope is validated here — "resume"/"coverLetter" must be present, non-null
// objects. Field-level correctness (resume.name required, at least one experience bullet, etc.) is
// already enforced by generateTailoringOutputs's own validateInput() inside executeTailoringRun —
// duplicating those rules here would be exactly the "duplicate resume schema" this stage was told
// not to create.
const BRIDGE_INPUT_SCHEMA = z.object({
  resume: z.object({}).passthrough(),
  coverLetter: z.object({}).passthrough(),
});

export type BridgeResult =
  | {
      status: "completed";
      candidateId: number;
      jobId: number;
      runId: number;
      outputFiles: string[];
      rendererVersion: number | null;
      /** Absolute path — CLI/developer convenience only. Never written back to tailoring_runs;
       *  output_files (above) stays the portable, relative-filename record. */
      artifactDirectory: string;
    }
  | {
      status: "failed";
      errorType: "INVALID_INPUT" | "AUTHORIZATION_FAILURE" | "EXECUTION_FAILURE" | "UNEXPECTED_ERROR";
      errorCode?: string;
      message: string;
    };

/**
 * The bridge itself. Never throws — every failure mode (malformed input, authorization rejection,
 * generator/rendering failure, anything unexpected) is reported as a typed BridgeResult so a CLI
 * caller and a future non-CLI caller can both handle it deterministically without a try/catch.
 */
export async function runTailoringBridge(args: BridgeArgs): Promise<BridgeResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(args.inputPath, "utf-8"));
  } catch (err) {
    return {
      status: "failed",
      errorType: "INVALID_INPUT",
      message: `Could not read/parse --input JSON at ${args.inputPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = BRIDGE_INPUT_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "failed",
      errorType: "INVALID_INPUT",
      message: `Input JSON failed validation: ${parsed.error.message}`,
    };
  }

  try {
    const result = await executeTailoringRun({
      candidateId: args.candidateId,
      jobId: args.jobId,
      resume: parsed.data.resume as unknown as ResumeContent,
      coverLetter: parsed.data.coverLetter as unknown as CoverLetterContent,
      selectedTrack: args.selectedTrack,
      executedBy: args.executedBy,
      methodologyVersion: args.methodologyVersion,
    });

    return {
      status: "completed",
      candidateId: args.candidateId,
      jobId: args.jobId,
      runId: result.run.id,
      outputFiles: result.run.output_files ? (JSON.parse(result.run.output_files) as string[]) : [],
      rendererVersion: result.run.renderer_version,
      artifactDirectory: path.dirname(result.resumePath),
    };
  } catch (err) {
    if (err instanceof TailoringRunAuthorizationError) {
      return { status: "failed", errorType: "AUTHORIZATION_FAILURE", errorCode: err.code, message: err.message };
    }
    // generateTailoringOutputs (invalid content / failed layout validation) and any other execution-
    // time failure both land here — executeTailoringRun has already marked the run 'failed' by the
    // time this catch runs, so there is nothing further for the bridge to clean up.
    if (err instanceof Error && /layout validation|Content JSON failed validation/.test(err.message)) {
      return { status: "failed", errorType: "EXECUTION_FAILURE", message: err.message };
    }
    return {
      status: "failed",
      errorType: "UNEXPECTED_ERROR",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseArgs(argv: string[]): BridgeArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      flags.set(argv[i].slice(2), argv[i + 1]);
      i++;
    }
  }

  const candidateIdRaw = flags.get("candidate-id");
  const jobIdRaw = flags.get("job-id");
  const inputPath = flags.get("input");
  const USAGE =
    "Usage: tsx execute-run.ts --candidate-id <id> --job-id <id> --input <content.json> " +
    "[--executed-by claude-code|codex] [--selected-track <name>] [--methodology-version <n>]";
  if (!candidateIdRaw || !jobIdRaw || !inputPath) {
    throw new Error(USAGE);
  }

  const candidateId = Number(candidateIdRaw);
  if (!Number.isInteger(candidateId) || candidateId <= 0) throw new Error(`Invalid --candidate-id: ${candidateIdRaw}`);
  const jobId = Number(jobIdRaw);
  if (!Number.isInteger(jobId) || jobId <= 0) throw new Error(`Invalid --job-id: ${jobIdRaw}`);

  const executedByRaw = flags.get("executed-by");
  if (executedByRaw !== undefined && executedByRaw !== "claude-code" && executedByRaw !== "codex") {
    throw new Error(`Invalid --executed-by: ${executedByRaw} (must be "claude-code" or "codex")`);
  }

  const methodologyVersionRaw = flags.get("methodology-version");
  let methodologyVersion: number | undefined;
  if (methodologyVersionRaw !== undefined) {
    methodologyVersion = Number(methodologyVersionRaw);
    if (!Number.isInteger(methodologyVersion) || methodologyVersion <= 0) {
      throw new Error(`Invalid --methodology-version: ${methodologyVersionRaw}`);
    }
  }

  return {
    candidateId,
    jobId,
    inputPath,
    selectedTrack: flags.get("selected-track"),
    executedBy: executedByRaw as "claude-code" | "codex" | undefined,
    methodologyVersion,
  };
}

async function main() {
  let args: BridgeArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const result = await runTailoringBridge(args);

  if (result.status === "completed") {
    console.log(
      JSON.stringify(
        {
          status: result.status,
          candidateId: result.candidateId,
          jobId: result.jobId,
          runId: result.runId,
          outputFiles: result.outputFiles,
          rendererVersion: result.rendererVersion,
        },
        null,
        2
      )
    );
    console.log(`\nArtifact directory: ${result.artifactDirectory}`);
    return;
  }

  console.error(
    JSON.stringify({ status: result.status, errorType: result.errorType, errorCode: result.errorCode, message: result.message }, null, 2)
  );
  process.exit(1);
}

// Only auto-run when executed directly, not when imported as a module (see generate.ts for the
// same pattern) — lets tests import runTailoringBridge() without triggering a CLI run.
const isDirectlyExecuted = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectlyExecuted) {
  main();
}
