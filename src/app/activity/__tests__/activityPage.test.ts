import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { NOTIFICATION_PRESENTATION, NOTIFICATION_TYPE_ORDER } from "@/lib/notifications/presentation";
import { presentActivityItem } from "../activityPresentation";

const page = fs.readFileSync(path.join(process.cwd(), "src/app/activity/page.tsx"), "utf8");
const presentation = fs.readFileSync(path.join(process.cwd(), "src/app/activity/activityPresentation.ts"), "utf8");

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

const code = withoutComments(page);

test("UIACT-SOURCE-01: Activity reuses the exact existing notifications endpoints — no new route", () => {
  assert.match(code, /fetch\(`\/api\/candidates\/\$\{candidateId\}\/notifications\?limit=\$\{LIMIT\}`\)/);
  assert.match(code, /fetch\(`\/api\/candidates\/\$\{candidateId\}\/notifications\/\$\{notificationId\}`, \{ method: "PATCH" \}\)/);
  assert.match(code, /fetch\(`\/api\/candidates\/\$\{candidateId\}\/notifications\/mark-all-read`, \{ method: "POST" \}\)/);
  // Exactly three fetch call sites — no fourth/new endpoint introduced.
  assert.equal(code.match(/fetch\(`/g)?.length, 3);
});

test("UIACT-DUP-01: no second activity/event persistence model — no new table/query/schema reference anywhere in the touched files", () => {
  const combined = code + presentation;
  assert.doesNotMatch(combined, /CREATE TABLE|activity_events|audit_log|candidate_activity/i);
  assert.doesNotMatch(combined, /getDb\(\)|\.prepare\(/);
});

test("UIACT-READ-02: mark-all-read calls the existing API, not a client-only bulk state change", () => {
  assert.match(code, /async function markAllRead/);
  assert.match(code, /mark-all-read`, \{ method: "POST" \}/);
});

test("UIACT-EMPTY-01: empty state never claims a complete audit history", () => {
  assert.doesNotMatch(code, /complete activity history|everything career-ops has done|full audit/i);
  assert.match(code, /No activity yet/);
});

test("UIACT-LOADING-01: shared loading primitives are used, not a hand-rolled spinner", () => {
  assert.match(code, /<LoadingRegion/);
  assert.match(code, /<SkeletonRows/);
});

test("UIACT-ERROR-01: shared ErrorState is used, and only claims safety it can prove", () => {
  assert.match(code, /<ErrorState/);
  assert.match(code, /whatIsSafe="Nothing about your jobs, applications or resumes was changed\."/);
});

test("UIACT-MOBILE-01: the page container keeps the same bottom clearance convention as Home/Profile", () => {
  assert.match(code, /pb-12/);
});

test("UIACT-A11Y-01: the feed is a semantic list, not a stack of unstructured divs", () => {
  assert.match(code, /<ul className="divide-y/);
  assert.match(code, /<li className="relative flex gap-3/);
});

test("UIACT-A11Y-02: unread is never color-only — a real accessible weight/label difference always accompanies the accent bar", () => {
  assert.match(code, /font-semibold text-primary.*:.*font-medium text-secondary/);
});

test("UIACT.1-A11Y-01: filter controls use semantics that match their actual behavior — plain toggle buttons, not the ARIA tab pattern this row never implements (no keyboard roving focus, no aria-controls/tabpanel)", () => {
  assert.doesNotMatch(code, /role="tablist"/);
  assert.doesNotMatch(code, /role="tab"/);
  assert.doesNotMatch(code, /aria-selected/);
  assert.match(code, /role="group" aria-label="Filter activity"/);
  assert.match(code, /aria-pressed=\{filter === f\.id\}/);
});

test("UIACT.1-A11Y-02: unread has a real accessible (non-visual) cue, not just weight/color a screen reader can't perceive", () => {
  assert.match(code, /unread && <span className="sr-only">Unread/);
});

test("UIACT.1-CAP-01: the 'Needs You' 5-item cap only bounds that quick-scan section — the full feed below is derived from the complete item list, never the capped one", () => {
  assert.match(code, /const needsYou = useMemo\(\(\) => items\.filter/);
  assert.match(code, /const filtered = useMemo\(\(\) => items\.filter\(\(i\) => matchesFilter/);
  assert.match(code, /needsYou\.slice\(0, 5\)/);
  // The main feed's own filter/group pipeline reads from `items`, never from `needsYou` — a 6th+
  // actionable item is never dropped, only left out of the quick-scan section's display.
  assert.doesNotMatch(code, /needsYou\.filter|needsYou\.map\(\(item\) => \{[\s\S]{0,200}groupForTimestamp/);
});

test("UIACT-METRIC-01: no predictive interview/offer/hiring metric anywhere in Activity", () => {
  const forbidden = /interview rate|interview chance|offer rate|hiring probability|recruiter response probability|ai success score/i;
  assert.doesNotMatch(code, forbidden);
  assert.doesNotMatch(presentation, forbidden);
});

test("UIACT-ENGINE-01: Activity imports nothing from the apply engine", () => {
  assert.doesNotMatch(code, /from ["']@\/lib\/apply/);
  assert.doesNotMatch(presentation, /from ["']@\/lib\/apply/);
});

test("UIACT-NAMING-01: no JobHunt string anywhere in Activity", () => {
  assert.doesNotMatch(code, /JobHunt/);
  assert.doesNotMatch(presentation, /JobHunt/);
});

test("bounded feed: the fetch limit is a fixed constant, and an honest note appears only when the feed is exactly at that bound", () => {
  assert.match(code, /const LIMIT = 100/);
  assert.match(code, /notifications\.length >= LIMIT/);
  assert.match(code, /Showing your most recent \{LIMIT\} activity items/);
});

test("filters are backed by real domain membership, only shown when more than one domain is actually present", () => {
  assert.match(code, /const domains = useMemo\(\(\) => new Set\(items\.map\(\(i\) => i\.presentation\.domain\)\)/);
  assert.match(code, /const showFilters = domains\.size > 1/);
});

test("UIACT.1-WRITER-01: WRITER_FAILURE is present in the shared candidate-facing notification map — this module's own header claims exhaustive coverage of every type the product actually emits", () => {
  assert.ok(NOTIFICATION_PRESENTATION.WRITER_FAILURE, "expected a WRITER_FAILURE entry in NOTIFICATION_PRESENTATION");
  assert.ok(NOTIFICATION_TYPE_ORDER.includes("WRITER_FAILURE"), "expected WRITER_FAILURE in NOTIFICATION_TYPE_ORDER");
  // Distinct from QUALITY_FAILURE's own wording — these are two different real failure modes
  // (the writer producing nothing valid, vs. a valid draft failing the quality gate).
  assert.notEqual(NOTIFICATION_PRESENTATION.WRITER_FAILURE!.title, NOTIFICATION_PRESENTATION.QUALITY_FAILURE!.title);
  // Activity's own classification of the same real type stays consistent with this fix — both
  // authorities agree WRITER_FAILURE is a real, resume-domain, attention-toned event.
  const activityView = presentActivityItem("WRITER_FAILURE", "job-1", 1);
  assert.equal(activityView.domain, "resume");
  assert.equal(activityView.tone, "attention");
});
