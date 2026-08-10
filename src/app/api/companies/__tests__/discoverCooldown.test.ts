import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * Retry Discovery cooldown — POST /api/companies/[id]/discover previously had zero rate limiting
 * (any caller could hammer it against the same company indefinitely). Same isolated-temp-DB pattern
 * as src/db/queries/__tests__/dedupeRepost.test.ts: every DB-touching module is imported dynamically
 * inside before() so CAREER_OPS_DB_PATH is set before getDb() ever opens a file.
 *
 * Doesn't touch discoverCompanySource's own behavior — the second test's URL (a closed loopback
 * port) is only there to prove the cooldown gate does NOT block a genuinely-eligible retry; the
 * route's default (production) safety posture rejects that URL as unsafe before any real network
 * call, which is fine here — a non-429 response is all this test needs to prove.
 */

let tmpDir: string;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let recordDiscoveryResult: typeof import("@/db/queries/companies").recordDiscoveryResult;
let POST: typeof import("../[id]/discover/route").POST;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-discover-cooldown-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  const { getDb } = await import("@/db/index");
  ({ createCompany, recordDiscoveryResult } = await import("@/db/queries/companies"));
  ({ POST } = await import("../[id]/discover/route"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function postDiscover(companyId: number) {
  const req = new Request(`http://localhost/api/companies/${companyId}/discover`, { method: "POST" });
  return POST(req as unknown as Parameters<typeof POST>[0], { params: Promise.resolve({ id: String(companyId) }) });
}

test("a second retry within the cooldown window is rejected with 429", async () => {
  const company = createCompany({ name: "Cooldown Co", source_type: "career_link", career_page_url: "http://127.0.0.1:1/" });
  // Simulate a just-attempted discovery (discovery_attempted_at defaults to now on write).
  recordDiscoveryResult(company.id, {
    status: "UNRESOLVED",
    sourceType: null,
    atsBoardToken: null,
    discoveredJobsUrl: null,
    reason: "test setup",
    suspectedAts: null,
  });

  const res = await postDiscover(company.id);
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.match(body.error, /try again/i);
});

test("a retry after no prior attempt is NOT blocked by the cooldown gate", async () => {
  const company = createCompany({ name: "Fresh Co", source_type: "career_link", career_page_url: "http://127.0.0.1:2/" });
  const res = await postDiscover(company.id);
  assert.notEqual(res.status, 429, "a company with no discovery_attempted_at yet must not be cooldown-blocked");
});
