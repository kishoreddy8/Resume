import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMatchKnowledgeHash } from "../matchKnowledgeHash";
import * as scoringModule from "../scoring";

test("the hash is stable across repeated calls with no changes", () => {
  assert.equal(computeMatchKnowledgeHash(), computeMatchKnowledgeHash());
});

test("editing a scoring constant changes the hash (proves data changes are automatically caught)", () => {
  const before = computeMatchKnowledgeHash();
  const originalWeights = { ...scoringModule.SCORING_WEIGHTS };
  // Mutate the exported constant object in place to simulate "someone edited scoring.ts" without
  // touching module resolution/caching — this is a hash-content test, not a real runtime mutation
  // path (SCORING_WEIGHTS is `as const` in production and never mutated by app code).
  (scoringModule.SCORING_WEIGHTS as unknown as { required: number }).required = 999;
  const after = computeMatchKnowledgeHash();
  (scoringModule.SCORING_WEIGHTS as unknown as { required: number }).required = originalWeights.required;
  assert.notEqual(before, after, "a scoring-weight edit must change the knowledge hash with zero manual version-bump discipline required");
});
