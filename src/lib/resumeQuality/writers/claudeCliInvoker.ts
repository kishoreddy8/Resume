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

/**
 * Stage 27 — why a writer invocation failed, as far as the CLI's own evidence can establish.
 *
 * These are OPERATIONAL classes, never quality verdicts: not one of them can mark a workflow READY,
 * consume a Stage 21 content iteration, or cause an application to be submitted. They exist so the
 * worker can react correctly (retry / stop / wait for the operator) and so the UI can tell the user
 * the truth instead of "something went wrong".
 *
 *   SUBSCRIPTION_LIMIT_REACHED — the user's Claude subscription usage limit is exhausted. Retrying
 *     sooner cannot help, and each retry burns the bounded technical budget for no reason.
 *   AUTH_REQUIRED           — the CLI is logged out or its credentials expired. Only the operator
 *     can fix this (`claude login`); automatic retries are pure noise.
 *   PROVIDER_UNAVAILABLE    — Anthropic could not serve the request (HTTP 429 without a usage-limit
 *     signal, or any 5xx; 529 Overloaded is the one observed on the real corpus). Genuinely
 *     transient — bounded retry is correct.
 *   MALFORMED_OUTPUT        — the process succeeded but produced no writer_output.json, or one that
 *     is not parseable JSON. Bounded retry.
 *   REPAIR_SCOPE_VIOLATION  — a TARGETED_REPAIR pass edited content outside its authorized editable
 *     paths. The rejected output is never accepted as a quality iteration and can never become the
 *     best attempt — but the pass itself still cost a real Claude invocation, so it must consume the
 *     same bounded technical budget as any other failed attempt rather than retrying unboundedly.
 *   TRANSIENT_TECHNICAL_FAILURE — anything else (spawn error, timeout, unexplained non-zero exit).
 */
export type WriterFailureClass =
  | "SUBSCRIPTION_LIMIT_REACHED"
  | "AUTH_REQUIRED"
  | "PROVIDER_UNAVAILABLE"
  | "MALFORMED_OUTPUT"
  | "REPAIR_SCOPE_VIOLATION"
  | "TRANSIENT_TECHNICAL_FAILURE";

/** Classes the operator (not time, and not a retry) must resolve before the writer can make progress.
 *  These deliberately do NOT consume the bounded technical-retry budget — burning that budget on a
 *  condition retrying cannot fix is exactly how an approved workflow used to end up permanently
 *  wedged (see handoffClaim.MAX_TECHNICAL_PASSES). */
export const OPERATOR_ACTIONABLE_FAILURE_CLASSES: readonly WriterFailureClass[] = [
  "SUBSCRIPTION_LIMIT_REACHED",
  "AUTH_REQUIRED",
];

/**
 * Stage 27 — truthful runtime facts reported by the CLI itself on a SUCCESSFUL run.
 *
 * Every field is nullable and is populated ONLY from the CLI's own stdout JSON. Nothing here is
 * inferred, defaulted, or hardcoded: if the CLI does not report a model, `model` stays null rather
 * than being filled with a plausible-looking guess. Verified against the installed CLI (2.1.235) by
 * a one-off print-mode probe.
 *
 * Note on `model`: a single print-mode run can report MORE than one model in `modelUsage` (the probe
 * observed a small helper model alongside the main one). The model credited here is the one that
 * produced the most output tokens — i.e. the model that actually wrote the content — which is the
 * only defensible single value. `rate_limits` is deliberately absent: the probe proved print mode
 * does not emit it, so CareerOps has no subscription reset timestamp to work from and must never
 * present one.
 */
export interface ClaudeCliRunMetadata {
  provider: string | null;
  model: string | null;
  sessionId: string | null;
  durationMs: number | null;
  numTurns: number | null;
  totalCostUsd: number | null;
}

/** The invocation route, stated as a fact we know for certain because this module performed it.
 *  Not a claim about which upstream served the request. */
export const CLAUDE_CLI_PROVIDER = "claude-cli";

