import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createNotificationIfAbsent: typeof import("../notifications").createNotificationIfAbsent;
let listNotificationsForCandidate: typeof import("../notifications").listNotificationsForCandidate;
let getUnreadNotificationCount: typeof import("../notifications").getUnreadNotificationCount;
let markNotificationRead: typeof import("../notifications").markNotificationRead;
let markAllNotificationsRead: typeof import("../notifications").markAllNotificationsRead;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-notifications-query-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ getDb } = await import("@/db"));
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createNotificationIfAbsent, listNotificationsForCandidate, getUnreadNotificationCount, markNotificationRead, markAllNotificationsRead } =
    await import("../notifications"));

  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function makeNotificationInput(overrides: Partial<Parameters<typeof createNotificationIfAbsent>[0]> = {}) {
  return {
    candidateId: 1,
    dedupeKey: "greenhouse:1:ext-1",
    type: "HIGH_VALUE_JOB_MATCH",
    title: "Data Engineer at Acme",
    body: "95% match — Ready for Tailoring.",
    ...overrides,
  };
}

test("13. createNotificationIfAbsent creates exactly one row for a new (candidate, dedupeKey, type) triple", () => {
  const candidate = createCandidate({ firstName: "Notif", lastName: "One" });
  const created = createNotificationIfAbsent(makeNotificationInput({ candidateId: candidate.id }));
  assert.equal(created, true);
  const rows = listNotificationsForCandidate(candidate.id);
  assert.equal(rows.length, 1);
});

test("30. the database UNIQUE(candidate_id, dedupe_key, type) constraint prevents a duplicate row even on a direct second insert attempt", () => {
  const candidate = createCandidate({ firstName: "Notif", lastName: "Unique" });
  const input = makeNotificationInput({ candidateId: candidate.id, dedupeKey: "greenhouse:1:ext-unique" });

  const first = createNotificationIfAbsent(input);
  const second = createNotificationIfAbsent({ ...input, title: "A different title — still same identity" });

  assert.equal(first, true);
  assert.equal(second, false, "a second call for the identical (candidate, dedupeKey, type) must not create a new row");

  const rows = listNotificationsForCandidate(candidate.id);
  const matching = rows.filter((r) => r.dedupe_key === "greenhouse:1:ext-unique");
  assert.equal(matching.length, 1, "exactly one row must exist regardless of how many times creation was attempted");
  assert.equal(matching[0].title, input.title, "ON CONFLICT DO NOTHING never overwrites the existing row's content with the second attempt's");
});

test("a different type for the same (candidate, dedupeKey) is a genuinely separate notification", () => {
  const candidate = createCandidate({ firstName: "Notif", lastName: "TypeDiff" });
  createNotificationIfAbsent(makeNotificationInput({ candidateId: candidate.id, dedupeKey: "greenhouse:1:ext-typediff", type: "HIGH_VALUE_JOB_MATCH" }));
  const secondType = createNotificationIfAbsent(
    makeNotificationInput({ candidateId: candidate.id, dedupeKey: "greenhouse:1:ext-typediff", type: "SOME_OTHER_TYPE" })
  );
  assert.equal(secondType, true);
  assert.equal(listNotificationsForCandidate(candidate.id).length, 2);
});

test("17. Candidate A's notifications are invisible to Candidate B", () => {
  const a = createCandidate({ firstName: "Isolation", lastName: "A" });
  const b = createCandidate({ firstName: "Isolation", lastName: "B" });
  createNotificationIfAbsent(makeNotificationInput({ candidateId: a.id, dedupeKey: "greenhouse:1:iso-a" }));

  assert.equal(listNotificationsForCandidate(a.id).length, 1);
  assert.equal(listNotificationsForCandidate(b.id).length, 0);
});

test("18. Candidate A cannot mark Candidate B's notification read", () => {
  const a = createCandidate({ firstName: "MarkRead", lastName: "A" });
  const b = createCandidate({ firstName: "MarkRead", lastName: "B" });
  createNotificationIfAbsent(makeNotificationInput({ candidateId: b.id, dedupeKey: "greenhouse:1:markread-b" }));
  const bNotification = listNotificationsForCandidate(b.id)[0];

  const result = markNotificationRead(a.id, bNotification.id);
  assert.equal(result, "not_found", "candidate A must never be able to mark candidate B's notification, not even report success");

  const stillUnread = listNotificationsForCandidate(b.id)[0];
  assert.equal(stillUnread.read_at, null, "candidate B's notification must remain untouched");
});

