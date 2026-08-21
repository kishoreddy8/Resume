import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const source = fs.readFileSync(path.resolve("src/components/NotificationBell.tsx"), "utf8");

test("NotificationBell waits for the authoritative candidate before scoped requests", () => {
  assert.match(source, /useResolvedCandidateId\(\)/);
  assert.doesNotMatch(source, /useActiveCandidateId\(\)/);

  const nullGuard = source.indexOf("if (candidateId === null) return;");
  const listRequest = source.indexOf("fetch(`/api/candidates/${candidateId}/notifications?limit=20`)");
  assert.ok(nullGuard >= 0, "the unresolved candidate must stop notification loading");
  assert.ok(listRequest > nullGuard, "the null guard must run before the scoped list request");
});

test("NotificationBell uses the resolved candidate for every notification mutation", () => {
  assert.match(source, /fetch\(`\/api\/candidates\/\$\{candidateId\}\/notifications\/\$\{notificationId\}`/);
  assert.match(source, /fetch\(`\/api\/candidates\/\$\{candidateId\}\/notifications\/mark-all-read`/);

  const guards = source.match(/if \(candidateId === null\) return;/g) ?? [];
  assert.equal(guards.length, 3, "list, mark-one, and mark-all must all reject an unresolved candidate");
});

test("NotificationBell keeps row actions visible and comfortably sized for coarse pointers", () => {
  assert.match(source, /\[@media\(pointer:coarse\)\]:opacity-100/);
  assert.match(source, /\[@media\(pointer:coarse\)\]:min-h-11/);
});
