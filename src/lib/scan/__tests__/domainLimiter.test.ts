import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDomainLimiter,
  workdayDomainLimiter,
  adpWfnDomainLimiter,
  resetForTesting,
} from "../domainLimiter";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("createDomainLimiter enforces max concurrency limit", async () => {
  const limiter = createDomainLimiter({ concurrency: 2 });
  let activeCount = 0;
  let maxObservedActive = 0;

  const tasks = Array.from({ length: 6 }, async (_, i) => {
    return limiter(async () => {
      activeCount++;
      maxObservedActive = Math.max(maxObservedActive, activeCount);
      await sleep(20);
      activeCount--;
      return i;
    });
  });

  const results = await Promise.all(tasks);
  assert.equal(results.length, 6);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.ok(maxObservedActive <= 2, `Expected max active <= 2, observed ${maxObservedActive}`);
  assert.equal(limiter.activeCount, 0);
  assert.equal(limiter.pendingCount, 0);
});

test("createDomainLimiter honors baseDelayMs spacing", async () => {
  const baseDelayMs = 50;
  const limiter = createDomainLimiter({ concurrency: 1, baseDelayMs });
  const startTimes: number[] = [];

  const tasks = Array.from({ length: 3 }, async () => {
    return limiter(async () => {
      startTimes.push(Date.now());
      await sleep(10);
    });
  });

  await Promise.all(tasks);
  assert.equal(startTimes.length, 3);
  // Each task takes ~10ms execution + 50ms baseDelayMs before next task starts, so spacing >= 50ms
  const gap1 = startTimes[1] - startTimes[0];
  const gap2 = startTimes[2] - startTimes[1];
  assert.ok(gap1 >= 45, `Expected gap1 >= 45ms, was ${gap1}ms`);
  assert.ok(gap2 >= 45, `Expected gap2 >= 45ms, was ${gap2}ms`);
});

test("createDomainLimiter releases concurrency slot on error", async () => {
  const limiter = createDomainLimiter({ concurrency: 1 });

  await assert.rejects(async () => {
    return limiter(async () => {
      throw new Error("Deliberate failure");
    });
  }, /Deliberate failure/);

  assert.equal(limiter.activeCount, 0);

  // Next request must still succeed
  const result = await limiter(async () => 42);
  assert.equal(result, 42);
});

test("workdayDomainLimiter and adpWfnDomainLimiter singletons function properly", async () => {
  resetForTesting();

  const wdResult = await workdayDomainLimiter(async () => "workday_ok");
  assert.equal(wdResult, "workday_ok");

  const adpResult = await adpWfnDomainLimiter(async () => "adp_ok");
  assert.equal(adpResult, "adp_ok");

  resetForTesting();
  assert.equal(workdayDomainLimiter.activeCount, 0);
  assert.equal(adpWfnDomainLimiter.activeCount, 0);
});
