import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TICK_CHECK_INTERVAL_MS,
  TICK_PRIORITY,
  TICK_RESOURCE_CLASS,
  WorkerScheduler,
  type TickName,
} from "../workerScheduler";

/**
 * Stage 29 — the scheduling property that matters: an approved resume is never stuck behind
 * unrelated ingestion.
 *
 * Pure: no database, no filesystem, no network, no Claude. Every "tick" here is a controllable
 * promise, so the ordering guarantees are proven deterministically rather than by timing.
 */

/** A handler whose completion this test controls. */
function deferred(): { promise: Promise<string>; resolve: () => void; started: () => boolean } {
  let started = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const promise = (async () => {
    started = true;
    await gate;
    return "done";
  })();
  return { promise, resolve: release, started: () => started };
}

function handlers(overrides: Partial<Record<TickName, () => Promise<unknown>>> = {}) {
  const calls: TickName[] = [];
  const base: Record<TickName, () => Promise<unknown>> = {
    resumeWriter: async () => {
      calls.push("resumeWriter");
      return "writer";
    },
    jobEvaluation: async () => {
      calls.push("jobEvaluation");
      return "eval";
    },
    scan: async () => {
      calls.push("scan");
      return "scan";
    },
    productionCycle: async () => {
      calls.push("productionCycle");
      return "production";
    },
  };
  return { handlers: { ...base, ...overrides }, calls };
}

// =================================================================================================
// Writer priority — the Stage 29 defect
// =================================================================================================

test("S29-01 writer dispatches first when nothing is running", async () => {
  const { handlers: h, calls } = handlers();
  const s = new WorkerScheduler(h);
  await s.start();
  s.stop();
  assert.equal(calls[0], "resumeWriter", "the writer must be the first tick attempted on startup");
  assert.deepEqual(
    [...calls].sort((a, b) => TICK_PRIORITY[a] - TICK_PRIORITY[b]),
    calls,
    "startup dispatch must follow priority order"
  );
});

test("S29-02/03/04 a running scan, evaluation, or production never blocks the writer", async () => {
  for (const blocker of ["scan", "jobEvaluation", "productionCycle"] as const) {
    const slow = deferred();
    const { handlers: h, calls } = handlers({ [blocker]: () => slow.promise });
    const s = new WorkerScheduler(h);

    // Start the long-running tick and leave it in flight — this is the ten-minute production cycle.
    const blockerRun = s.dispatch(blocker);
    assert.equal(s.canDispatch("resumeWriter"), true, `${blocker} in flight must not block the writer`);

    const dispatched = await s.dispatch("resumeWriter");
    assert.equal(dispatched, true, `the writer must dispatch while ${blocker} is still running`);
    assert.ok(calls.includes("resumeWriter"), "the writer handler must actually have run");

    slow.resolve();
    await blockerRun;
    s.stop();
  }
});

test("S29-05 with no writer work pending the other ticks still run normally", async () => {
  // "No pending work" is decided inside the writer tick itself; from the scheduler's side the writer
  // simply returns quickly and must not prevent anything else being dispatched.
  const { handlers: h, calls } = handlers({
    resumeWriter: async () => {
      calls.push("resumeWriter");
      return "SKIPPED_NO_PENDING_WORKFLOWS";
    },
  });
  const s = new WorkerScheduler(h);
  await s.start();
  s.stop();
  assert.ok(calls.includes("resumeWriter"));
  assert.ok(calls.includes("jobEvaluation"), "evaluation must still be dispatched");
  // scan and productionCycle are both HEAVY and share one slot, so exactly one of them starts in the
  // same instant and the other is picked up by its own timer on the next check. That serialisation is
  // the intended resource bound, not a missed dispatch.
  const heavyStarted = (["scan", "productionCycle"] as const).filter((t) => calls.includes(t));
  assert.equal(heavyStarted.length, 1, `exactly one heavy tick may start at once, got ${heavyStarted.join(",")}`);
  assert.equal(heavyStarted[0], "scan", "of the two heavy ticks, the higher-priority one goes first");
});

// =================================================================================================
// Bounded concurrency
// =================================================================================================

test("S29-09/10 a tick never overlaps itself — no second writer, no second production cycle", async () => {
  for (const tick of ["resumeWriter", "productionCycle"] as const) {
    let concurrent = 0;
    let maxConcurrent = 0;
    const slow = deferred();
    const { handlers: h } = handlers({
      [tick]: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await slow.promise;
        concurrent -= 1;
        return "x";
      },
    });
    const s = new WorkerScheduler(h);
    const first = s.dispatch(tick);
    const second = await s.dispatch(tick);
    assert.equal(second, false, `${tick} must refuse to start while its own previous run is in flight`);
    slow.resolve();
    await first;
    assert.equal(maxConcurrent, 1, `${tick} must never run twice at once`);
    s.stop();
  }
});

