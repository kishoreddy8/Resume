import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let tmpDir: string;
let getMatchAffectingSettings: typeof import("../candidateSettings").getMatchAffectingSettings;
let getRankingPreferences: typeof import("../candidateSettings").getRankingPreferences;
let updateCandidateSettings: typeof import("../candidateSettings").updateCandidateSettings;
let computeCandidateSettingsHash: typeof import("../../../lib/match/candidateSettingsHash").computeCandidateSettingsHash;
let createCandidate: typeof import("../candidates").createCandidate;
let candidateTwoId: number;
let candidateThreeId: number;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-candidate-settings-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getMatchAffectingSettings, getRankingPreferences, updateCandidateSettings } = await import("../candidateSettings"));
  ({ computeCandidateSettingsHash } = await import("../../../lib/match/candidateSettingsHash"));
  ({ createCandidate } = await import("../candidates"));
  const { getDb } = await import("../../index");
  getDb();
  candidateTwoId = createCandidate({ firstName: "Java", lastName: "Dev" }).id;
  candidateThreeId = createCandidate({ firstName: "AI", lastName: "Eng" }).id;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("defaults are conservative: sponsorship required until told otherwise", () => {
  const settings = getMatchAffectingSettings(1);
  assert.equal(settings.requiresSponsorship, true);
  assert.equal(settings.clearanceLevel, "None");
});

test("changing a match-affecting field changes the Phase 2 cache hash", () => {
  const before = computeCandidateSettingsHash(getMatchAffectingSettings(1));
  updateCandidateSettings(1, { matchAffecting: { requiresSponsorship: false } });
  const after = computeCandidateSettingsHash(getMatchAffectingSettings(1));
  assert.notEqual(before, after, "toggling sponsorship requirement must invalidate cached Phase 2 results");
});

test("changing ONLY a ranking preference (target role) leaves the Phase 2 cache hash byte-for-byte unchanged", () => {
  const before = computeCandidateSettingsHash(getMatchAffectingSettings(candidateTwoId));
  updateCandidateSettings(candidateTwoId, { preferences: { primaryTargetRole: "Data Engineer", secondaryTargetRoles: ["Azure Data Engineer", "Snowflake Data Engineer"] } });
  const after = computeCandidateSettingsHash(getMatchAffectingSettings(candidateTwoId));
  assert.equal(before, after, "a target-role preference change must never invalidate a Phase 2 match result");

  const prefs = getRankingPreferences(candidateTwoId);
  assert.equal(prefs.primaryTargetRole, "Data Engineer");
  assert.deepEqual(prefs.secondaryTargetRoles, ["Azure Data Engineer", "Snowflake Data Engineer"]);
});

test("updateCandidateSettings preserves fields not included in a partial update", () => {
  updateCandidateSettings(candidateThreeId, { matchAffecting: { requiresSponsorship: false, clearanceLevel: "Secret" } });
  updateCandidateSettings(candidateThreeId, { preferences: { primaryTargetRole: "AI Engineer" } });
  const settings = getMatchAffectingSettings(candidateThreeId);
  assert.equal(settings.requiresSponsorship, false, "an unrelated later preference update must not reset an earlier match-affecting change");
  assert.equal(settings.clearanceLevel, "Secret");
});
