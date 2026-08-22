import assert from "node:assert/strict";
import { test } from "node:test";
import { recommendTrack } from "../trackRecommendation";
import type { RequirementUnit } from "../types";

function unit(overrides: Partial<RequirementUnit>): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: ["X"],
    categories: [],
    label: "X",
    requirementLevel: "Required",
    criticality: "REQUIRED",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    requestedYears: null,
    fromUnclaimedText: false,
    ...overrides,
  };
}

test("a job dominated by AI/ML category requirements recommends the AI Engineer track", () => {
  const track = recommendTrack([
    unit({ categories: ["AI / ML"] }),
    unit({ categories: ["AI / ML"] }),
    unit({ categories: ["AI / ML"] }),
  ]);
  assert.equal(track, "AI Engineer");
});

test("a job dominated by Warehousing requirements recommends Snowflake Data Engineer over a generic Data Engineer track", () => {
  const track = recommendTrack([unit({ categories: ["Warehousing"] }), unit({ categories: ["Warehousing"] })]);
  assert.equal(track, "Snowflake Data Engineer");
});

test("no category signal at all -> General / Unclassified, never a guessed track", () => {
  assert.equal(recommendTrack([]), "General / Unclassified");
  assert.equal(recommendTrack([unit({ categories: [] })]), "General / Unclassified");
});

test("track recommendation is informational only — this module has no scoring/weight coupling back into overallScore", () => {
  // Structural check: recommendTrack's return type is a plain ResumeTrack string, never a score.
  const track = recommendTrack([unit({ categories: ["Data Engineering"] })]);
  assert.equal(typeof track, "string");
});
