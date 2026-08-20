import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { extractDocxText } from "./docxText";

/**
 * Builds candidate-profile.json by spawning the user's own locally authenticated Claude Code CLI.
 *
 * WHY THE CLI AND NOT THE IN-APP AI LAYER. The app's AI layer has exactly one provider (OpenAI,
 * gated on OPENAI_API_KEY) and no key is configured. More importantly, the user asked for this to
 * run on their Claude subscription — and a claude.ai subscription is not API credentials. The only
 * thing that genuinely runs on it is Claude Code itself. So this shells out as the same OS user,
 * exactly like typing `claude` by hand: no ANTHROPIC_API_KEY, no stored token, no separate billing.
 *
 * This deliberately does NOT reuse src/lib/resumeQuality/writers/claudeCliInvoker.ts. That module is
 * Stage 21 writer infrastructure with its own failure taxonomy and concurrency rules; profile
 * building is a different job with different inputs, and coupling them would mean every change here
 * risks the resume writer. The security shape is copied on purpose, though — it is the right shape.
 *
 * SANDBOX. --tools "Read,Write" means no Bash exists in the session at all (not policy-blocked,
 * structurally absent). --add-dir scopes the only reachable directory to THIS candidate's own
 * folder, so one candidate's build can never read or write another's — the isolation property that
 * matters most when several people share the install. --safe-mode strips CLAUDE.md, skills, plugins
 * and MCP so the sandboxed session cannot invoke anything else. --dangerously-skip-permissions is
 * never used.
 *
 * BILLING GUARD. CAREER_OPS_DISABLE_REAL_CLAUDE_CLI=1 makes the default command refuse to spawn, so
 * a test that forgets to pass a fixture command fails loudly instead of silently charging a real
 * generation. Same discipline as the writer.
 */

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_BUDGET_USD = 1.5;

export interface BuildProfileOptions {
  candidateId: number;
  /** The candidate's own data/candidates/<id> directory — the only path the CLI may touch. */
  candidateDir: string;
  /** Overridable for tests only; production uses the real binary. */
  command?: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  model?: string;
}

export type BuildProfileOutcome =
  | { ok: true; rawStdout: string }
  | { ok: false; reason: "disabled" | "spawn_failed" | "timeout" | "cli_error"; detail: string };

function drivingPrompt(candidateId: number, resumeSha: string, skillsSha: string): string {
  return [
    `Build the derived candidate profile index for candidate ${candidateId}.`,
    "",
    "Read these two plain-text files in the directory you have been given access to:",
    "  master/.extracted-resume.txt   — the Master Resume, text extracted verbatim",
    "  master/.extracted-skills.txt   — the Master Skills Inventory, text extracted verbatim",
    "",
    "Use these EXACT values for sourceHashes — they are the hashes of the original .docx files,",
    "which you cannot see. Do not compute or invent them:",
    `  resume: ${resumeSha}`,
    `  skills: ${skillsSha}`,
    "",
    "Write candidate-profile.json in that same directory, matching this exact shape:",
    "{",
    '  "schemaVersion": 1,',
    '  "sourceHashes": { "resume": "<the resume hash given above>", "skills": "<the skills hash given above>" },',
    '  "builtAt": "<ISO 8601 timestamp>",',
    '  "skills": [{ "rawSkillName": string, "source": "employer" | "inventory_only",',
    '               "attributedTo"?: [{ "employer": string, "project"?: string }],',
    '               "yearsStated"?: number }],',
    '  "experience": [{ "employer": string, "title": string, "startDate": string|null,',
    '                   "endDate": string|null, "technologies": string[] }],',
    '  "education": [{ "level": string, "field": string|null, "institution": string|null }],',
    '  "certifications": [{ "name": string, "issuer"?: string }],',
    '  "totalYearsExperience": number | null',
    "}",
    "",
    "RULES THAT MATTER MORE THAN COMPLETENESS:",
    "1. source must be \"employer\" ONLY when the resume attributes that skill to a named employer's",
    "   work. If it appears solely in the Skills Inventory, it is \"inventory_only\". This distinction",
    "   decides whether the system will recommend applying, so never upgrade a skill you are unsure of.",
    "2. yearsStated only when the document STATES a number for that specific skill. Never infer it",
    "   from how long someone worked somewhere.",
    "3. totalYearsExperience only if a total is explicitly stated; otherwise null. Never compute it",
    "   from employment dates.",
    "4. Never invent an employer, skill, certification, date or technology that is not in the files.",
    "   Omitting something real is recoverable; inventing something is not.",
    "",
    "Write only that one file. Output nothing else.",
  ].join("\n");
}

