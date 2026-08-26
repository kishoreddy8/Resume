import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { after, before, beforeEach, test } from "node:test";

/* ================================================================================================
 * ADMIN-SEC-1.1 — adversarial checks the implementation phase did not run.
 *
 * Two things are proved here that a source-shape test cannot:
 *   1. the guard on the job routes actually refuses an unauthenticated caller, by invoking the real
 *      route handler rather than inspecting it; and
 *   2. archiving is GLOBAL state, so the boundary that actually protects one candidate from another
 *      is not the route guard at all — it is the data layer's cross-candidate protection check.
 *      That distinction is the whole reason CANDIDATE is the right guard here, so it is pinned.
 * ============================================================================================== */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let archivePOST: typeof import("@/app/api/jobs/[id]/archive/route").POST;
let restorePOST: typeof import("@/app/api/jobs/[id]/restore/route").POST;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let setPin: typeof import("@/db/queries/candidatePinStore").setPin;
let getUnlockSecret: typeof import("@/db/queries/candidatePinStore").getUnlockSecret;
let signUnlockToken: typeof import("@/lib/auth/candidatePin").signUnlockToken;
let UNLOCK_COOKIE: typeof import("@/lib/auth/candidatePin").UNLOCK_COOKIE;
let setPinned: typeof import("@/db/queries/candidateJobState").setPinned;
let isProtectedForAnyCandidate: typeof import("@/db/queries/candidateJobState").isProtectedForAnyCandidate;
let archiveJob: typeof import("@/db/queries/jobs").archiveJob;
let resetAppSettings: typeof import("@/db/queries/settings").resetAppSettings;

const FAKE_PIN = "7351";
const DEDUPE = "greenhouse:9001:sec11-job";

function req(url: string, cookie?: string): NextRequest {
  const headers = new Headers();
  if (cookie) headers.set("cookie", `${UNLOCK_COOKIE}=${cookie}`);
  return new NextRequest(`http://localhost${url}`, { method: "POST", headers });
}

const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

function seedJob(): number {
  const db = getDb();
  db.prepare("INSERT INTO companies (name, source_type, is_active) VALUES ('SecCo', 'greenhouse', 1)").run();
  const companyId = Number(
    (db.prepare("SELECT id FROM companies WHERE name = 'SecCo'").get() as { id: number }).id
  );
  db.prepare(
    `INSERT INTO jobs (company_id, source_type, dedupe_key, external_id, title, url, is_active, is_archived, first_seen_at, last_seen_at)
     VALUES (?, 'greenhouse', ?, 'ext-1', 'Data Engineer', 'https://example.test/j/1', 1, 0, datetime('now'), datetime('now'))`
  ).run(companyId, DEDUPE);
  return Number((db.prepare("SELECT id FROM jobs WHERE dedupe_key = ?").get(DEDUPE) as { id: number }).id);
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-sec11-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  ({ POST: archivePOST } = await import("@/app/api/jobs/[id]/archive/route"));
  ({ POST: restorePOST } = await import("@/app/api/jobs/[id]/restore/route"));
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ setPin, getUnlockSecret } = await import("@/db/queries/candidatePinStore"));
  ({ signUnlockToken, UNLOCK_COOKIE } = await import("@/lib/auth/candidatePin"));
  ({ setPinned, isProtectedForAnyCandidate } = await import("@/db/queries/candidateJobState"));
  ({ archiveJob } = await import("@/db/queries/jobs"));
  ({ resetAppSettings } = await import("@/db/queries/settings"));
  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  /* Only the job-side fixtures are cleared between tests. Candidates are left to accumulate: every
   * test creates and references its own by id, and deleting them here would fight the schema's
   * foreign keys for no benefit. */
  const db = getDb();
  db.prepare("DELETE FROM candidate_job_state").run();
  db.prepare("DELETE FROM jobs").run();
  db.prepare("DELETE FROM companies").run();
  db.prepare("DELETE FROM settings").run();
});

// --- SEC1.1-AUTH: the guard actually refuses, at runtime ----------------------------------------

test("SEC1.1-AUTH-01: archive refuses a request that names no candidate", async () => {
  const jobId = seedJob();
  const res = await archivePOST(req(`/api/jobs/${jobId}/archive`), params(jobId));
  assert.equal(res.status, 400, "an unidentified caller must not reach archiveJob");
  const still = getDb().prepare("SELECT is_archived FROM jobs WHERE id = ?").get(jobId) as { is_archived: number };
  assert.equal(still.is_archived, 0, "nothing may be mutated by a refused request");
});

