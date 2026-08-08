import assert from "node:assert/strict";
import { test } from "node:test";
import { canArchive, PROTECTED_PIPELINE_STATUSES } from "../jobLifecycle";

test("canArchive blocks Applied and Interview", () => {
  assert.equal(canArchive("Applied"), false);
  assert.equal(canArchive("Interview"), false);
});

test("canArchive allows every other pipeline status", () => {
  for (const status of ["New", "Interested", "Rejected", "Offer"] as const) {
    assert.equal(canArchive(status), true);
  }
});

test("PROTECTED_PIPELINE_STATUSES is exactly Applied + Interview", () => {
  assert.deepEqual([...PROTECTED_PIPELINE_STATUSES].sort(), ["Applied", "Interview"]);
});
