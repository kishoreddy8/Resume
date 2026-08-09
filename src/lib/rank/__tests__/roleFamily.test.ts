import assert from "node:assert/strict";
import { test } from "node:test";
import { computeRoleFamilyTier, matchesRoleFamily } from "@/lib/rank/roleFamily";

test("matchesRoleFamily: every significant word of the role must appear in the title", () => {
  assert.equal(matchesRoleFamily("Senior Data Engineer", "Data Engineer"), true);
  assert.equal(matchesRoleFamily("Azure Data Engineer II", "Data Engineer"), true);
  assert.equal(matchesRoleFamily("Data Analyst", "Data Engineer"), false);
});

test("matchesRoleFamily: word containment matches plural/gerund forms (Engineer vs Engineering)", () => {
  assert.equal(matchesRoleFamily("Data Engineering Manager", "Data Engineer"), true);
});

test("matchesRoleFamily: null/empty/whitespace-only role never matches", () => {
  assert.equal(matchesRoleFamily("Data Engineer", null), false);
  assert.equal(matchesRoleFamily("Data Engineer", ""), false);
  assert.equal(matchesRoleFamily("Data Engineer", "   "), false);
});

test("matchesRoleFamily: stopwords are ignored on both sides", () => {
  assert.equal(matchesRoleFamily("Engineer of the Data Platform", "Data Engineer"), true);
});

test("computeRoleFamilyTier: primary match wins PRIMARY even if a secondary role also matches", () => {
  const tier = computeRoleFamilyTier("Senior Data Engineer", {
    primaryTargetRole: "Data Engineer",
    secondaryTargetRoles: ["Data Engineer"],
  });
  assert.equal(tier, "PRIMARY");
});

test("computeRoleFamilyTier: secondary match when only a secondary role matches", () => {
  const tier = computeRoleFamilyTier("Azure Data Engineer", {
    primaryTargetRole: "AI Engineer",
    secondaryTargetRoles: ["Azure Data Engineer", "Java Developer"],
  });
  assert.equal(tier, "SECONDARY");
});

test("computeRoleFamilyTier: NONE when nothing matches", () => {
  const tier = computeRoleFamilyTier("Java Backend Developer", {
    primaryTargetRole: "Data Engineer",
    secondaryTargetRoles: ["Azure Data Engineer", "AI Engineer"],
  });
  assert.equal(tier, "NONE");
});

test("computeRoleFamilyTier: no preferences configured (nulls/empty) always NONE, never a fabricated match", () => {
  const tier = computeRoleFamilyTier("Data Engineer", { primaryTargetRole: null, secondaryTargetRoles: [] });
  assert.equal(tier, "NONE");
});