export class ClaudeCliTechnicalFailure extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    /** Stage 26 — true when the CLI's own report says it failed because the PROVIDER was unavailable
     *  (HTTP 429/5xx, including 529 Overloaded), not because anything about this workflow, its
     *  evidence, or CareerOps was wrong. Callers surface this differently: a provider outage tells the
     *  user "try later", whereas an ordinary technical failure tells them something may need looking
     *  at. Never affects the quality gate or the iteration budget either way.
     *
     *  Stage 27 — retained verbatim (same meaning, same callers) and now derived from failureClass,
     *  so existing behaviour and tests are unchanged while callers that want the finer distinction
     *  can read failureClass instead. */
    public readonly providerUnavailable: boolean = false,
    /** Stage 27 — the finer classification above. Defaults to the ordinary transient case so any
     *  caller constructing this without a class keeps the pre-Stage-27 meaning. */
    public readonly failureClass: WriterFailureClass = "TRANSIENT_TECHNICAL_FAILURE"
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
  failureClass: WriterFailureClass;
}

/**
 * Stage 27 — deterministic, deliberately NARROW text signals, used ONLY when the CLI gives no
 * structured evidence for these two classes.
 *
 * The print-mode probe against CLI 2.1.235 confirmed that a successful run reports `subtype`,
 * `terminal_reason`, `api_error_status`, `usage` and `modelUsage`, but there is NO structured field
 * that names "subscription limit" or "logged out" — and no `rate_limits` block at all. So these two
 * conditions can only be recognised from the CLI's own message text.
 *
 * Kept narrow on purpose: a broad pattern that mistakes an ordinary failure for a subscription limit
 * would park an approved workflow in a waiting state it cannot leave on its own. When in doubt the
 * classifier falls through to a transient class, which retries — the safe direction to be wrong in.
 */
