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
 *
 * Stage 26 — CAREER_OPS_DISABLE_REAL_CLAUDE_CLI=1 makes the DEFAULT command refuse to spawn. Set it
 * in every automated test's setup: `command` is overridable precisely so tests use a fixture
 * executable, but "overridable" is not a guarantee — a test (or a new caller reached indirectly, e.g.
 * through the scheduler tick) that simply forgets to pass one would otherwise perform a real, billed
 * generation against the user's subscription. This turns that mistake into an immediate, loud
 * technical failure instead of a silent charge.
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
    public readonly attempts: number,
    /** Stage 26 — true when the CLI's own report says it failed because the PROVIDER was unavailable
     *  (HTTP 429/5xx, including 529 Overloaded), not because anything about this workflow, its
     *  evidence, or CareerOps was wrong. Callers surface this differently: a provider outage tells the
     *  user "try later", whereas an ordinary technical failure tells them something may need looking
     *  at. Never affects the quality gate or the iteration budget either way. */
    public readonly providerUnavailable: boolean = false
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
 *  always "did writer_output.json land and validate", checked by the caller.
 *
 *  Stage 26 — stdout is captured, not discarded. Under `--output-format json` the CLI reports WHY it
 *  failed in its stdout JSON (`is_error`, `result`, `api_error_status`, `terminal_reason`) and exits
 *  non-zero with an unhelpful or empty stderr. Capturing only stderr produced real failure messages
 *  that read literally "Claude CLI exited with code 1: " — observed on the real corpus, where the
 *  actual cause was an HTTP 529 Overloaded that was completely invisible to the operator. */
function runOnce(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
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

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
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
      resolve({ code, stdout, stderr });
    });
  });
}

interface CliFailureReport {
  message: string;
  providerUnavailable: boolean;
}

/**
 * Extracts the CLI's own explanation of a non-zero exit from its stdout JSON, falling back to stderr
 * and then to the bare exit code. Parses defensively: an unparseable or unexpected payload must
 * degrade to "we could not tell why", never throw and turn a diagnosable failure into a crash.
 */
function describeCliFailure(code: number | null, stdout: string, stderr: string): CliFailureReport {
  let detail = "";
  let providerUnavailable = false;

  try {
    const parsed = JSON.parse(stdout) as {
      result?: unknown;
      api_error_status?: unknown;
      terminal_reason?: unknown;
      subtype?: unknown;
    };
    const status = typeof parsed.api_error_status === "number" ? parsed.api_error_status : null;
    // 429 (rate limited) and any 5xx — 529 Overloaded is the one observed in practice — are the
    // provider being unable to serve the request, not a problem with this resume or this workflow.
    providerUnavailable = parsed.terminal_reason === "api_error" || status === 429 || (status !== null && status >= 500);
    const parts: string[] = [];
    if (typeof parsed.result === "string" && parsed.result.trim()) parts.push(parsed.result.trim());
    if (status !== null) parts.push(`(HTTP ${status})`);
    if (typeof parsed.terminal_reason === "string" && parsed.terminal_reason) parts.push(`[${parsed.terminal_reason}]`);
    detail = parts.join(" ");
  } catch {
    // Not JSON (or no stdout at all) — fall through to the raw streams below.
  }

  if (!detail) detail = stderr.trim() || stdout.trim();
  const message = detail
    ? `Claude CLI exited with code ${code}: ${detail.slice(0, 500)}`
    : `Claude CLI exited with code ${code} without reporting a reason on stdout or stderr`;
  return { message, providerUnavailable };
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
  if (opts.command === undefined && process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI === "1") {
    throw new ClaudeCliTechnicalFailure(
      "Refusing to spawn the real Claude CLI: CAREER_OPS_DISABLE_REAL_CLAUDE_CLI is set. Pass a fixture `command` instead.",
      0
    );
  }
  const command = opts.command ?? "claude";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const backoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const outputPath = path.join(opts.handoffDir, "writer_output.json");
  const attempts = DEFAULT_ATTEMPTS;

  let lastError = "unknown failure";
  let lastProviderUnavailable = false;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // A stale output from a prior failed attempt must never be mistaken for this attempt's result.
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath);

      const args = buildArgs(opts);
      const { code, stdout, stderr } = await runOnce(command, args, opts.handoffDir, timeoutMs);

      if (code !== 0) {
        const report = describeCliFailure(code, stdout, stderr);
        lastError = report.message;
        lastProviderUnavailable = report.providerUnavailable;
      } else if (!fs.existsSync(outputPath)) {
        lastProviderUnavailable = false;
        lastError = "Claude CLI exited 0 but writer_output.json was not created";
      } else {
        const raw = fs.readFileSync(outputPath, "utf-8");
        try {
          JSON.parse(raw);
          return { outputPath, attempts: attempt };
        } catch (err) {
          lastError = `writer_output.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
          lastProviderUnavailable = false;
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastProviderUnavailable = false;
    }

    if (attempt < attempts) await sleep(backoffMs);
  }

  throw new ClaudeCliTechnicalFailure(
    `Claude CLI writer failed after ${attempts} attempts: ${lastError}`,
    attempts,
    lastProviderUnavailable
  );
}
