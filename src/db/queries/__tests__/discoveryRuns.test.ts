import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let tmpDir: string;
let recordDiscoveryRun: typeof import("../discoveryRuns").recordDiscoveryRun;
let listDiscoveryRuns: typeof import("../discoveryRuns").listDiscoveryRuns;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-discovery-runs-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ recordDiscoveryRun, listDiscoveryRuns } = await import("../discoveryRuns"));
  const { getDb } = await import("../../index");
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BASE_INPUT = {
  startedAt: "2026-08-09T00:00:00.000Z",
  finishedAt: "2026-08-09T00:01:00.000Z",
  employersAttempted: 5,
  domainsVerified: 2,
  domainsAmbiguous: 1,
  domainsUnresolved: 1,
  domainsFailedTemporary: 1,
  careersPagesResolved: 2,
  atsVerified: 1,
  needsAdapter: 0,
  sourceUnresolved: 1,
  sourceFailedTemporary: 0,
  durationMs: 60000,
  errorSummary: null,
};

test("recordDiscoveryRun persists and round-trips every counter", () => {
  const row = recordDiscoveryRun(BASE_INPUT);
  assert.equal(row.employers_attempted, 5);
  assert.equal(row.domains_verified, 2);
  assert.equal(row.domains_ambiguous, 1);
  assert.equal(row.ats_verified, 1);
  assert.equal(row.duration_ms, 60000);
});

test("listDiscoveryRuns returns most recent first, bounded by limit", () => {
  recordDiscoveryRun({ ...BASE_INPUT, startedAt: "2026-08-08T00:00:00.000Z" });
  recordDiscoveryRun({ ...BASE_INPUT, startedAt: "2026-08-09T00:00:00.000Z" });
  const runs = listDiscoveryRuns(1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].started_at, "2026-08-09T00:00:00.000Z");
});
