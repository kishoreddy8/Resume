/**
 * Stage 29 — independent, priority-aware dispatch for the background worker's four ticks.
 *
 * THE DEFECT. The worker ran its ticks in one sequential pass:
 *
 *     await scan; await production; await evaluation; await resumeWriter;
 *
 * with the resume writer LAST and production SECOND. A production cycle routinely exceeds ten
 * minutes on this Mac (one was observed holding its lease for over ten minutes during Stage 29's own
 * baseline capture), so an already-approved resume waited behind unrelated ingestion for that entire
 * time — even though tailoring itself now costs ~4m48s and CareerOps' share of that is ~1.4 seconds.
 * A second, compounding cause sat inside the writer tick: a 30-minute minimum spacing that applied
 * even when approved work was already queued.
 *
 * WHY INDEPENDENT TIMERS ARE SAFE HERE, AND WHY THEY ACTUALLY HELP. better-sqlite3 is synchronous and
 * Node is single-threaded, so two ticks in this process can never execute SQL simultaneously — there
 * is no new database concurrency to reason about, and no new contention. What separate timers change
 * is *interleaving*: the production cycle spends most of its wall time awaiting network I/O, and at
 * every one of those await points the event loop is free. Giving the writer its own timer lets it use
 * those gaps instead of queueing behind the whole cycle. Existing leases remain the authority on what
 * may run at once, exactly as before.
 *
 * WHAT THIS DOES NOT DO. It does not raise Claude concurrency (still one, enforced by the writer
 * lease), does not run two production cycles (its lease), does not add parallel database access, and
 * does not preempt or cancel anything already running. Nothing is ever killed to make room.
 */

export type TickName = "resumeWriter" | "jobEvaluation" | "scan" | "productionCycle";

/**
 * Resource classes, derived from what each tick actually does rather than from how important it feels.
 *
 *   LIGHT  — resumeWriter. Its scheduled tick is a cheap read (is anything queued?) plus, when there
 *            is work, a lease acquisition. The expensive part is an external Claude process, which
 *            does not occupy this event loop.
 *   MEDIUM — jobEvaluation. Synchronous SQLite over a bounded batch; it blocks the loop while it runs
 *            but is bounded by design (200 jobs per candidate).
 *   HEAVY  — scan and productionCycle. Long, network-bound, and the two that made the UI unusable.
 */
export type ResourceClass = "LIGHT" | "MEDIUM" | "HEAVY";

export const TICK_RESOURCE_CLASS: Record<TickName, ResourceClass> = {
  resumeWriter: "LIGHT",
  jobEvaluation: "MEDIUM",
  scan: "HEAVY",
  productionCycle: "HEAVY",
};

/**
 * Dispatch priority, lowest number first. Only ever consulted when two ticks become due in the same
 * instant — it is a tie-break, not a queue that can starve anything: each tick has its own timer and
 * therefore its own independent chance to run.
 */
export const TICK_PRIORITY: Record<TickName, number> = {
  resumeWriter: 1,
  jobEvaluation: 2,
  scan: 3,
  productionCycle: 4,
};

/**
 * How often each tick is CHECKED. Not the cadence of the work itself — every tick still makes its own
 * enabled/window/interval decision internally, unchanged. The writer is checked most often because it
 * is the one a human is actively waiting on.
 */
export const TICK_CHECK_INTERVAL_MS: Record<TickName, number> = {
  resumeWriter: 30_000,
  jobEvaluation: 60_000,
  scan: 60_000,
  productionCycle: 60_000,
};

export interface TickRuntimeState {
  /** True while this tick's own invocation is in flight. */
  running: boolean;
  startedAt: string | null;
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  lastOutcome: unknown;
  lastError: string | null;
}

export interface WorkerActivitySnapshot {
  ticks: Record<TickName, TickRuntimeState>;
  /** The single most significant thing happening now, for a one-line status. */
  currentActivity: TickName | "IDLE";
  /** Set when a HEAVY tick is running and another HEAVY tick was therefore deferred. */
  heavySlotHeldBy: TickName | null;
}

function emptyState(): TickRuntimeState {
  return { running: false, startedAt: null, lastCompletedAt: null, lastDurationMs: null, lastOutcome: null, lastError: null };
}

