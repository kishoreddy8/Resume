import fs from "node:fs";
import path from "node:path";
import type { ResumeWriterAgent, ResumeWriterInput, ResumeWriterOutput } from "../types";
import { getHandoffDirectory, type QualityWorkflowLocation } from "../workspace";
import { buildPatchContext, importExternalWriterResult } from "../handoff/importer";
import { ResumeQualityOrchestrationError } from "../orchestrator";

export class ExternalWriterResultNotReadyError extends ResumeQualityOrchestrationError {
  constructor(outputPath: string, iterationNumber: number) {
    super(
      "EXTERNAL_RESULT_NOT_READY",
      `External writer output is not ready. Expected output file at: ${outputPath} for iteration ${iterationNumber}`
    );
    this.name = "ExternalWriterResultNotReadyError";
  }
}

export interface ExternalFileResumeWriterOptions {
  /** Optional explicit override path to the writer_output.json file */
  outputPath?: string;
  /** Optional resolver function to locate writer_output.json dynamically */
  resolveOutputPath?: (input: ResumeWriterInput) => string;
}

/**
 * Provider-independent ResumeWriterAgent adapter that imports results produced
 * by external subscription agents (Claude Code, Codex, Antigravity, local agents).
 *
 * Does NOT call any network APIs. Reads and validates the file-based writer_output.json.
 */
export class ExternalFileResumeWriter implements ResumeWriterAgent {
  private readonly options: ExternalFileResumeWriterOptions;

  constructor(options: ExternalFileResumeWriterOptions = {}) {
    this.options = options;
  }

  async generate(input: ResumeWriterInput): Promise<ResumeWriterOutput> {
    const targetIteration = input.iterationNumber ?? (input.priorIteration ? input.priorIteration.iterationNumber + 1 : 1);

    let outputFilePath: string;

    if (this.options.outputPath) {
      outputFilePath = path.resolve(this.options.outputPath);
    } else if (this.options.resolveOutputPath) {
      outputFilePath = path.resolve(this.options.resolveOutputPath(input));
    } else {
      if (!input.dedupeKey) {
        throw new ResumeQualityOrchestrationError(
          "MISSING_DEDUPE_KEY",
          "ResumeWriterInput must include dedupeKey to locate default handoff directory"
        );
      }
      const location: QualityWorkflowLocation = {
        candidateId: input.candidateId,
        dedupeKey: input.dedupeKey,
        runId: input.tailoringRunId,
        workflowId: input.workflowId,
      };
      const handoffDir = getHandoffDirectory(location, targetIteration);
      outputFilePath = path.join(handoffDir, "writer_output.json");
    }

    if (!fs.existsSync(outputFilePath)) {
      throw new ExternalWriterResultNotReadyError(outputFilePath, targetIteration);
    }

    const importRes = importExternalWriterResult({
      candidateId: input.candidateId,
      workflowId: input.workflowId,
      expectedIterationNumber: targetIteration,
      inputPath: outputFilePath,
      // PATCH-BASED TARGETED_REPAIR (2026-08-23) — only meaningful (and only consulted by the
      // importer) if the writer actually returned a schemaVersion 2 patch response; a legacy
      // full-document response ignores this entirely. `input` is this same ResumeWriterInput the
      // exporter built the handoff from, so `currentResume`/`currentCoverLetter`/`repairPlan` here
      // are the EXACT baseline and editable-path allowlist the writer was told about — never
      // re-derived independently.
      patchContext: buildPatchContext(input),
    });

    return importRes.writerOutput;
  }
}
