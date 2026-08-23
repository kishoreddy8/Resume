import fs from "node:fs";
import path from "node:path";

/**
 * SUMMARY QUALITY + WRITER TOKEN OPTIMIZATION (2026-08-23) — deterministic, section-by-section
 * measurement of a writer handoff package, so context reduction work is guided by real numbers
 * instead of guesses.
 *
 * WHAT "READ BY WRITER" MEANS. claudeCliInvoker.ts's DRIVING_PROMPT is exactly: "Read
 * writer_prompt.md ... Read every file it references that exists in this directory." The external
 * writer is the Claude Code CLI itself, invoked with `--tools "Read,Write"` only — no Bash, no Glob —
 * so it cannot discover a file it is not explicitly told about by name. That means the real Claude
 * input-token cost is NOT "every file this package writes to disk"; it is writer_prompt.md's own
 * byte count PLUS every OTHER file whose exact filename is named somewhere inside writer_prompt.md's
 * text. A file this package writes but never names inside writer_prompt.md (confirmed empirically:
 * `writer_input.json`, `workflow_status.json`, `review.json`, `review_feedback.md`, and — a genuine
 * finding of this pass — `job_description.md`, which is named only inside buildExternalWriterReadme's
 * README.md text, never inside buildExternalWriterPrompt's own output) is written for CareerOps's own
 * bookkeeping/audit trail or for a human debugging the package by hand, but is never actually read by
 * the writer and so costs nothing in writer context, however large it is on disk.
 *
 * Every count here is BYTES (exact, from the real files) and an ESTIMATED token count derived from
 * bytes at a fixed ~4 bytes/token heuristic for English/JSON text — labeled ESTIMATED throughout,
 * never presented as an exact tokenizer count, because this repo has no tokenizer dependency and the
 * ticket this module was built for explicitly says not to add one merely for token counting.
 */

const ESTIMATED_BYTES_PER_TOKEN = 4;

export interface HandoffFileMeasurement {
  filename: string;
  bytes: number;
  /** ESTIMATED — bytes / 4, rounded up. Never an exact tokenizer count. */
  estimatedTokens: number;
  /** True when writer_prompt.md's own text names this exact filename (or this IS writer_prompt.md
   *  itself) — i.e. the Claude Code CLI writer is actually told to read it. False means the file
   *  exists in the package but costs zero writer-context tokens today. */
  readByWriter: boolean;
}

export interface HandoffContextMeasurement {
  handoffDir: string;
  files: HandoffFileMeasurement[];
  /** Every file in the package, whether or not the writer actually reads it — useful for disk-size
   *  auditing, but NOT the number that represents actual Claude context cost. */
  totalPackageBytes: number;
  totalPackageEstimatedTokens: number;
  /** Only files the writer actually reads (readByWriter === true) — THIS is the real writer-context
   *  estimate, the number that matters for the optimization this module exists to measure. */
  totalReadBytes: number;
  totalReadEstimatedTokens: number;
}

/** writer_output.json is named inside writer_prompt.md's OWN output-schema section as the file the
 *  CLI must CREATE, never one it reads for context — counting it as "read" would double-count a
 *  prior iteration's own output as if it were input the writer consumed. It is the one filename the
 *  exporter's template guarantees always means "write", never "read", so it is excluded outright
 *  rather than attempting to parse read-vs-write intent from surrounding prose. */
const WRITE_ONLY_FILENAME = "writer_output.json";

/** Every filename writer_prompt.md's own text names, extracted by pattern rather than a fixed list
 *  so this stays correct if the prompt's own referenced-file set ever changes. Matches a backtick-
 *  quoted bare filename with one of the extensions this package actually uses. */
function referencedFilenames(writerPromptText: string): Set<string> {
  const matches = writerPromptText.matchAll(/`([\w.-]+\.(?:md|json|txt))`/g);
  return new Set([...matches].map((m) => m[1]).filter((f) => f !== WRITE_ONLY_FILENAME));
}

/**
 * Measures every file actually present in a handoff directory (a real exported package, or a test
 * fixture directory shaped like one). Deterministic: two calls against the same unchanged directory
 * always return byte-identical results — this is a pure filesystem read, no network, no randomness.
 */
export function measureHandoffContext(handoffDir: string): HandoffContextMeasurement {
  const promptPath = path.join(handoffDir, "writer_prompt.md");
  const writerPromptText = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf-8") : "";
  const referenced = referencedFilenames(writerPromptText);

  const filenames = fs.existsSync(handoffDir)
    ? fs.readdirSync(handoffDir).filter((f) => fs.statSync(path.join(handoffDir, f)).isFile())
    : [];

  const files: HandoffFileMeasurement[] = filenames
    .map((filename) => {
      const bytes = fs.statSync(path.join(handoffDir, filename)).size;
      return {
        filename,
        bytes,
        estimatedTokens: Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN),
        readByWriter: filename === "writer_prompt.md" || referenced.has(filename),
      };
    })
    .sort((a, b) => b.bytes - a.bytes);

  const totalPackageBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  const readFiles = files.filter((f) => f.readByWriter);
  const totalReadBytes = readFiles.reduce((sum, f) => sum + f.bytes, 0);

  return {
    handoffDir,
    files,
    totalPackageBytes,
    totalPackageEstimatedTokens: Math.ceil(totalPackageBytes / ESTIMATED_BYTES_PER_TOKEN),
    totalReadBytes,
    totalReadEstimatedTokens: Math.ceil(totalReadBytes / ESTIMATED_BYTES_PER_TOKEN),
  };
}

/** A stable, human-readable before/after comparison — the exact shape Section 13/D-E of the
 *  SUMMARY QUALITY + WRITER TOKEN OPTIMIZATION report needs, computed once so the report and any
 *  future caller never hand-compute the percentage differently. */
export interface ContextReductionComparison {
  beforeBytes: number;
  afterBytes: number;
  beforeEstimatedTokens: number;
  afterEstimatedTokens: number;
  absoluteReductionBytes: number;
  /** 0-100, rounded to one decimal. 0 when beforeBytes is 0 (never divides by zero). */
  percentageReduction: number;
}

export function compareHandoffContext(before: HandoffContextMeasurement, after: HandoffContextMeasurement): ContextReductionComparison {
  const beforeBytes = before.totalReadBytes;
  const afterBytes = after.totalReadBytes;
  const absoluteReductionBytes = beforeBytes - afterBytes;
  const percentageReduction = beforeBytes > 0 ? Math.round((absoluteReductionBytes / beforeBytes) * 1000) / 10 : 0;
  return {
    beforeBytes,
    afterBytes,
    beforeEstimatedTokens: before.totalReadEstimatedTokens,
    afterEstimatedTokens: after.totalReadEstimatedTokens,
    absoluteReductionBytes,
    percentageReduction,
  };
}
