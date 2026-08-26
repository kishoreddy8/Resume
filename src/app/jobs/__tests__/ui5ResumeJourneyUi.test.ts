import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * UI-5 — component-source-level contracts. Same static-source-text discipline as the rest of this
 * suite (designTokens.test.ts, ui1/ui2/uiM/uiJ suites): no rendering harness exists in this repo.
 * The pure presentation-mapping function itself (resumeJourneyPresentation.ts) is covered
 * behaviorally in ui5ResumeJourney.test.ts — these tests cover the React components that consume it.
 */

function read(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const STAGE_RAIL = read("src/app/jobs/[id]/StageRail.tsx");
const PIPELINE = read("src/app/jobs/[id]/ResumeQualityPipeline.tsx");
const WORKSPACE = read("src/app/jobs/[id]/JobWorkspace.tsx");
const START_APPLICATION = read("src/app/jobs/[id]/StartApplication.tsx");
const JOURNEY_PRESENTATION = read("src/app/jobs/[id]/resumeJourneyPresentation.ts");

// ── UI5-A11Y — stage rail semantics ──────────────────────────────────────────────────────────────

test("UI5-A11Y-01: the stage rail is a semantic ordered list, not a div soup", () => {
  assert.match(STAGE_RAIL, /<ol aria-label="Resume tailoring progress"/);
  assert.match(STAGE_RAIL, /<li\b/);
});

test("UI5-A11Y-02: the current stage carries aria-current=\"step\", and only the current stage does", () => {
  assert.match(STAGE_RAIL, /aria-current=\{stage\.key === currentStageKey \? "step" : undefined\}/);
});

test("UI5-A11Y-03: reduced motion is respected — the rail and the journey drop non-essential animation", () => {
  assert.match(STAGE_RAIL, /useReducedMotion/);
  assert.match(STAGE_RAIL, /reduced \? \{ duration: 0 \}/);
  assert.match(STAGE_RAIL, /reduced \? false :/);
});

test("UI5-A11Y-04: stage state is never color-only — completed/current/upcoming/attention each carry a distinct glyph or shape", () => {
  assert.match(STAGE_RAIL, /function CircleGlyph/);
  // completed: check path; current: filled dot inside a ring; attention: "!"; upcoming: hollow ring.
  assert.match(STAGE_RAIL, /M3 8\.5 6\.5 12 13 4\.5/);
  assert.match(STAGE_RAIL, /text-\[12px\] font-bold leading-none">\!<\/span>/);
  assert.match(STAGE_RAIL, /ring-1 ring-inset ring-\[var\(--border-control\)\]/);
});

test("UI5-A11Y-05: the current stage's headline is announced via one polite live region, not several", () => {
  const matches = PIPELINE.match(/aria-live="polite"/g) ?? [];
  assert.equal(matches.length, 1, `expected exactly one aria-live="polite" region in the journey, found ${matches.length}`);
});

// ── UI5-MOBILE — sticky action accounts for the existing mobile nav ─────────────────────────────

test("UI5-MOBILE-01: the mobile sticky action bar clears MobileBottomNav's real height and the safe-area inset", () => {
  assert.match(PIPELINE, /bottom-\[calc\(56px\+env\(safe-area-inset-bottom\)\)\]/);
  assert.match(PIPELINE, /lg:hidden/);
});

test("UI5-MOBILE-02: the sticky action never appears while tailoring is simply processing — only for a real actionable state", () => {
  // The stickyAction ternary chain (computed above the return, before the wrapper renders it) only
  // resolves to a real control for ready/safe-best-attempt/unstarted/failed — never for the plain
  // in-progress (writer/review/improvement) states, which fall through to `null` in every branch.
  const chainStart = PIPELINE.indexOf("const stickyAction =");
  const chainEnd = PIPELINE.indexOf("return (", chainStart);
  const stickyChain = PIPELINE.slice(chainStart, chainEnd);
  assert.match(stickyChain, /: null;/, "the ternary chain must fall through to a plain null, never a fabricated button");
  assert.doesNotMatch(stickyChain, /Tailoring your resume|Checking quality|Finalizing/);
});

test("UI5.1-MOBILE-03: the sticky action wrapper itself is entirely absent (not merely visually empty) whenever no genuine action exists", () => {
  // Confirmed via a real Playwright pointer-event-interception failure during checkpoint review: an
  // always-rendered wrapper (border/shadow/padding, empty child) still blocks taps on whatever sits
  // beneath it, even while showing no button. The wrapper must be gated on the computed action itself.
  assert.match(PIPELINE, /\{stickyAction && \(/, "the fixed sticky wrapper must be conditioned on the computed action, not on `variant` alone");
  assert.doesNotMatch(PIPELINE, /\{variant === "journey" && \(\s*\n\s*<div className="fixed inset-x-0 bottom-\[calc\(56px/, "the sticky wrapper must not render unconditionally for variant=\"journey\"");
});

// ── UI5-SCORE — raw scores are not the primary surface ──────────────────────────────────────────

test("UI5-SCORE-01: ScoreBar (raw sub-scores) renders only inside the technical/diagnostics panel, never in the primary journey banners", () => {
  const diagnosticsStart = PIPELINE.indexOf("function DiagnosticsPanel");
  const primarySource = PIPELINE.slice(0, diagnosticsStart);
  const diagnosticsSource = PIPELINE.slice(diagnosticsStart);
  assert.doesNotMatch(primarySource, /<ScoreBar\b/);
  assert.match(diagnosticsSource, /<ScoreBar\b/);
});

test("UI5-SCORE-02: the primary ready state leads with the verdict, not a score dashboard", () => {
  const readyBlockStart = PIPELINE.indexOf('workflow?.status === "READY" && !isSafeBestAttempt');
  const readyBlock = PIPELINE.slice(readyBlockStart, readyBlockStart + 900);
  assert.match(readyBlock, /Your resume is ready/);
  // The one number shown inline is the overall quality score via the honest formatter — not a
  // grid of sub-scores (those stay in DiagnosticsPanel, verified above).
  assert.match(readyBlock, /formatQualityScore\(workflow\.latest_overall_score\)/);
  assert.doesNotMatch(readyBlock, /<ScoreBar\b/);
});

// ── UI5-ACTION — Continue reuses the existing path, never submits, never appears mid-processing ─

test("UI5-ACTION-01: Continue to Application navigates to the existing workspace Application step — no new route", () => {
  assert.match(PIPELINE, /jobWorkspaceUrl\(jobId, \{ step: "application" \}\)/);
  assert.match(PIPELINE, /<Link\s+href=\{applicationHref\}/);
});

test("UI5-ACTION-02: Continue never starts or submits an application — it is a plain Link, never a fetch/POST", () => {
  // Isolate just the Continue-to-application anchor's own immediate JSX, not the whole file, so this
  // cannot be satisfied by some unrelated POST elsewhere in the component.
  const continueBlocks = [...PIPELINE.matchAll(/<Link\s+href=\{applicationHref\}[\s\S]{0,200}?<\/Link>/g)];
  assert.ok(continueBlocks.length >= 1, "expected at least one Continue-to-application Link");
  for (const [block] of continueBlocks) {
    assert.doesNotMatch(block, /fetch\(|onClick=\{(?!.*applicationHref)/);
  }
  // The real application-starting action lives only in StartApplication.tsx, and is a real POST —
  // confirming ResumeQualityPipeline's Continue link is a genuinely different, lesser action.
  assert.match(START_APPLICATION, /application-runs\/start/);
  assert.doesNotMatch(PIPELINE, /application-runs\/start/);
});

test("UI5-ACTION-03: Continue to Application is never offered while the workflow is still in progress or genuinely blocked", () => {
  assert.match(PIPELINE, /const canContinueToApplication =\s*\n\s*journey\.tone === "ready" \|\| \(isSafeBestAttempt && isApprovedForCurrentWorkflow\);/);
});

test("UI5-ACTION-04: no fake Continue button is rendered for the plain in-progress stages", () => {
  // presentResumeJourney's own tone is "progress" for tailoring/checking_quality/finalizing — the
  // journey headline area never renders a Continue link itself; only the ready/safe-best-attempt
  // banners do, and those are gated by canContinueToApplication (checked above).
  const stagesCardEnd = PIPELINE.indexOf("Unstarted, unapproved");
  const journeyHeaderSource = PIPELINE.slice(PIPELINE.indexOf("journey.stages && ("), stagesCardEnd);
  assert.doesNotMatch(journeyHeaderSource, /applicationHref/);
});

// ── UI5-ENGINE — no application-submission engine involvement ───────────────────────────────────

test("UI5-ENGINE-01: none of the new/changed UI-5 files import from the application-submission engine", () => {
  for (const [name, source] of [
    ["ResumeQualityPipeline.tsx", PIPELINE],
    ["StageRail.tsx", STAGE_RAIL],
    ["resumeJourneyPresentation.ts", JOURNEY_PRESENTATION],
  ] as const) {
    assert.doesNotMatch(source, /from\s*["']@\/lib\/apply/, `${name} must not import from src/lib/apply`);
  }
});

// ── UI5-METRIC — no predictive career metrics ────────────────────────────────────────────────────

test("UI5-METRIC-02: no interview/offer predictive language anywhere in the touched component files", () => {
  const banned = /interview\s*(rate|probability|likelihood|chance|score)|offer\s*(rate|probability|chance)|hiring\s*probability|predicted\s*(interview|offer|recruiter)/i;
  for (const source of [STAGE_RAIL, PIPELINE, WORKSPACE, JOURNEY_PRESENTATION]) {
    assert.doesNotMatch(stripComments(source), banned);
  }
});

// ── Sanity: the technical variant never double-nests a disclosure ──────────────────────────────

test("the technical variant renders diagnostics unwrapped — no disclosure nested inside JobWorkspace's own", () => {
  const diagnosticsPanelSource = PIPELINE.slice(PIPELINE.indexOf("function DiagnosticsPanel"));
  assert.match(diagnosticsPanelSource, /if \(variant === "technical"\) return content;/);
});

// ── UI5.1 checkpoint — writer-status banner headline is exhaustively truthful for its only two
// reachable inputs ──────────────────────────────────────────────────────────────────────────────

test("UI5.1-WRITER-01: waitingFor is EXTERNAL_WRITER only for CREATED and IMPROVEMENT_RUNNING — never WRITER_RUNNING", () => {
  // This is what makes the pipeline's CREATED/"else" headline ternary exhaustively correct: WRITER_
  // RUNNING can never reach the banner it feeds, so there is no "corrections required" headline
  // being wrongly shown for a first, non-corrective draft in progress. Pinned against the real route
  // so a future change to this ternary can't silently make the pipeline's headline branch reachable-
  // but-wrong again without a test noticing.
  const route = read("src/app/api/candidates/[candidateId]/jobs/[jobId]/quality-workflow/route.ts");
  const waitingForBlock = route.slice(route.indexOf("const waitingFor ="), route.indexOf("const writer:"));
  assert.match(waitingForBlock, /workflow\?\.status === "IMPROVEMENT_RUNNING" \|\| workflow\?\.status === "CREATED"\s*\n\s*\? "EXTERNAL_WRITER"/);
  assert.doesNotMatch(waitingForBlock, /"WRITER_RUNNING"/, "WRITER_RUNNING must not be added to the EXTERNAL_WRITER condition without re-checking the pipeline's headline ternary below it");
});

test("UI5.1-WRITER-02: the writer-status headline's only two reachable branches are both truthful (CREATED = first draft, everything else reaching this banner = IMPROVEMENT_RUNNING = corrections)", () => {
  assert.match(PIPELINE, /workflow\?\.status === "CREATED" \? "Approved — awaiting first draft" : "Corrections required — awaiting next draft"/);
});

// ── UI5.1 checkpoint — Technical details never offers a download for a genuinely blocked resume ──

test("UI5.1-SAFETY-01: the legacy FAILED diagnostics block (which only ever renders for the BLOCKED/unsafe case) never offers a resume or cover-letter download", () => {
  // This block's own render guard is workflow?.status === "FAILED" && !isSafeBestAttempt — the exact
  // definition of isBlockedUnsafe — so it is BLOCKED-only by construction. The artifacts route for
  // FAILED serves the human-review docx with no safety/disposition check at all, so a download link
  // here would contradict the primary BLOCKED banner's own promise ("no download is offered for it")
  // one click away, behind Technical details.
  const legacyStart = PIPELINE.indexOf("Legacy FAILED detail");
  const legacyBlock = PIPELINE.slice(legacyStart, legacyStart + 3000);
  const legacyBlockEnd = legacyBlock.indexOf("{/* Writer scheduler/queue detail. */}");
  const scoped = legacyBlockEnd === -1 ? legacyBlock : legacyBlock.slice(0, legacyBlockEnd);
  assert.doesNotMatch(scoped, /Download best resume|Download best cover letter/);
  assert.doesNotMatch(scoped, /hasHumanReviewResume|hasHumanReviewCoverLetter/, "no download control may be gated on these flags in the BLOCKED-only legacy block");
});

// ── Sanity: current-stage state is never rendered success-green ─────────────────────────────────

test("the current/in-progress stage state never uses the success/green token — only completed and ready do, and only genuinely", () => {
  const rail = stripComments(STAGE_RAIL);
  assert.doesNotMatch(rail, /state === "current"[\s\S]{0,120}var\(--success\)/);
});