test("19. unread count is candidate-isolated", () => {
  const a = createCandidate({ firstName: "UnreadCount", lastName: "A" });
  const b = createCandidate({ firstName: "UnreadCount", lastName: "B" });
  createNotificationIfAbsent(makeNotificationInput({ candidateId: a.id, dedupeKey: "greenhouse:1:unread-a-1" }));
  createNotificationIfAbsent(makeNotificationInput({ candidateId: a.id, dedupeKey: "greenhouse:1:unread-a-2" }));
  createNotificationIfAbsent(makeNotificationInput({ candidateId: b.id, dedupeKey: "greenhouse:1:unread-b-1" }));

  assert.equal(getUnreadNotificationCount(a.id), 2);
  assert.equal(getUnreadNotificationCount(b.id), 1);
});

test("20. markNotificationRead marks exactly the targeted notification read", () => {
  const candidate = createCandidate({ firstName: "MarkOne", lastName: "Candidate" });
  createNotificationIfAbsent(makeNotificationInput({ candidateId: candidate.id, dedupeKey: "greenhouse:1:markone-1" }));
  createNotificationIfAbsent(makeNotificationInput({ candidateId: candidate.id, dedupeKey: "greenhouse:1:markone-2" }));
  const [first, second] = listNotificationsForCandidate(candidate.id).sort((a, b) => a.id - b.id);

  const result = markNotificationRead(candidate.id, first.id);
  assert.equal(result, "marked");

  const reloaded = listNotificationsForCandidate(candidate.id);
  const reloadedFirst = reloaded.find((r) => r.id === first.id)!;
  const reloadedSecond = reloaded.find((r) => r.id === second.id)!;
  assert.ok(reloadedFirst.read_at);
  assert.equal(reloadedSecond.read_at, null, "the other notification must remain unread");
});

test("marking an already-read notification read again is an idempotent no-op, not an error", () => {
  const candidate = createCandidate({ firstName: "MarkTwice", lastName: "Candidate" });
  createNotificationIfAbsent(makeNotificationInput({ candidateId: candidate.id, dedupeKey: "greenhouse:1:marktwice" }));
  const notification = listNotificationsForCandidate(candidate.id)[0];

  assert.equal(markNotificationRead(candidate.id, notification.id), "marked");
  assert.equal(markNotificationRead(candidate.id, notification.id), "already_read");
});

test("21. markAllNotificationsRead marks every unread notification for that candidate only", () => {
  const a = createCandidate({ firstName: "MarkAll", lastName: "A" });
  const b = createCandidate({ firstName: "MarkAll", lastName: "B" });
  createNotificationIfAbsent(makeNotificationInput({ candidateId: a.id, dedupeKey: "greenhouse:1:markall-a-1" }));
  createNotificationIfAbsent(makeNotificationInput({ candidateId: a.id, dedupeKey: "greenhouse:1:markall-a-2" }));
  createNotificationIfAbsent(makeNotificationInput({ candidateId: b.id, dedupeKey: "greenhouse:1:markall-b-1" }));

  const markedCount = markAllNotificationsRead(a.id);
  assert.equal(markedCount, 2);
  assert.equal(getUnreadNotificationCount(a.id), 0);
  assert.equal(getUnreadNotificationCount(b.id), 1, "candidate B's notification must be untouched by candidate A's mark-all-read");
});

test("22. notification history is preserved (not deleted) after being marked read", () => {
  const candidate = createCandidate({ firstName: "History", lastName: "Preserved" });
  createNotificationIfAbsent(makeNotificationInput({ candidateId: candidate.id, dedupeKey: "greenhouse:1:history" }));
  const notification = listNotificationsForCandidate(candidate.id)[0];
  markNotificationRead(candidate.id, notification.id);

  const rows = listNotificationsForCandidate(candidate.id);
  assert.equal(rows.length, 1, "a read notification must still appear in the full list, not be removed");
  assert.ok(rows[0].read_at);

  const unreadOnly = listNotificationsForCandidate(candidate.id, { unreadOnly: true });
  assert.equal(unreadOnly.length, 0, "unreadOnly must exclude it, but it still exists in storage");
});

test("markNotificationRead on a nonexistent id returns not_found", () => {
  const candidate = createCandidate({ firstName: "NotFound", lastName: "Case" });
  assert.equal(markNotificationRead(candidate.id, 999999), "not_found");
});