function buildArgs(opts: BuildProfileOptions, resumeSha: string, skillsSha: string): string[] {
  const args = [
    "-p",
    drivingPrompt(opts.candidateId, resumeSha, skillsSha),
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--tools",
    "Read,Write",
    "--add-dir",
    opts.candidateDir,
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--max-budget-usd",
    String(opts.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD),
  ];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

/**
 * Extract both documents to plain text beside them, so the sandboxed CLI can actually read them.
 *
 * Dot-prefixed and deleted afterwards: these are a transport detail between two processes, not
 * something a user should find in their folder wondering whether it is authoritative.
 */
async function stageExtractedText(candidateDir: string): Promise<{ resumeSha: string; skillsSha: string } | null> {
  const master = path.join(candidateDir, "master");
  const resume = path.join(master, "resume.docx");
  const skills = path.join(master, "skills.docx");
  if (!fs.existsSync(resume) || !fs.existsSync(skills)) return null;
  const r = await extractDocxText(resume);
  const s = await extractDocxText(skills);
  fs.writeFileSync(path.join(master, ".extracted-resume.txt"), r.text);
  fs.writeFileSync(path.join(master, ".extracted-skills.txt"), s.text);
  return { resumeSha: r.sha256, skillsSha: s.sha256 };
}

function clearExtractedText(candidateDir: string): void {
  for (const f of [".extracted-resume.txt", ".extracted-skills.txt"]) {
    const p = path.join(candidateDir, "master", f);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
}

export async function invokeProfileBuild(opts: BuildProfileOptions): Promise<BuildProfileOutcome> {
  const command = opts.command ?? "claude";
  if (!opts.command && process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI === "1") {
    return {
      ok: false,
      reason: "disabled",
      detail:
        "Real Claude CLI invocation is disabled (CAREER_OPS_DISABLE_REAL_CLAUDE_CLI=1). Tests must pass an explicit fixture command.",
    };
  }
  if (!fs.existsSync(path.join(opts.candidateDir, "master", "resume.docx"))) {
    return { ok: false, reason: "cli_error", detail: "Master Resume is not uploaded for this candidate." };
  }

  /* The CLI cannot open a .docx: Read rejects it as binary and the sandbox has no Bash to unzip
   * with. Extract to text first — see docxText.ts for why that boundary is the right one. */
  let hashes: { resumeSha: string; skillsSha: string } | null;
  try {
    hashes = await stageExtractedText(opts.candidateDir);
  } catch (err) {
    return { ok: false, reason: "cli_error", detail: `Could not read the uploaded documents: ${String(err)}` };
  }
  if (!hashes) {
    return { ok: false, reason: "cli_error", detail: "Both a Master Resume and a Skills Inventory must be uploaded." };
  }

  return new Promise<BuildProfileOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, buildArgs(opts, hashes.resumeSha, hashes.skillsSha), {
      cwd: opts.candidateDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      clearExtractedText(opts.candidateDir);
      resolve({ ok: false, reason: "timeout", detail: `Profile build exceeded ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.` });
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearExtractedText(opts.candidateDir);
      resolve({ ok: false, reason: "spawn_failed", detail: err.message });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearExtractedText(opts.candidateDir);
      // A non-zero exit is not the real signal — the caller checks whether a VALID profile landed.
      // stdout is captured because --output-format json reports the actual reason there.
      if (code !== 0) {
        resolve({ ok: false, reason: "cli_error", detail: `exit ${code}: ${stderr.trim() || stdout.slice(0, 400)}` });
        return;
      }
      resolve({ ok: true, rawStdout: stdout });
    });
  });
}
