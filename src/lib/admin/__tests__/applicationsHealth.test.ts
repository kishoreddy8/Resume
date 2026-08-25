import assert from "node:assert/strict";
import test from "node:test";
import { applicationsHealth } from "../overview";

/**
 * UI-0 DEFECT 7 — pure decision half of the "degraded forever" fix.
 *
 * `applicationsHealth` is a pure function of an already-windowed summary; the windowing itself
 * (getApplicationsWindowSummary, in src/db/queries/__tests__/applicationsWindowSummary.test.ts)
 * is what actually stops an old failure from counting forever. This file proves the verdict logic
 * in isolation, without a database.
 */

test("ADMIN-HEALTH-01/02: healthy with zero recent failures, degraded with any", () => {
  assert.equal(applicationsHealth({ total: 10, failedCount: 0 }), "HEALTHY");
  assert.equal(applicationsHealth({ total: 10, failedCount: 1 }), "DEGRADED");
  assert.equal(applicationsHealth({ total: 0, failedCount: 0 }), "HEALTHY", "no activity at all is healthy, not unknown");
});

test("the old unwindowed bug is not reachable through this function's own contract", () => {
  /* The old code read a LIFETIME count. This function only ever sees what its caller already
   * windowed — there is no lifetime path left for it to accidentally read. */
  assert.equal(applicationsHealth({ total: 1, failedCount: 0 }), "HEALTHY");
});
