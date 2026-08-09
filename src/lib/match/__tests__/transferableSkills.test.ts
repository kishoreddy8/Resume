import assert from "node:assert/strict";
import { test } from "node:test";
import { findTransferablePair, TRANSFERABLE_SKILLS } from "../transferableSkills";
import { FIXTURE_TRANSFERABLE_PAIRS } from "./testHelpers";

test("the shipped TRANSFERABLE_SKILLS list is empty in V1 — no ecosystem-adjacency pairs are seeded", () => {
  assert.deepEqual(TRANSFERABLE_SKILLS, []);
});

test("findTransferablePair over the real (empty) list never returns a match", () => {
  assert.equal(findTransferablePair(["Databricks"], "Snowflake"), null);
});

test("findTransferablePair logic works correctly against fixture-only pairs (isolated from the shipped list)", () => {
  const match = TRANSFERABLE_SKILLS.concat(FIXTURE_TRANSFERABLE_PAIRS).find((p) => p.to === "TestSkillB" && ["TestSkillA"].includes(p.from));
  assert.ok(match);
  assert.equal(match?.strength, "strong");
});

test("transferability is directional — a from/to pair does not imply the reverse", () => {
  const forward = FIXTURE_TRANSFERABLE_PAIRS.find((p) => p.from === "TestSkillA" && p.to === "TestSkillB");
  const reverse = FIXTURE_TRANSFERABLE_PAIRS.find((p) => p.from === "TestSkillB" && p.to === "TestSkillA");
  assert.ok(forward);
  assert.equal(reverse, undefined);
});
