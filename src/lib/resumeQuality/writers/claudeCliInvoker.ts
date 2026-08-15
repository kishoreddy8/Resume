import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Stage 12 — spawns the user's own locally authenticated Claude Code CLI in a tightly sandboxed,
 * non-interactive mode to perform ONE resume-writer handoff. Never reads, stores, or extracts any
 * credential: it shells out as the same OS user, exactly like running `claude` by hand, so whatever
 * auth Claude Code already has is reused transparently — no ANTHROPIC_API_KEY, no stored token.
 *
 * Security boundary: --tools "Read,Write" means no Bash tool exists in this session at all (no git,
 * no rm, no scans — structurally unreachable, not merely policy-blocked); --add-dir scopes the only
 * writable location to the one handoff directory (the real Master Resume/Skills Inventory/
 * data/app.db/CareerOps source are never reachable, since only derived snapshots — never the
 * originals — are ever placed in a handoff directory, see exporter.ts); --safe-mode strips
 * CLAUDE.md/skills/plugins/MCP for this one call so the sandboxed writer can't invoke another skill;
 * --dangerously-skip-permissions is never used anywhere in this module.
 */

export interface ClaudeCliInvokeOptions {
  handoffDir: string;
  /** Overridable for tests — defaults to the real "claude" binary. Tests point this at a small
   *  fixture executable that deterministically simulates success/timeout/malformed output, so no
   *  automated test ever performs a real, billed Claude generation. */
  command?: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  model?: string;
  /** Overridable for tests only — production always uses the real backoff. */
  retryBackoffMs?: number;
}

export class ClaudeCliTechnicalFailure extends Error {
  constructor(
    message: string,
    public readonly attempts: number
  ) {
    super(message);
    this.name = "ClaudeCliTechnicalFailure";
  }
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_BUDGET_USD = 2;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 3_000;

const DRIVING_PROMPT =
  "Read writer_prompt.md in the current directory and follow it exactly. Read every file it " +
  "references that exists in this directory. When finished, write the single file " +
  "writer_output.json in this exact directory matching the schema in writer_prompt.md. Do not " +
  "create, modify, or delete any other file.";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildArgs(opts: ClaudeCliInvokeOptions): string[] {
  const args = [
    "-p",
    DRIVING_PROMPT,
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--tools",
    "Read,Write",
    "--add-dir",
    opts.handoffDir,
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--max-budget-usd",
    String(opts.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD),
  ];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

/** Runs one CLI attempt; resolves on process exit (any code — caller inspects), rejects only on a
 *  spawn-level error or timeout. Never throws on a non-zero exit by itself — the real signal is
 *  always "did writer_output.json land and validate", checked by the caller. */
function runOnce(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already exited.
        }
      }, 5_000);
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/**
 * Invokes the writer for one handoff directory, with a small bounded number of purely technical
 * retries (process/timeout/malformed-output failures only — never a quality judgment). Resolves once
 * writer_output.json exists at the expected path and is syntactically valid JSON; the CALLER still
 * runs it through importExternalWriterResult's own strict schema/identity validation before trusting
 * it for anything — this function only proves "the process produced parseable JSON", not "the
 * content is correct". Throws ClaudeCliTechnicalFailure only after every attempt fails — callers must
 * treat that as "no valid resume was ever produced", never as a quality-gate failure.
 */
export async function invokeClaudeWriter(opts: ClaudeCliInvokeOptions): Promise<{ outputPath: string; attempts: number }> {
  const command = opts.command ?? "claude";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const backoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const outputPath = path.join(opts.handoffDir, "writer_output.json");
  const attempts = DEFAULT_ATTEMPTS;

  let lastError = "unknown failure";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // A stale output from a prior failed attempt must never be mistaken for this attempt's result.
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath);

      const args = buildArgs(opts);
      const { code, stderr } = await runOnce(command, args, opts.handoffDir, timeoutMs);

      if (code !== 0) {
        lastError = `Claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`;
      } else if (!fs.existsSync(outputPath)) {
        lastError = "Claude CLI exited 0 but writer_output.json was not created";
      } else {
        const raw = fs.readFileSync(outputPath, "utf-8");
        try {
          JSON.parse(raw);
          return { outputPath, attempts: attempt };
        } catch (err) {
          lastError = `writer_output.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt < attempts) await sleep(backoffMs);
  }

  throw new ClaudeCliTechnicalFailure(`Claude CLI writer failed after ${attempts} attempts: ${lastError}`, attempts);
}