/**
 * Runs the four ticks on independent timers, with two bounds and nothing else:
 *
 *   1. SELF-OVERLAP GUARD — a tick is never started while its own previous invocation is still
 *      running. The pre-Stage-29 worker used `setInterval(() => void tickAll(), 60s)` with no guard
 *      at all, so a ten-minute production cycle could accumulate ten overlapping passes; only the
 *      per-subsystem leases stopped that becoming ten cycles.
 *   2. ONE HEAVY TICK AT A TIME — scan and productionCycle share a single in-process slot, so the two
 *      network-and-CPU-heavy jobs can never pile onto this 8 GB machine together. LIGHT and MEDIUM
 *      ticks are never blocked by that slot, which is precisely what keeps the writer responsive.
 *
 * Deliberately not a general job scheduler: no queue, no priorities beyond a tie-break, no dynamic
 * concurrency. Everything else — whether work is due, whether it may run at all, mutual exclusion
 * across processes — stays where it already lives, in the tick functions and their DB leases.
 */
export class WorkerScheduler {
  private readonly state: Record<TickName, TickRuntimeState> = {
    resumeWriter: emptyState(),
    jobEvaluation: emptyState(),
    scan: emptyState(),
    productionCycle: emptyState(),
  };

  private readonly timers: NodeJS.Timeout[] = [];
  private heavySlotHeldBy: TickName | null = null;
  private stopped = false;

  constructor(
    private readonly handlers: Record<TickName, () => Promise<unknown>>,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** True when this tick may start right now. Never throws, never mutates. */
  canDispatch(tick: TickName): boolean {
    if (this.stopped) return false;
    if (this.state[tick].running) return false;
    if (TICK_RESOURCE_CLASS[tick] === "HEAVY" && this.heavySlotHeldBy !== null) return false;
    return true;
  }

  /**
   * Runs one tick if it may run, and reports whether it did. Errors are recorded and swallowed: a
   * failing tick must never stop its own future dispatches, and must never affect another tick's.
   */
  async dispatch(tick: TickName): Promise<boolean> {
    if (!this.canDispatch(tick)) return false;

    const entry = this.state[tick];
    entry.running = true;
    entry.startedAt = this.now().toISOString();
    entry.lastError = null;
    if (TICK_RESOURCE_CLASS[tick] === "HEAVY") this.heavySlotHeldBy = tick;

    const startedMs = Date.now();
    try {
      entry.lastOutcome = await this.handlers[tick]();
    } catch (err) {
      entry.lastError = err instanceof Error ? err.message : String(err);
      entry.lastOutcome = null;
    } finally {
      entry.running = false;
      entry.lastCompletedAt = this.now().toISOString();
      entry.lastDurationMs = Date.now() - startedMs;
      if (this.heavySlotHeldBy === tick) this.heavySlotHeldBy = null;
    }
    return true;
  }

  /** Starts every tick's own timer, after one immediate pass in priority order (restart catch-up). */
  async start(): Promise<void> {
    const ordered = (Object.keys(TICK_PRIORITY) as TickName[]).sort((a, b) => TICK_PRIORITY[a] - TICK_PRIORITY[b]);
    // Writer first, so a workflow approved while the worker was down is picked up before a heavy
    // ingestion pass claims the heavy slot for the next ten minutes.
    for (const tick of ordered) {
      if (this.stopped) return;
      void this.dispatch(tick);
    }
    for (const tick of ordered) {
      // Deliberately NOT unref'd: these timers are the only thing keeping a standalone worker
      // process alive. Unref'ing them (correct for a timer inside a long-lived web server) makes the
      // worker exit the moment start() returns, which is exactly what happened the first time.
      this.timers.push(
        setInterval(() => {
          void this.dispatch(tick);
        }, TICK_CHECK_INTERVAL_MS[tick])
      );
    }
  }

  /** Clears every timer. In-flight synchronous work finishes; its leases go stale and are reclaimed,
   *  which is the same recovery path a crash already exercises. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  snapshot(): WorkerActivitySnapshot {
    const running = (Object.keys(TICK_PRIORITY) as TickName[])
      .filter((t) => this.state[t].running)
      .sort((a, b) => TICK_PRIORITY[a] - TICK_PRIORITY[b]);
    return {
      ticks: { ...this.state },
      currentActivity: running[0] ?? "IDLE",
      heavySlotHeldBy: this.heavySlotHeldBy,
    };
  }
}
