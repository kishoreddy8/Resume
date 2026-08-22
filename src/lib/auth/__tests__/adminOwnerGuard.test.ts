import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";

let tmpDir: string;
let ownerId: number;
let nonOwnerId: number;
let makeUnlockedRequest: (pathname: string, candidateId?: number, init?: ConstructorParameters<typeof NextRequest>[1]) => NextRequest;
let requireAdminOwner: typeof import("../guard").requireAdminOwner;
let SETTINGS_GET: typeof import("@/app/api/settings/route").GET;
let SETTINGS_PATCH: typeof import("@/app/api/settings/route").PATCH;
let COMPANY_DELETE: typeof import("@/app/api/companies/[id]/route").DELETE;
let SCAN_POST: typeof import("@/app/api/scan/route").POST;
let PROPOSAL_APPROVE: typeof import("@/app/api/companies/[id]/source-proposals/[proposalId]/approve/route").POST;
let PRODUCTION_POST: typeof import("@/app/api/production-cycle/route").POST;
let OPERATIONS_GET: typeof import("@/app/api/operations/route").GET;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let getCompany: typeof import("@/db/queries/companies").getCompany;
let getAppSettings: typeof import("@/db/queries/settings").getAppSettings;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-admin-owner-guard-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  const { getDb } = await import("@/db");
  const db = getDb();
  const { createCandidate } = await import("@/db/queries/candidates");
  const { getOwnerId, getUnlockSecret, setPin } = await import("@/db/queries/candidatePinStore");
  const { signUnlockToken, UNLOCK_COOKIE } = await import("@/lib/auth/candidatePin");
  ownerId = getOwnerId()!;
  setPin(ownerId, "1739");
  nonOwnerId = createCandidate({ firstName: "Not", lastName: "Owner" }).id;
  setPin(nonOwnerId, "2468");

  makeUnlockedRequest = (pathname, candidateId = ownerId, init = {}) => {
    const token = signUnlockToken({ ids: [candidateId], exp: Date.now() + 60_000 }, getUnlockSecret());
    const separator = pathname.includes("?") ? "&" : "?";
    const headers = new Headers(init.headers);
    headers.set("cookie", `${UNLOCK_COOKIE}=${token}`);
    return new NextRequest(`http://localhost${pathname}${separator}candidateId=${candidateId}`, { ...init, headers });
  };

  ({ requireAdminOwner } = await import("../guard"));
  ({ GET: SETTINGS_GET, PATCH: SETTINGS_PATCH } = await import("@/app/api/settings/route"));
  ({ DELETE: COMPANY_DELETE } = await import("@/app/api/companies/[id]/route"));
  ({ POST: SCAN_POST } = await import("@/app/api/scan/route"));
  ({ POST: PROPOSAL_APPROVE } = await import("@/app/api/companies/[id]/source-proposals/[proposalId]/approve/route"));
  ({ POST: PRODUCTION_POST } = await import("@/app/api/production-cycle/route"));
  ({ GET: OPERATIONS_GET } = await import("@/app/api/operations/route"));
  ({ createCompany, getCompany } = await import("@/db/queries/companies"));
  ({ getAppSettings } = await import("@/db/queries/settings"));

  // Make the ownership fixture explicit even if seed policy changes later.
  db.prepare("UPDATE candidates SET is_owner = CASE WHEN id = ? THEN 1 ELSE 0 END").run(ownerId);
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("owner with an unlocked PIN is allowed", () => {
  const result = requireAdminOwner(makeUnlockedRequest("/api/settings"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.candidateId, ownerId);
});

test("owner with a locked browser is denied", async () => {
  const req = new NextRequest(`http://localhost/api/settings?candidateId=${ownerId}`);
  const result = requireAdminOwner(req);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.response.status, 401);
    assert.equal((await result.response.json()).reason, "profile_locked");
  }
});

test("non-owner, missing context, and invalid context are denied", async () => {
  const nonOwner = requireAdminOwner(makeUnlockedRequest("/api/settings", nonOwnerId));
  assert.equal(nonOwner.ok, false);
  if (!nonOwner.ok) assert.equal(nonOwner.response.status, 403);

  const missing = requireAdminOwner(new NextRequest("http://localhost/api/settings"));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.response.status, 400);

  const invalid = requireAdminOwner(new NextRequest("http://localhost/api/settings?candidateId=999999"));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.response.status, 404);
});

test("direct global Admin reads cannot bypass the guard", async () => {
  const res = await SETTINGS_GET(new NextRequest("http://localhost/api/settings"));
  assert.equal(res.status, 400);
});

test("non-owner settings mutation is denied before persistence", async () => {
  const beforeSettings = getAppSettings();
  const res = await SETTINGS_PATCH(
    makeUnlockedRequest("/api/settings", nonOwnerId, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scheduler: { writerEnabled: !beforeSettings.scheduler.writerEnabled } }),
    })
  );
  assert.equal(res.status, 403);
  assert.equal(getAppSettings().scheduler.writerEnabled, beforeSettings.scheduler.writerEnabled);
});

test("company delete, scan, proposal approval, production cycle, and operations reject non-owner access", async () => {
  const company = createCompany({ name: "Guarded Company", source_type: "greenhouse", ats_board_token: "guarded" });
  const denialRequest = (pathname: string, method: string) => makeUnlockedRequest(pathname, nonOwnerId, { method });

  const companyDelete = await COMPANY_DELETE(denialRequest(`/api/companies/${company.id}`, "DELETE"), {
    params: Promise.resolve({ id: String(company.id) }),
  });
  assert.equal(companyDelete.status, 403);
  assert.ok(getCompany(company.id));

  assert.equal((await SCAN_POST(denialRequest("/api/scan", "POST"))).status, 403);
  assert.equal(
    (
      await PROPOSAL_APPROVE(denialRequest(`/api/companies/${company.id}/source-proposals/1/approve`, "POST"), {
        params: Promise.resolve({ id: String(company.id), proposalId: "1" }),
      })
    ).status,
    403
  );
  assert.equal((await PRODUCTION_POST(denialRequest("/api/production-cycle", "POST"))).status, 403);
  assert.equal((await OPERATIONS_GET(denialRequest("/api/operations?window=24h", "GET"))).status, 403);
});

test("owner-authorized mutation reaches the existing validation guard", async () => {
  const res = await SETTINGS_PATCH(
    makeUnlockedRequest("/api/settings", ownerId, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scanner: { concurrency: 999 } }),
    })
  );
  assert.equal(res.status, 400, "authorization should pass and existing settings validation should reject the value");
});

test("candidate APIs and internal worker functions are not wrapped in Admin authorization", async () => {
  const candidateRoute = await import("@/app/api/candidates/[candidateId]/route");
  assert.equal(typeof candidateRoute.GET, "function");
  const writerHealth = await import("@/lib/resumeQuality/writers/writerHealth");
  assert.doesNotThrow(() => writerHealth.getResumeWriterHealth());
});
