/**
 * Stage 28 — which process is allowed to RUN the scheduled ticks.
 *
 * THE PROBLEM. Every tick (scan, ingestion, evaluation, resume writer) has always executed inside the
 * Next.js server process, via src/instrumentation.ts. Stage 27 measured what that costs on this Mac:
 * the production cycle drove the web process to 99.6% CPU and the API returned HTTP 000 for roughly
 * thirty minutes, and a process sample caught the main thread inside a single long `sqlite3_step`
 * from the evaluation tick. Node is single-threaded, so a synchronous multi-second SQLite scan or a
 * CPU-bound render blocks every in-flight HTTP request in the same process.
 *
 * THE FIX, deliberately minimal: keep the tick functions exactly as they are and move WHERE they run.
 * A separate `npm run background-worker` process runs the same four ticks against the same database,
 * and the web process stops running them. Nothing about cadence, settings, leases, catch-up, or the
 * human-approval boundary changes — only the host.
 *
 * EXACTLY ONE HOST. Two processes running the same scheduler would double every tick. That cannot be
 * left to convention, so ownership is explicit and defaults to the pre-Stage-28 behaviour:
 *
 *   CAREER_OPS_SCHEDULER_HOST unset or "web"    -> the Next.js process runs the ticks (unchanged
 *                                                  default; an existing install behaves exactly as
 *                                                  before, and `npm run dev` alone still works)
 *   CAREER_OPS_SCHEDULER_HOST = "worker"        -> ONLY the background worker runs them; the web
 *                                                  process starts no timers at all
 *   CAREER_OPS_SCHEDULER_HOST = "none"          -> nobody runs them (useful for tests/one-off CLI use)
 *
 * The worker refuses to start unless the host is "worker", and the web process checks the same
 * variable, so the two can never both be armed — the setting is a single value, not two independent
 * switches that could disagree.
 *
 * This changes NOTHING about safety: the DB leases (scan lock, production-cycle lease, machine-wide
 * writer lease) remain authoritative regardless of which process holds them, so even a
 * misconfiguration that somehow started two hosts could not run two writer passes concurrently or
 * duplicate an approved workflow — it would only waste evaluations.
 */

export type SchedulerHost = "web" | "worker" | "none";

export const SCHEDULER_HOST_ENV_VAR = "CAREER_OPS_SCHEDULER_HOST";

/** Reads the configured host. Anything unrecognised falls back to the unchanged "web" default rather
 *  than silently disabling automation. */
export function getConfiguredSchedulerHost(env: NodeJS.ProcessEnv = process.env): SchedulerHost {
  const raw = (env[SCHEDULER_HOST_ENV_VAR] ?? "").trim().toLowerCase();
  if (raw === "worker") return "worker";
  if (raw === "none") return "none";
  return "web";
}

/** True when the in-process Next.js instrumentation should start its interval timers. */
export function webProcessOwnsScheduler(env: NodeJS.ProcessEnv = process.env): boolean {
  return getConfiguredSchedulerHost(env) === "web";
}

/** True when the standalone background worker should start its interval timers. */
export function workerProcessOwnsScheduler(env: NodeJS.ProcessEnv = process.env): boolean {
  return getConfiguredSchedulerHost(env) === "worker";
}

/** One sentence for logs and the operations panel, so the active arrangement is never a guess. */
export function describeSchedulerHost(env: NodeJS.ProcessEnv = process.env): string {
  switch (getConfiguredSchedulerHost(env)) {
    case "worker":
      return `Scheduled work runs in the standalone background worker (${SCHEDULER_HOST_ENV_VAR}=worker). The web process runs no timers, so background work cannot block the UI.`;
    case "none":
      return `Scheduled work is not hosted by any process (${SCHEDULER_HOST_ENV_VAR}=none). Nothing runs automatically.`;
    default:
      return `Scheduled work runs inside the Next.js web process (${SCHEDULER_HOST_ENV_VAR} unset or "web"). Long ingestion/evaluation passes can make the UI unresponsive; set it to "worker" and run \`npm run background-worker\` to isolate them.`;
  }
}
