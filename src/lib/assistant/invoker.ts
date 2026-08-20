import { spawn } from "node:child_process";

/**
 * Ask the user's locally authenticated Claude CLI one grounded question.
 *
 * NO TOOLS AT ALL. The CLI is started with `--tools ""`: it cannot read a file, write a file, or
 * run a command. Everything it may use is in the prompt. That is not a precaution bolted on, it is
 * the design — an explanatory assistant has no business touching the filesystem, and removing the
 * capability is stronger than instructing it not to.
 *
 * NEVER ON A TIMER. This runs only when a user asks a question. There is no polling, no warm-up,
 * no call when a page opens. Every invocation is one someone chose to make.
 *
 * BILLING. This uses the user's own Claude CLI subscription — no API key is read or required
 * anywhere in this path. CAREER_OPS_DISABLE_REAL_CLAUDE_CLI is honoured before anything spawns, so
 * automated tests can never reach a real model, and a small budget cap bounds a single question.
 */

export type AssistantOutcome =
  | { ok: true; answer: string }
  | { ok: false; reason: "disabled" | "unavailable" | "timeout" | "failed"; detail: string };

const TIMEOUT_MS = 90_000;
const MAX_BUDGET_USD = 0.25;

export interface AssistantOptions {
  prompt: string;
  /** Test seam. Tests MUST pass this; without it the guard below refuses to spawn anything real. */
  command?: string;
  timeoutMs?: number;
}

export function askAssistant(opts: AssistantOptions): Promise<AssistantOutcome> {
  const command = opts.command ?? "claude";

  if (!opts.command && process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI === "1") {
    return Promise.resolve({
      ok: false,
      reason: "disabled",
      detail: "The assistant is switched off in this environment.",
    });
  }

  return new Promise<AssistantOutcome>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const args = [
      "-p",
      opts.prompt,
      "--output-format",
      "json",
      // Explicitly empty: no Read, no Write, no Bash. The prompt is the only input.
      "--tools",
      "",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--max-budget-usd",
      String(MAX_BUDGET_USD),
    ];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, reason: "unavailable", detail: String(err) });
      return;
    }

    const done = (o: AssistantOutcome) => {
      if (settled) return;
      settled = true;
      resolve(o);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, reason: "timeout", detail: "The assistant did not answer in time." });
    }, opts.timeoutMs ?? TIMEOUT_MS);

    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));

    child.on("error", (err) => {
      clearTimeout(timer);
      const notInstalled = (err as NodeJS.ErrnoException).code === "ENOENT";
      done({
        ok: false,
        reason: "unavailable",
        detail: notInstalled ? "The Claude CLI was not found on this machine." : err.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        /* stderr can carry a stack trace, which must never reach a user-facing panel. */
        done({ ok: false, reason: "failed", detail: `The assistant exited without answering (code ${code}).` });
        return;
      }
      const answer = extractAnswer(stdout);
      if (!answer) {
        done({ ok: false, reason: "failed", detail: "The assistant returned nothing usable." });
        return;
      }
      done({ ok: true, answer });
    });

    void stderr;
  });
}

/** `--output-format json` wraps the reply; fall back to raw text rather than losing a real answer. */
export function extractAnswer(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as { result?: unknown; is_error?: boolean };
    if (parsed.is_error) return null;
    if (typeof parsed.result === "string" && parsed.result.trim().length > 0) return parsed.result.trim();
  } catch {
    // Not JSON — treat the output as the answer itself.
  }
  return trimmed.length > 0 ? trimmed : null;
}