test("S29-20 only one HEAVY tick runs at a time, and LIGHT/MEDIUM are never blocked by it", async () => {
  const slow = deferred();
  const { handlers: h } = handlers({ productionCycle: () => slow.promise });
  const s = new WorkerScheduler(h);

  const production = s.dispatch("productionCycle");
  // scan is HEAVY too — it must wait rather than pile onto an 8 GB machine.
  assert.equal(s.canDispatch("scan"), false, "two heavy ticks must not run together");
  // The writer and evaluation are unaffected — that is the whole point.
  assert.equal(s.canDispatch("resumeWriter"), true);
  assert.equal(s.canDispatch("jobEvaluation"), true);
  assert.equal(s.snapshot().heavySlotHeldBy, "productionCycle");

  slow.resolve();
  await production;
  assert.equal(s.canDispatch("scan"), true, "the heavy slot must be released when the heavy tick finishes");
  assert.equal(s.snapshot().heavySlotHeldBy, null);
  s.stop();
});

test("S29-21 resource classes and check intervals reflect the writer's priority", () => {
  assert.equal(TICK_RESOURCE_CLASS.resumeWriter, "LIGHT");
  assert.equal(TICK_RESOURCE_CLASS.jobEvaluation, "MEDIUM");
  assert.equal(TICK_RESOURCE_CLASS.scan, "HEAVY");
  assert.equal(TICK_RESOURCE_CLASS.productionCycle, "HEAVY");
  assert.equal(TICK_PRIORITY.resumeWriter, 1, "the writer is the tick a human is waiting on");
  assert.ok(
    TICK_CHECK_INTERVAL_MS.resumeWriter <= 60_000,
    "the writer must be checked at least once a minute to meet the dispatch-latency target"
  );
});

// =================================================================================================
// Failure isolation and shutdown
// =================================================================================================

test("S29-14 one failing tick never stops itself or anything else from being dispatched again", async () => {
  let writerCalls = 0;
  const { handlers: h, calls } = handlers({
    productionCycle: async () => {
      throw new Error("production exploded");
    },
    resumeWriter: async () => {
      writerCalls += 1;
      calls.push("resumeWriter");
      return "writer";
    },
  });
  const s = new WorkerScheduler(h);

  assert.equal(await s.dispatch("productionCycle"), true);
  assert.match(s.snapshot().ticks.productionCycle.lastError ?? "", /production exploded/);
  assert.equal(s.snapshot().ticks.productionCycle.running, false, "a thrown tick must not stay stuck 'running'");

  // Same tick can run again, and unrelated ticks are unaffected.
  assert.equal(await s.dispatch("productionCycle"), true, "a failed tick must remain dispatchable");
  assert.equal(await s.dispatch("resumeWriter"), true);
  assert.equal(writerCalls, 1);
  assert.ok(calls.includes("resumeWriter"));
  s.stop();
});

test("S29-13 stop() clears timers and refuses further dispatch", async () => {
  const { handlers: h, calls } = handlers();
  const s = new WorkerScheduler(h);
  await s.start();
  const before = calls.length;
  s.stop();
  assert.equal(s.canDispatch("resumeWriter"), false, "a stopped scheduler must dispatch nothing");
  assert.equal(await s.dispatch("productionCycle"), false);
  assert.equal(calls.length, before, "no handler may run after stop()");
});

test("S29-22 the snapshot names the current activity truthfully", async () => {
  const slow = deferred();
  const { handlers: h } = handlers({ productionCycle: () => slow.promise });
  const s = new WorkerScheduler(h);
  assert.equal(s.snapshot().currentActivity, "IDLE");

  const run = s.dispatch("productionCycle");
  assert.equal(s.snapshot().currentActivity, "productionCycle");
  assert.equal(s.snapshot().ticks.productionCycle.running, true);

  slow.resolve();
  await run;
  assert.equal(s.snapshot().currentActivity, "IDLE");
  assert.equal(s.snapshot().ticks.productionCycle.running, false);
  assert.ok((s.snapshot().ticks.productionCycle.lastDurationMs ?? -1) >= 0, "a completed tick reports its duration");
  s.stop();
});

test("S29-23 a higher-priority tick is reported as the current activity when several run at once", async () => {
  const writerGate = deferred();
  const productionGate = deferred();
  const { handlers: h } = handlers({
    resumeWriter: () => writerGate.promise,
    productionCycle: () => productionGate.promise,
  });
  const s = new WorkerScheduler(h);
  const production = s.dispatch("productionCycle");
  const writer = s.dispatch("resumeWriter");
  assert.equal(s.snapshot().currentActivity, "resumeWriter", "the writer is what the user is waiting on");
  writerGate.resolve();
  productionGate.resolve();
  await Promise.all([writer, production]);
  s.stop();
});
