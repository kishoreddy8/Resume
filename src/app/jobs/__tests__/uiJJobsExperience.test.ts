import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * UI-J — SPATIAL PREMIUM JOBS EXPERIENCE.
 *
 * Static, source-text regression tests — same discipline as designTokens.test.ts / the UI-1/UI-2/
 * UI-M suites: no rendering harness exists in this repo, so every assertion here reads real source
 * text rather than mounting a component.
 */

function read(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

/** Strips /* *\/ and // comments — a test banning a phrase can otherwise self-match this file's
 *  own (or the source file's own) doc-comment prose explaining that it does NOT do that thing. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/g, "");
}

const MOBILE_NAV = read("src/components/MobileBottomNav.tsx");
const JOB_ACTIONS = read("src/app/jobs/jobActions.ts");
const RESUME_QUALITY_PIPELINE = read("src/app/jobs/[id]/ResumeQualityPipeline.tsx");
const NOT_INTERESTED_ROUTE = read("src/app/api/jobs/[id]/not-interested/route.ts");
const JOB_SWIPE_CARD = read("src/app/jobs/JobSwipeCard.tsx");
const JOB_DECK = read("src/app/jobs/JobDeck.tsx");
const JOB_CARD_PRESENTATION = read("src/app/jobs/JobCardPresentation.tsx");
const JOB_ROW = read("src/app/jobs/JobRow.tsx");
const H1B_BADGE = read("src/components/H1bBadge.tsx");
const JOB_LIST = read("src/app/jobs/JobList.tsx");
const FOR_YOU_LIST = read("src/app/jobs/ForYouList.tsx");
const JOBS_PAGE = read("src/app/jobs/page.tsx");
const WHY_THIS_MATCH = read("src/app/jobs/WhyThisMatch.tsx");

const UI_J_FILES: [string, string][] = [
  ["jobActions.ts", JOB_ACTIONS],
  ["JobSwipeCard.tsx", JOB_SWIPE_CARD],
  ["JobDeck.tsx", JOB_DECK],
  ["JobCardPresentation.tsx", JOB_CARD_PRESENTATION],
  ["JobRow.tsx", JOB_ROW],
  ["JobList.tsx", JOB_LIST],
  ["ForYouList.tsx", FOR_YOU_LIST],
  ["page.tsx", JOBS_PAGE],
  ["WhyThisMatch.tsx", WHY_THIS_MATCH],
];

// ── UIJ-NAV ──────────────────────────────────────────────────────────────────────────────────────

test("UIJ-NAV-01: UI-J did not touch the frozen mobile nav contract — still exactly Home/Jobs/Applications/Activity/Profile", () => {
  const hrefs = [...MOBILE_NAV.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["/home", "/jobs", "/applications", "/activity", "/profile"]);
});

// ── UIJ-METRIC — no predictive career metrics anywhere in new UI-J copy ─────────────────────────

test("UIJ-METRIC-01: no interview/offer/hiring prediction language anywhere in the new UI-J surfaces", () => {
  const banned = /interview\s*(rate|probability|likelihood|score)|offer\s*(rate|probability)|hiring\s*probability|predicted\s*(interview|offer|recruiter)|chance of (interview|offer)/i;
  for (const [name, source] of UI_J_FILES) {
    assert.doesNotMatch(stripComments(source), banned, `${name} must not contain predictive career-outcome language`);
  }
});

test("UIJ-METRIC-02: no Auto tab, no Interview tab introduced anywhere in UI-J", () => {
  for (const [name, source] of UI_J_FILES) {
    assert.doesNotMatch(source, /label:\s*"(Auto|Interview)"/, `${name} must not add an Auto or Interview destination`);
  }
});

// ── UIJ-ACTION — Approve & Tailor reuses the existing pathway ───────────────────────────────────

test("UIJ-ACTION-01: approveForTailoring hits the exact same two endpoints, in the same order, as the existing ResumeQualityPipeline flow", () => {
  // Same PATCH shape: candidateId, markedForTailoring:true, approval:{approvalType, decision}.
  assert.match(JOB_ACTIONS, /fetch\(`\/api\/jobs\/\$\{jobId\}`/);
  assert.match(JOB_ACTIONS, /markedForTailoring:\s*true/);
  assert.match(JOB_ACTIONS, /approval:\s*\{\s*approvalType,\s*decision\s*\}/);
  assert.match(RESUME_QUALITY_PIPELINE, /markedForTailoring:\s*true/);
  assert.match(RESUME_QUALITY_PIPELINE, /approval:\s*\{[\s\S]{0,40}approvalType/);

  // Same second call: POST the quality-workflow endpoint, no body.
  assert.match(JOB_ACTIONS, /fetch\(`\/api\/candidates\/\$\{candidateId\}\/jobs\/\$\{jobId\}\/quality-workflow`,\s*\{\s*method:\s*"POST",\s*headers:\s*\{\s*"Content-Type":\s*"application\/json"\s*\},\s*\}\)/);
  assert.match(RESUME_QUALITY_PIPELINE, /\/quality-workflow`,\s*\{\s*method:\s*"POST",\s*headers:\s*\{\s*"Content-Type":\s*"application\/json"\s*\},\s*\}\)/);

  // Same approvalType derivation rule: NEEDS_REVIEW -> NEEDS_REVIEW_OVERRIDE, else READY_DIRECT.
  assert.match(JOB_ACTIONS, /"NEEDS_REVIEW_OVERRIDE"\s*:\s*"READY_DIRECT"/);
  assert.match(RESUME_QUALITY_PIPELINE, /"NEEDS_REVIEW_OVERRIDE"\s*:\s*"READY_DIRECT"/);
});

test("UIJ-ACTION-02: approve is only offered when the match decision actually allows it (never for BLOCKED or unevaluated)", () => {
  assert.match(JOB_ACTIONS, /canApproveForTailoring[\s\S]{0,200}READY_FOR_TAILORING[\s\S]{0,40}NEEDS_REVIEW/);
  assert.doesNotMatch(stripComments(JOB_ACTIONS), /canApproveForTailoring[\s\S]{0,120}BLOCKED\s*\|\|/);
});

// ── UIJ-REJECT — Not interested reuses the existing, already-shipped route ──────────────────────

test("UIJ-REJECT-01: rejection calls the existing per-candidate not-interested route, never a delete", () => {
  assert.match(JOB_ACTIONS, /fetch\(`\/api\/jobs\/\$\{jobId\}\/not-interested`/);
  assert.match(JOB_ACTIONS, /notInterested/);
  assert.doesNotMatch(stripComments(NOT_INTERESTED_ROUTE), /DELETE FROM|\.delete\(|deleteJob/i);
  assert.match(NOT_INTERESTED_ROUTE, /NO LONGER deletes the job row/);
});

test("UIJ-REJECT-02: the reject control is labelled truthfully as \"Not interested,\" not \"Archive\" or \"Delete\"", () => {
  assert.match(JOB_SWIPE_CARD, /aria-label="Not interested"/);
  assert.doesNotMatch(JOB_SWIPE_CARD, /aria-label="Archive/);
  assert.doesNotMatch(JOB_SWIPE_CARD, /aria-label="Delete/);
});

// ── UIJ-SWIPE — swipe and tap invoke the identical function, never separate logic ───────────────

test("UIJ-SWIPE-01: the drag release handler and the visible buttons call the exact same commit functions", () => {
  assert.match(JOB_SWIPE_CARD, /function handleDragEnd[\s\S]*?void commitApprove\(\)/);
  assert.match(JOB_SWIPE_CARD, /function handleDragEnd[\s\S]*?void commitReject\(\)/);
  assert.match(JOB_SWIPE_CARD, /onClick=\{commitReject\}/);
  assert.match(JOB_SWIPE_CARD, /onClick=\{commitApprove\}/);
  // Exactly one definition of each — no second, gesture-only or button-only copy of the logic.
  assert.equal((JOB_SWIPE_CARD.match(/async function commitApprove/g) ?? []).length, 1);
  assert.equal((JOB_SWIPE_CARD.match(/async function commitReject/g) ?? []).length, 1);
});

test("UIJ-SWIPE-02: right = Approve & Tailor, left = Not interested, and approval is never success-green", () => {
  assert.match(JOB_SWIPE_CARD, /info\.offset\.x > 0[\s\S]{0,20}void commitApprove/);
  assert.doesNotMatch(stripComments(JOB_SWIPE_CARD), /var\(--success\)/);
});

// ── UIJ-A11Y — a visible tap-equivalent exists for every gesture ────────────────────────────────

test("UIJ-A11Y-01: every swipe action has a real, labelled, 44px+ button — never gesture-only", () => {
  assert.match(JOB_SWIPE_CARD, /aria-label="Not interested"/);
  assert.match(JOB_SWIPE_CARD, /aria-label="Approve & Tailor"/);
  assert.match(JOB_SWIPE_CARD, /h-14 w-14/); // 56px, comfortably over the 44px minimum
});

test("UIJ-A11Y-02: reduced motion removes rotation and the spring fling, but dragging and the buttons still work", () => {
  assert.match(JOB_SWIPE_CARD, /rotate:\s*reduced\s*\?\s*0\s*:\s*rotate/);
  assert.match(JOB_SWIPE_CARD, /useReducedMotion/);
  assert.doesNotMatch(JOB_SWIPE_CARD, /drag=\{interactive && !reduced/, "drag must not be gated behind reduced-motion — only its decoration is");
});

test("UIJ-A11Y-03: the mobile filter sheet and card content use only semantic, keyboard-operable controls", () => {
  assert.match(WHY_THIS_MATCH, /BottomSheet/);
  assert.doesNotMatch(JOB_SWIPE_CARD, /<div[^>]*onClick[^>]*>[\s\S]{0,10}<\/div>/);
});

// ── UIJ-MATCH — match rendering uses only real, already-computed engine data ────────────────────

test("UIJ-MATCH-01: MatchRing/MatchFit read only decision, overallScore and insufficientJdSignal — no invented fields", () => {
  assert.match(JOB_CARD_PRESENTATION, /summary\.decision/);
  assert.match(JOB_CARD_PRESENTATION, /summary\.overallScore/);
  assert.match(JOB_CARD_PRESENTATION, /summary\.insufficientJdSignal/);
  assert.doesNotMatch(JOB_CARD_PRESENTATION, /summary\.(confidence|probability|likelihood)/);
});

test("UIJ-MATCH-02: \"Why this match?\" reuses the existing per-job evidence fetch and the existing SkillAlignment component — no new evidence model", () => {
  assert.match(WHY_THIS_MATCH, /from\s*"\.\/\[id\]\/useJobMatch"/);
  assert.match(WHY_THIS_MATCH, /from\s*"\.\/\[id\]\/SkillAlignment"/);
});

// ── UIJ-SPONSOR — Unknown sponsorship must never render as compatible ───────────────────────────

test("UIJ-SPONSOR-01: Unknown sponsorship stays visually hollow/distinct — UI-J did not touch H1bBadge's semantics", () => {
  assert.match(H1B_BADGE, /Unknown:\s*"bg-transparent ring-1 ring-inset ring-\[var\(--border\)\]"/);
  assert.doesNotMatch(stripComments(JOB_CARD_PRESENTATION), /Unknown[\s\S]{0,60}(compatible|sponsors)/i);
});

test("UIJ-SPONSOR-02: sponsorship is elevated to its own row on the card, not folded silently into a generic metadata line", () => {
  assert.match(JOB_CARD_PRESENTATION, /export function SponsorshipRow/);
  assert.match(JOB_ROW, /<SponsorshipRow confidence=\{job\.h1b_combined_confidence\}/);
  assert.match(JOB_SWIPE_CARD, /<SponsorshipRow confidence=\{job\.h1b_combined_confidence\}/);
});

// ── UIJ-FILTER — mobile filters consume the existing BottomSheet, no second sheet system ────────

test("UIJ-FILTER-01: mobile Jobs filters (All Jobs view) render inside the existing BottomSheet primitive", () => {
  assert.match(JOBS_PAGE, /import\s*\{\s*BottomSheet\s*\}\s*from\s*"@\/components\/ui"/);
  assert.match(JOBS_PAGE, /<BottomSheet open=\{mobileFiltersOpen\}[\s\S]{0,120}<JobFilterSidebar/);
});

test("UIJ-FILTER-02: For You's own filter controls also render inside the existing BottomSheet on mobile — not a second dialog implementation", () => {
  assert.match(FOR_YOU_LIST, /import\s*\{\s*BottomSheet\s*\}\s*from\s*"@\/components\/ui"/);
  assert.match(FOR_YOU_LIST, /<BottomSheet open=\{forYouFiltersOpen\}/);
});

// ── UIJ-MOTION — reduced motion strips the nonessential swipe motion ────────────────────────────

test("UIJ-MOTION-01: reduced motion drops the swipe-intent overlays and the spring release, keeping only the essential transition", () => {
  assert.match(JOB_SWIPE_CARD, /interactive && !reduced &&/);
  assert.match(JOB_SWIPE_CARD, /reduced \? \{ duration: busy \? 0\.14 : 0 \}/);
});

// ── UIJ-DESKTOP — desktop keeps the existing list + navigate-to-detail model ────────────────────

test("UIJ-DESKTOP-01: JobList and ForYouList still render the dense stacked JobRow list at lg and up, unchanged", () => {
  assert.match(JOB_LIST, /hidden min-h-0 flex-1 space-y-3 \[scroll-padding-block:3rem\] lg:block/);
  assert.match(FOR_YOU_LIST, /hidden space-y-3 lg:block/);
});

test("UIJ-DESKTOP-02: clicking a job on desktop still navigates to its existing detail workspace — no in-page split-view was invented", () => {
  assert.match(JOB_LIST, /router\.push\(`\/jobs\/\$\{id\}`\)/);
  assert.match(FOR_YOU_LIST, /router\.push\(`\/jobs\/\$\{id\}`\)/);
});

// ── UIJ-MOBILE — mobile uses the focused card/deck model ────────────────────────────────────────

test("UIJ-MOBILE-01: JobList and ForYouList each mount the shared JobDeck below lg", () => {
  assert.match(JOB_LIST, /import \{ JobDeck \} from "\.\/JobDeck"/);
  assert.match(FOR_YOU_LIST, /import \{ JobDeck \} from "\.\/JobDeck"/);
  assert.match(JOB_LIST, /<div className="lg:hidden">\s*<JobDeck/);
  assert.match(FOR_YOU_LIST, /<div className="lg:hidden">\s*<JobDeck/);
});

test("UIJ-MOBILE-02: the deck shows at most the current card plus one peeking card, never a theatrical fan", () => {
  assert.equal((JOB_DECK.match(/<JobSwipeCard/g) ?? []).length, 2);
  assert.match(JOB_DECK, /items\[index \+ 1\]/);
});

// ── UIJ-ENGINE — zero application-submission engine involvement ─────────────────────────────────

test("UIJ-ENGINE-01: no new UI-J file imports from the application-submission engine", () => {
  for (const [name, source] of UI_J_FILES) {
    assert.doesNotMatch(source, /from\s*["']@\/lib\/apply/, `${name} must not import from src/lib/apply`);
  }
});

test("UIJ-ENGINE-02: the tailoring action never claims or performs employer submission", () => {
  assert.doesNotMatch(stripComments(JOB_ACTIONS), /submit.{0,20}employer|employer.{0,20}submi/i);
});
