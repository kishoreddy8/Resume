import { spawn } from "node:child_process";

/**
 * Whether the local Claude CLI is actually usable, verified rather than assumed.
 *
 * WHY THIS EXISTS. Without it the first sign that the CLI is missing is a profile build that dies
 * two minutes after someone finished uploading their documents. Checking up front turns that dead
 * end into a sentence they can act on before they invest the time.
 *
 * WHY IT IS HONEST. The check runs `claude --version`, which starts the real binary the build
 * would use and costs nothing — no model call, no tokens, no subscription usage. That is the only
 * claim it makes. It deliberately does NOT report anything like "Claude connected": nothing here
 * verifies an authenticated session, and asserting one from a version string would be inventing a
 * fact. "Installed" is what was checked, so "installed" is what it says.
 *
 * This app uses the user's locally authenticated Claude CLI subscription. No API key is read,
 * sent, or required anywhere in this path.
 */

export type CliStatus =
  /** The binary ran and reported a version. Says nothing about whether a session is signed in. */
  | { state: "installed"; version: string }
  /** Deliberately switched off for this environment by the billing guard. */
  | { state: "disabled" }
  /** Not on PATH, or it could not be started. */
  | { state: "unavailable"; detail: string };

/* Cached for the life of the server process: installing or removing a CLI mid-session is not a
 * case worth re-probing for on every page load, and this spawns a real process. */
let cached: CliStatus | null = null;
let inFlight: Promise<CliStatus> | null = null;

const PROBE_TIMEOUT_MS = 5000;

function probe(): Promise<CliStatus> {
  return new Promise<CliStatus>((resolve) => {
    let settled = false;
    const done = (s: CliStatus) => {
      if (settled) return;
      settled = true;
      resolve(s);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("claude", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      done({ state: "unavailable", detail: String(err) });
      return;
    }

    let out = "";
    child.stdout?.on("data", (d) => (out += String(d)));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ state: "unavailable", detail: "The Claude CLI did not respond." });
    }, PROBE_TIMEOUT_MS);

    child.on("error", () => {
      clearTimeout(timer);
      done({ state: "unavailable", detail: "The Claude CLI was not found on this machine." });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !out.trim()) {
        done({ state: "unavailable", detail: "The Claude CLI did not report a version." });
        return;
      }
      done({ state: "installed", version: out.trim().split("\n")[0].slice(0, 60) });
    });
  });
}

export async function getCliStatus(): Promise<CliStatus> {
  // The billing guard is authoritative and checked before anything is spawned.
  if (process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI === "1") return { state: "disabled" };
  if (cached) return cached;
  // Concurrent callers share one probe rather than each starting their own process.
  if (!inFlight) {
    inFlight = probe().then((s) => {
      cached = s;
      inFlight = null;
      return s;
    });
  }
  return inFlight;
}
