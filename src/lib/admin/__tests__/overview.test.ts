import assert from "node:assert/strict";
import test from "node:test";
import { compareRuntimeVersions } from "../overview";

const web = { schemaVersion: 1 as const, sourceRevision: "abc", contractVersion: "v1", loadedAt: "2026-01-01" };

test("runtime versions match only from worker-reported evidence", () => {
  assert.equal(compareRuntimeVersions(web, { running: true, sourceRevision: "abc", contractVersion: "v1" }).state, "MATCH");
  assert.equal(compareRuntimeVersions(web, { running: true, sourceRevision: "old", contractVersion: "v1" }).state, "MISMATCH");
  assert.equal(compareRuntimeVersions(web, { running: false, sourceRevision: "abc", contractVersion: "v1" }).state, "UNKNOWN");
  assert.equal(compareRuntimeVersions(web, { running: true, sourceRevision: null, contractVersion: null }).state, "UNKNOWN");
});

test("version mismatch explains fail-closed writer behavior", () => {
  const result = compareRuntimeVersions(web, { running: true, sourceRevision: "abc", contractVersion: "v2" });
  assert.equal(result.state, "MISMATCH");
  assert.match(result.detail, /fail-closed/i);
});
