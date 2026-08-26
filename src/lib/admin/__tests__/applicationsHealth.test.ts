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
  assert.equal(applicationsHealth({ total: 10, failedCount: 1 }), "WARNING");
});

test("OPS1.1-APP-01: an empty window is NO_DATA because this field means SUBSYSTEM health, not open issues", () => {
  /* The semantics, not just the value, are the assertion here.
   *
   * This function's only consumer is the "Application Pipeline" tile in Admin's "Subsystem Health"
   * grid, so it answers "is application automation working" — a claim that zero observed runs cannot
   * support. Under the other plausible reading ("are there problems right now") zero runs would
   * legitimately be HEALTHY, which is why the contract has to be stated rather than assumed.
   *
   * ADMIN-OPS-1 reversed the original HEALTHY behaviour on exactly this ground. If this assertion
   * ever needs to flip back, the tile's meaning must have changed first — flipping it to make a
   * caller pass would silently restore a green card backed by no evidence. */
  assert.equal(applicationsHealth({ total: 0, failedCount: 0 }), "NO_DATA");
});

test("OPS1.1-HEALTH-02: NO_DATA is distinct from both HEALTHY and the failure state", () => {
  const empty = applicationsHealth({ total: 0, failedCount: 0 });
  assert.notEqual(empty, "HEALTHY", "absence of evidence must not read as working");
  assert.notEqual(empty, "WARNING", "absence of evidence must not read as a fault either");
});

test("the old unwindowed bug is not reachable through this function's own contract", () => {
  /* The old code read a LIFETIME count. This function only ever sees what its caller already
   * windowed — there is no lifetime path left for it to accidentally read. */
  assert.equal(applicationsHealth({ total: 1, failedCount: 0 }), "HEALTHY");
});