const SUBSCRIPTION_LIMIT_PATTERNS: readonly RegExp[] = [
  /\busage limit reached\b/i,
  /\bclaude usage limit\b/i,
  /\bmonthly (?:usage )?limit reached\b/i,
  /\byou(?:'| ha)ve (?:reached|hit) your .{0,40}\blimit\b/i,
];

const AUTH_REQUIRED_PATTERNS: readonly RegExp[] = [
  /\bplease run\b[^.]{0,20}\/login\b/i,
  /\bclaude (?:auth )?login\b/i,
  /\bnot logged in\b/i,
  /\bauthentication_error\b/i,
  /\binvalid api key\b/i,
  /\boauth token (?:has )?expired\b/i,
  /\bsession (?:has )?expired\b/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

/**
 * Stage 27 — the CLI's own truthful report of a SUCCESSFUL run, or null when stdout is absent or
 * unparseable. Never throws: metadata is a bonus, and failing to read it must never turn a perfectly
 * good writer result into a failure.
 */
export function parseCliRunMetadata(stdout: string): ClaudeCliRunMetadata | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const numberOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const stringOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

  // Credit the model that produced the most output tokens — see ClaudeCliRunMetadata's own note on
  // why a single run can legitimately report more than one.
  let model: string | null = null;
  const modelUsage = parsed.modelUsage;
  if (typeof modelUsage === "object" && modelUsage !== null) {
    let bestOutput = -1;
    for (const [key, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      const outputTokens = typeof entry.outputTokens === "number" ? entry.outputTokens : 0;
      if (outputTokens > bestOutput) {
        bestOutput = outputTokens;
        model = stringOrNull(entry.canonicalModel) ?? stringOrNull(key);
      }
    }
  }

  return {
    provider: CLAUDE_CLI_PROVIDER,
    model,
    sessionId: stringOrNull(parsed.session_id),
    durationMs: numberOrNull(parsed.duration_ms),
    numTurns: numberOrNull(parsed.num_turns),
    totalCostUsd: numberOrNull(parsed.total_cost_usd),
  };
}

/**
 * Extracts the CLI's own explanation of a non-zero exit from its stdout JSON, falling back to stderr
 * and then to the bare exit code. Parses defensively: an unparseable or unexpected payload must
 * degrade to "we could not tell why", never throw and turn a diagnosable failure into a crash.
 */
function describeCliFailure(code: number | null, stdout: string, stderr: string): CliFailureReport {
  let detail = "";
  let providerUnavailable = false;
  let status: number | null = null;

  try {
    const parsed = JSON.parse(stdout) as {
      result?: unknown;
      api_error_status?: unknown;
      terminal_reason?: unknown;
      subtype?: unknown;
    };
    status = typeof parsed.api_error_status === "number" ? parsed.api_error_status : null;
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

  // Stage 27 — structured evidence first, narrow text signals only where the CLI offers nothing
  // structured. A 401/403 is unambiguous; everything else that looks like auth or a usage limit has
  // to be read out of the message, so those patterns are kept deliberately tight (see their comment).
  const haystack = `${detail}\n${stderr}`;
  let failureClass: WriterFailureClass;
  if (status === 401 || status === 403 || matchesAny(haystack, AUTH_REQUIRED_PATTERNS)) {
    failureClass = "AUTH_REQUIRED";
  } else if (matchesAny(haystack, SUBSCRIPTION_LIMIT_PATTERNS)) {
    failureClass = "SUBSCRIPTION_LIMIT_REACHED";
  } else if (providerUnavailable) {
    failureClass = "PROVIDER_UNAVAILABLE";
  } else {
    failureClass = "TRANSIENT_TECHNICAL_FAILURE";
  }

  // An operator-actionable condition is not the provider being unable to serve us, so it must not
  // masquerade as one in the existing providerUnavailable surface.
  if (failureClass === "AUTH_REQUIRED" || failureClass === "SUBSCRIPTION_LIMIT_REACHED") {
    providerUnavailable = false;
  }

  return { message, providerUnavailable, failureClass };
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
export async function invokeClaudeWriter(
  opts: ClaudeCliInvokeOptions
): Promise<{ outputPath: string; attempts: number; metadata: ClaudeCliRunMetadata | null }> {
  if (opts.command === undefined && process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI === "1") {
    throw new ClaudeCliTechnicalFailure(
      "Refusing to spawn the real Claude CLI: CAREER_OPS_DISABLE_REAL_CLAUDE_CLI is set. Pass a fixture `command` instead.",
      0,
      false,
      "TRANSIENT_TECHNICAL_FAILURE"
    );
  }
  const command = opts.command ?? "claude";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const backoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const outputPath = path.join(opts.handoffDir, "writer_output.json");
  const attempts = DEFAULT_ATTEMPTS;

  let lastError = "unknown failure";
  let lastProviderUnavailable = false;
  let lastFailureClass: WriterFailureClass = "TRANSIENT_TECHNICAL_FAILURE";

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
        lastFailureClass = report.failureClass;
        // Stage 27 — retrying cannot resolve an exhausted subscription or a logged-out CLI, and each
        // further attempt only spends time and the caller's bounded budget. Surface it immediately so
        // the worker can park the workflow in an operator-actionable state instead.
        if (OPERATOR_ACTIONABLE_FAILURE_CLASSES.includes(lastFailureClass)) {
          throw new ClaudeCliTechnicalFailure(lastError, attempt, lastProviderUnavailable, lastFailureClass);
        }
      } else if (!fs.existsSync(outputPath)) {
        lastProviderUnavailable = false;
        lastFailureClass = "MALFORMED_OUTPUT";
        lastError = "Claude CLI exited 0 but writer_output.json was not created";
      } else {
        const raw = fs.readFileSync(outputPath, "utf-8");
        try {
          JSON.parse(raw);
          // Metadata is best-effort and never gates success: parseCliRunMetadata returns null rather
          // than throwing, so an unreadable stdout can never fail an otherwise valid writer result.
          return { outputPath, attempts: attempt, metadata: parseCliRunMetadata(stdout) };
        } catch (err) {
          lastError = `writer_output.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
          lastProviderUnavailable = false;
          lastFailureClass = "MALFORMED_OUTPUT";
        }
      }
    } catch (err) {
      // A genuine operator-actionable failure raised above must propagate untouched, not be folded
      // back into the generic retry loop.
      if (err instanceof ClaudeCliTechnicalFailure) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      lastProviderUnavailable = false;
      lastFailureClass = "TRANSIENT_TECHNICAL_FAILURE";
    }

    if (attempt < attempts) await sleep(backoffMs);
  }

  throw new ClaudeCliTechnicalFailure(
    `Claude CLI writer failed after ${attempts} attempts: ${lastError}`,
    attempts,
    lastProviderUnavailable,
    lastFailureClass
  );
}
