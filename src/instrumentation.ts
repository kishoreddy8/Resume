/**
 * Next.js instrumentation entry point (Phase 4 Stage 1; Stage 23 added the production-cycle tick;
 * Stage 24A added the job-evaluation tick; Stage 26 added the resume-writer tick below).
 * `register()` is called once when a new Next.js server instance initializes, before it starts handling requests — stable since v15.0.0 (v13.2.0 as
 * an experimental feature), confirmed via node_modules/next/dist/docs/.../instrumentation.md. This
 * is the Next.js-blessed place to start in-process interval timers; there is no custom server in
 * this project (next.config.ts is default/minimal) and none is being introduced here.
 *
 * IMPORTANT — this is a purely local, single-machine scheduling model: both timers below only run
 * for as long as THIS Node.js process (`next dev` / `next start`) is alive. There is no cloud cron,
 * no external scheduler, no wake-on-schedule mechanism. If the Mac is asleep, shut down, or the app
 * isn't running, NOTHING here fires — scheduled production cycles and scans simply don't happen
 * until the app is running again, at which point the "run once immediately" restart-safety behavior
 * below picks up whatever became overdue while it was down. Do not treat this as cloud-like
 * reliability; if that's ever needed, it requires a genuinely different deployment (e.g. an external
 * cron hitting an API route, or a hosted always-on process), which is out of scope here.
 *
 * `register()` runs in both the Node.js and Edge runtimes — guarded below with NEXT_RUNTIME so the
 * timers (which need setInterval + better-sqlite3, neither meaningful/available under Edge) are only
 * ever started once, under Node.js.
 *
 * Starting the app with the scheduler disabled must create no scans/cycles: this file only ever
 * starts periodic CHECKS — every actual run/no-run decision, including whether the scheduler is
 * enabled at all, happens fresh inside runSchedulerTick() (src/lib/scheduler/tick.ts) and
 * runProductionCycleTick() (src/lib/production/tick.ts) on every tick. Nothing here reads or caches
 * `scheduler.enabled` itself.
 */

let schedulerTimerStarted = false;

// How often to CHECK whether a scan/cycle is due — not the cadence itself, which is governed by
// scheduler.intervalMinutes (min 30, enforced in src/lib/settings.ts's SCHEDULER_BOUNDS) inside
// runSchedulerTick, and by PRODUCTION_CYCLE_INTERVAL_MINUTES (src/lib/production/tick.ts) inside
// runProductionCycleTick. A 60s check interval notices a newly-due window/interval promptly without
// meaningfully polling the DB.
const TICK_CHECK_INTERVAL_MS = 60_000;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Defense-in-depth against Next.js dev-mode re-invoking this module more than once per actual
  // process lifetime — register() is documented to run once per server instance, but this guard
  // ensures a second call (however it might happen) can never start a second overlapping timer.
  if (schedulerTimerStarted) return;
  schedulerTimerStarted = true;

  // Stage 28 — the web process only hosts the scheduler when it is configured to. Default is
  // unchanged ("web"), so an existing install behaves exactly as before and `npm run dev` alone still
  // runs everything. With CAREER_OPS_SCHEDULER_HOST=worker the timers below are never armed here and
  // `npm run background-worker` owns them instead, which is what stops a long ingestion or evaluation
  // pass from blocking this process's event loop (Stage 27 measured 99.6% CPU and HTTP 000 for ~30
  // minutes). Exactly one host is possible because both processes read this same single value.
  const { describeSchedulerHost, webProcessOwnsScheduler } = await import("@/lib/scheduler/host");
  if (!webProcessOwnsScheduler()) {
    console.log(`[scheduler] ${describeSchedulerHost()}`);
    return;
  }

  const { runSchedulerTick } = await import("@/lib/scheduler/tick");
  const { runProductionCycleTick } = await import("@/lib/production/tick");
  const { runJobEvaluationTick } = await import("@/lib/match/tick");
  const { runResumeWriterTick } = await import("@/lib/resumeQuality/writers/tick");
  const { closeDbConnection } = await import("@/db");
  const { handleDbFailure } = await import("@/db/health");

  /**
   * Stage 25B — the ticks are where a poisoned SQLite handle actually showed up in production: the
   * scheduler tick logged `database disk image is malformed` every 60 seconds for over six hours
   * while nothing reopened the connection. Classifying the failure here discards the dead handle so
   * the very next tick (and every API request in between) gets a healthy one. Nothing is retried in
   * place — these ticks are already idempotent and will simply run again on their own schedule,
   * which is exactly the safe way to recover work that may have half-completed.
   */
  const onTickError = (scope: string, err: unknown) => {
    const outcome = handleDbFailure(err, closeDbConnection);
    if (outcome === "unrelated") {
      console.error(`[${scope}] unexpected error:`, err);
      return;
    }
    console.error(`[${scope}] database connection failure; recovery outcome: ${outcome}`);
  };

  const tick = () => {
    runSchedulerTick().catch((err) => {
      // runSchedulerTick() is designed to never throw — every failure path resolves to a FAILED
      // outcome instead. This catch is a last-resort safety net only, so a truly unexpected error
      // can never take down the interval timer itself.
      onTickError("scheduler", err);
    });
  };

  const productionCycleTick = () => {
    // Same never-throw contract as runSchedulerTick — see runProductionCycleTick's own doc comment.
    // Independent lock (the production-cycle lease, not the scan lock), so this can never contend
    // with a concurrently-running scheduled scan for the same mutex.
    runProductionCycleTick().catch((err) => {
      onTickError("production-cycle", err);
    });
  };

  const jobEvaluationTick = () => {
    // Same never-throw contract — see runJobEvaluationTick's own doc comment for why this is a
    // separate tick from productionCycleTick rather than a phase inside runProductionCycle().
    runJobEvaluationTick().catch((err) => {
      onTickError("job-evaluation", err);
    });
  };

  const resumeWriterTick = () => {
    // Stage 26 — the fourth tick on this same timer. Same never-throw contract as the other three.
    // Its own mutual exclusion is a machine-wide DB lease (src/lib/resumeQuality/writers/writerState.ts),
    // independent of the scan lock and the production-cycle lease, and shared with the standalone
    // `npm run resume-writer-worker-continuous` entrypoint — so neither can invoke Claude while the
    // other is mid-pass, and a Mac that sleeps mid-pass leaves a lease that goes stale and is
    // reclaimed rather than a duplicate run.
    runResumeWriterTick().catch((err) => {
      onTickError("resume-writer", err);
    });
  };

  // Run once immediately (restart safety: if a scan/cycle/evaluation was already due before this
  // server instance started — e.g. the Mac was asleep past the scheduled window — don't make it
  // wait up to TICK_CHECK_INTERVAL_MS to be noticed, and don't require more than this ONE immediate
  // catch-up attempt; isIntervalDue's own bookkeeping naturally prevents a burst of back-to-back
  // catch-up cycles once this one starts), then on a fixed interval thereafter.
  tick();
  productionCycleTick();
  jobEvaluationTick();
  resumeWriterTick();
  setInterval(tick, TICK_CHECK_INTERVAL_MS);
  setInterval(productionCycleTick, TICK_CHECK_INTERVAL_MS);
  setInterval(jobEvaluationTick, TICK_CHECK_INTERVAL_MS);
  setInterval(resumeWriterTick, TICK_CHECK_INTERVAL_MS);
}
