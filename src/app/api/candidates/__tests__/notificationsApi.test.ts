import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";

/**
 * Phase 4 Stage 4 — candidate notification API route tests. Real (temp) DB. Focused on candidate
 * isolation at the HTTP layer (see src/db/queries/__tests__/notifications.test.ts for the deeper
 * query-layer isolation tests this mirrors) and basic validation/status-code conventions.
 */

let tmpDir: string;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createNotificationIfAbsent: typeof import("@/db/queries/notifications").createNotificationIfAbsent;
let GET: typeof import("../[candidateId]/notifications/route").GET;
let PATCH_ONE: typeof import("../[candidateId]/notifications/[notificationId]/route").PATCH;
let POST_ALL: typeof import("../[candidateId]/notifications/mark-all-read/route").POST;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-notifications-api-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  const { getDb } = await import("@/db");
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createNotificationIfAbsent } = await import("@/db/queries/notifications"));
  ({ GET } = await import("../[candidateId]/notifications/route"));
  ({ PATCH: PATCH_ONE } = await import("../[candidateId]/notifications/[notificationId]/route"));
  ({ POST: POST_ALL } = await import("../[candidateId]/notifications/mark-all-read/route"));
  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function getRequest(candidateId: number) {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateId}/notifications`);
  return GET(req, { params: Promise.resolve({ candidateId: String(candidateId) }) });
}

function patchOneRequest(candidateId: number, notificationId: number) {
  const req = new Request(`http://localhost/api/candidates/${candidateId}/notifications/${notificationId}`, { method: "PATCH" });
  return PATCH_ONE(req, { params: Promise.resolve({ candidateId: String(candidateId), notificationId: String(notificationId) }) });
}

function postAllRequest(candidateId: number) {
  const req = new Request(`http://localhost/api/candidates/${candidateId}/notifications/mark-all-read`, { method: "POST" });
  return POST_ALL(req, { params: Promise.resolve({ candidateId: String(candidateId) }) });
}

test("GET returns the candidate's notifications with an unread count", async () => {
  const candidate = createCandidate({ firstName: "Api", lastName: "List" });
  createNotificationIfAbsent({
    candidateId: candidate.id,
    dedupeKey: "greenhouse:1:api-list",
    type: "HIGH_VALUE_JOB_MATCH",
    title: "Data Engineer at Acme",
    body: "95% match.",
  });

  const res = await getRequest(candidate.id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.unreadCount, 1);
  assert.equal(body.notifications.length, 1);
  assert.equal(body.notifications[0].title, "Data Engineer at Acme");
});

test("GET rejects an invalid (non-numeric) candidate id with 400", async () => {
  const req = new NextRequest("http://localhost/api/candidates/abc/notifications");
  const res = await GET(req, { params: Promise.resolve({ candidateId: "abc" }) });
  assert.equal(res.status, 400);
});

test("GET rejects a nonexistent/inactive candidate id with 404", async () => {
  const res = await getRequest(999999);
  assert.equal(res.status, 404);
});

test("17/18. GET never exposes Candidate B's notifications through Candidate A's request, and PATCH cannot mark Candidate B's notification read via Candidate A's id", async () => {
  const a = createCandidate({ firstName: "Api", lastName: "IsoA" });
  const b = createCandidate({ firstName: "Api", lastName: "IsoB" });
  createNotificationIfAbsent({
    candidateId: b.id,
    dedupeKey: "greenhouse:1:api-iso-b",
    type: "HIGH_VALUE_JOB_MATCH",
    title: "B's private notification",
    body: "should never leak to A",
  });
  const bNotification = (await (await getRequest(b.id)).json()).notifications[0];

  const aView = await (await getRequest(a.id)).json();
  assert.equal(aView.notifications.length, 0, "candidate A's list must not include candidate B's notification");

  const crossPatch = await patchOneRequest(a.id, bNotification.id);
  assert.equal(crossPatch.status, 404, "candidate A must not be able to mark candidate B's notification read");

  const bStillUnread = await (await getRequest(b.id)).json();
  assert.equal(bStillUnread.notifications[0].readAt, null, "candidate B's notification must remain untouched");
});

test("PATCH marks a notification read and it reflects in a subsequent GET", async () => {
  const candidate = createCandidate({ firstName: "Api", lastName: "MarkRead" });
  createNotificationIfAbsent({
    candidateId: candidate.id,
    dedupeKey: "greenhouse:1:api-mark-read",
    type: "HIGH_VALUE_JOB_MATCH",
    title: "Mark Read Test",
    body: "body",
  });
  const notification = (await (await getRequest(candidate.id)).json()).notifications[0];

  const res = await patchOneRequest(candidate.id, notification.id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "marked");

  const reloaded = await (await getRequest(candidate.id)).json();
  assert.ok(reloaded.notifications[0].readAt);
  assert.equal(reloaded.unreadCount, 0);
});

test("21. POST mark-all-read clears the unread count for that candidate only", async () => {
  const a = createCandidate({ firstName: "Api", lastName: "MarkAllA" });
  const b = createCandidate({ firstName: "Api", lastName: "MarkAllB" });
  createNotificationIfAbsent({ candidateId: a.id, dedupeKey: "greenhouse:1:api-markall-a1", type: "HIGH_VALUE_JOB_MATCH", title: "t", body: "b" });
  createNotificationIfAbsent({ candidateId: a.id, dedupeKey: "greenhouse:1:api-markall-a2", type: "HIGH_VALUE_JOB_MATCH", title: "t", body: "b" });
  createNotificationIfAbsent({ candidateId: b.id, dedupeKey: "greenhouse:1:api-markall-b1", type: "HIGH_VALUE_JOB_MATCH", title: "t", body: "b" });

  const res = await postAllRequest(a.id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.markedCount, 2);

  const aView = await (await getRequest(a.id)).json();
  const bView = await (await getRequest(b.id)).json();
  assert.equal(aView.unreadCount, 0);
  assert.equal(bView.unreadCount, 1, "candidate B's unread notification must be unaffected by candidate A's mark-all-read");
});

test("PATCH on a nonexistent notification id returns 404", async () => {
  const candidate = createCandidate({ firstName: "Api", lastName: "NotFound" });
  const res = await patchOneRequest(candidate.id, 999999);
  assert.equal(res.status, 404);
});