test("SEC1.1-AUTH-01b: archive refuses a PIN-protected candidate without that candidate's session", async () => {
  const jobId = seedJob();
  const victim = createCandidate({ firstName: "Protected", lastName: "Profile" });
  setPin(victim.id, FAKE_PIN);

  const res = await archivePOST(req(`/api/jobs/${jobId}/archive?candidateId=${victim.id}`), params(jobId));
  assert.equal(res.status, 401, "impersonating a locked profile must fail");
  const still = getDb().prepare("SELECT is_archived FROM jobs WHERE id = ?").get(jobId) as { is_archived: number };
  assert.equal(still.is_archived, 0);
});

test("SEC1.1-AUTH-02: restore refuses an unidentified caller and mutates nothing", async () => {
  const jobId = seedJob();
  getDb().prepare("UPDATE jobs SET is_archived = 1 WHERE id = ?").run(jobId);

  const res = await restorePOST(req(`/api/jobs/${jobId}/restore`), params(jobId));
  assert.equal(res.status, 400);
  const still = getDb().prepare("SELECT is_archived FROM jobs WHERE id = ?").get(jobId) as { is_archived: number };
  assert.equal(still.is_archived, 1, "a refused restore must leave the job archived");
});

test("SEC1.1-AUTH-01c: an authenticated candidate CAN archive — the guard is authentication, not a wall", async () => {
  const jobId = seedJob();
  const actor = createCandidate({ firstName: "Real", lastName: "User" });
  setPin(actor.id, FAKE_PIN);
  const token = signUnlockToken({ ids: [actor.id], exp: Date.now() + 60_000 }, getUnlockSecret());

  const res = await archivePOST(req(`/api/jobs/${jobId}/archive?candidateId=${actor.id}`, token), params(jobId));
  assert.equal(res.status, 200, "the candidate product must keep working");
  const now = getDb().prepare("SELECT is_archived FROM jobs WHERE id = ?").get(jobId) as { is_archived: number };
  assert.equal(now.is_archived, 1);
});

// --- SEC1.1-AUTH-03: where cross-candidate safety actually lives --------------------------------

test("SEC1.1-AUTH-03: archiving is GLOBAL, so the data layer — not the guard — protects other candidates", async () => {
  /* THE POINT OF THIS TEST. `jobs.is_archived` is one shared column; there is no per-candidate
   * archive state to scope a guard to. So no route guard, at any strictness, could make candidate A's
   * archive invisible to candidate B. What genuinely protects B is archiveJob's own
   * isProtectedForAnyCandidate check, which refuses to archive a job ANY candidate is pursuing.
   * That check sits below the route and cannot be bypassed by reaching archiveJob another way. */
  const jobId = seedJob();
  const actor = createCandidate({ firstName: "Actor", lastName: "One" });
  const other = createCandidate({ firstName: "Other", lastName: "Two" });
  setPin(actor.id, FAKE_PIN);

  setPinned(other.id, DEDUPE, true);
  assert.equal(isProtectedForAnyCandidate(DEDUPE), true, "precondition: another candidate is pursuing this job");

  const token = signUnlockToken({ ids: [actor.id], exp: Date.now() + 60_000 }, getUnlockSecret());
  const res = await archivePOST(req(`/api/jobs/${jobId}/archive?candidateId=${actor.id}`, token), params(jobId));

  assert.equal(res.status, 409, "a fully authenticated candidate is still refused");
  const still = getDb().prepare("SELECT is_archived FROM jobs WHERE id = ?").get(jobId) as { is_archived: number };
  assert.equal(still.is_archived, 0, "the other candidate's job must remain active");
});

test("SEC1.1-AUTH-03b: the same protection holds when archiveJob is called directly, below the route", async () => {
  seedJob();
  const other = createCandidate({ firstName: "Other", lastName: "Two" });
  setPinned(other.id, DEDUPE, true);

  const jobId = Number((getDb().prepare("SELECT id FROM jobs WHERE dedupe_key = ?").get(DEDUPE) as { id: number }).id);
  const result = archiveJob(jobId);
  assert.equal(result.ok, false, "the guarantee is in the data layer, not the HTTP boundary");
});

// --- SEC1.1-RESET-05: the exact future-key case -------------------------------------------------

test("SEC1.1-RESET-05: an unknown future internal key survives resetAppSettings", () => {
  const db = getDb();
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(
    "future_internal.health_probe",
    "alive"
  );
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(
    "scanner.concurrency",
    "17"
  );

  resetAppSettings();

  const survived = db.prepare("SELECT value FROM settings WHERE key = ?").get("future_internal.health_probe") as
    | { value: string }
    | undefined;
  assert.equal(survived?.value, "alive", "an allowlist must preserve keys it has never heard of");

  const reset = db.prepare("SELECT value FROM settings WHERE key = ?").get("scanner.concurrency");
  assert.equal(reset, undefined, "a genuinely user-editable setting must still be reset");
});
