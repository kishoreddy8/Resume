/**
 * Next.js instrumentation entry point (Phase 4 Stage 1). `register()` is called once when a new
 * Next.js server instance initializes, before it starts handling requests — stable since v15.0.0
 * (v13.2.0 as an experimental feature), confirmed via node_modules/next/dist/docs/.../
 * instrumentation.md. This is the Next.js-blessed place to start the scheduler's in-process
 * interval timer; there is no custom server in this project (next.config.ts is default/minimal) and
 * none is being introduced here.
 *
 * `register()` runs in both the Node.js and Edge runtimes — guarded below with NEXT_RUNTIME so the
 * timer (which needs setInterval + better-sqlite3, neither meaningful/available under Edge) is only
 * ever started once, under Node.js.
 *
 * Starting the app with the scheduler disabled must create no scans: this file only ever starts a
 * periodic CHECK — every actual run/no-run decision, including whether the scheduler is enabled at
 * all, happens fresh inside runSchedulerTick() (src/lib/scheduler/tick.ts) on every tick. Nothing
 * here reads or caches `scheduler.enabled` itself.
 */

let schedulerTimerStarted = false;

// How often to CHECK whether a scan is due — not the scan cadence itself, which is governed by
// scheduler.intervalMinutes (min 30, enforced in src/lib/settings.ts's SCHEDULER_BOUNDS) inside
// runSchedulerTick. A 60s check interval notices a newly-due window/interval promptly without
// meaningfully polling the DB.
const TICK_CHECK_INTERVAL_MS = 60_000;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Defense-in-depth against Next.js dev-mode re-invoking this module more than once per actual
  // process lifetime — register() is documented to run once per server instance, but this guard
  // ensures a second call (however it might happen) can never start a second overlapping timer.
  if (schedulerTimerStarted) return;
  schedulerTimerStarted = true;

  const { runSchedulerTick } = await import("@/lib/scheduler/tick");

  const tick = () => {
    runSchedulerTick().catch((err) => {
      // runSchedulerTick() is designed to never throw — every failure path resolves to a FAILED
      // outcome instead. This catch is a last-resort safety net only, so a truly unexpected error
      // can never take down the interval timer itself.
      console.error("[scheduler] unexpected error in runSchedulerTick:", err);
    });
  };

  // Run once immediately (restart safety: if a scan was already due before this server instance
  // started, don't make it wait up to TICK_CHECK_INTERVAL_MS to be noticed), then on a fixed
  // interval thereafter.
  tick();
  setInterval(tick, TICK_CHECK_INTERVAL_MS);
}
