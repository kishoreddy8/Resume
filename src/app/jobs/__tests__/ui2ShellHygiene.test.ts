import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * UI-2 — SHELL HYGIENE + NAVIGATION CLARITY + GLOBAL UX STATES.
 *
 * Static, source-text regression tests — same discipline as designTokens.test.ts /
 * ui1DesignSystemV2.test.ts: no rendering harness exists in this repo, so every assertion here
 * reads real source text rather than mounting a component.
 */

function read(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

/** Strips /* *\/ and // comments — needed wherever a test bans a phrase that this file's own
 *  prose legitimately explains it does NOT do (the same self-reference problem earlier UI phases
 *  hit: a doc comment saying "never X" matches a regex that bans "X"). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const LAYOUT = read("src/app/layout.tsx");
const APP_SHELL = read("src/components/AppShell.tsx");
const SKIP_LINK = read("src/components/SkipLink.tsx");
const BREADCRUMB = read("src/components/ui/Breadcrumb.tsx");
const ERROR_STATE = read("src/components/ui/ErrorState.tsx");
const ROOT_ERROR = read("src/app/error.tsx");
const GLOBAL_ERROR = read("src/app/global-error.tsx");
const NOT_FOUND = read("src/app/not-found.tsx");
const LOADING = read("src/app/loading.tsx");
const INDEX = read("src/components/ui/index.ts");
const APP_SIDEBAR = read("src/components/AppSidebar.tsx");
const ADMIN_LAYOUT = read("src/app/admin/layout.tsx");

// ── UI2-SKIP — one global skip-to-content mechanism ─────────────────────────────────────────────

test("UI2-SKIP-01: a global SkipLink component exists and is rendered exactly once in the root layout, before AppShell", () => {
  assert.match(SKIP_LINK, /export function SkipLink/);
  assert.match(LAYOUT, /import\s*{\s*SkipLink\s*}\s*from\s*"@\/components\/SkipLink"/);
  const skipIndex = LAYOUT.indexOf("<SkipLink");
  const shellIndex = LAYOUT.indexOf("<AppShell");
  assert.ok(skipIndex > -1, "layout.tsx must render <SkipLink />");
  assert.ok(skipIndex < shellIndex, "SkipLink must render before AppShell so it is the first focusable control");
});

test("UI2-SKIP-02: AppShell's <main> carries a stable id in BOTH render paths (chromeless and normal)", () => {
  const mainOccurrences = [...APP_SHELL.matchAll(/<main id="main-content" tabIndex={-1}/g)];
  assert.equal(mainOccurrences.length, 2, "both the chromeless and normal AppShell render paths must target the same id");
});

test("UI2-SKIP-03: the skip link's href and the main region's id are the exact same string", () => {
  const href = SKIP_LINK.match(/href="#([a-z0-9-]+)"/i);
  assert.ok(href, "SkipLink must declare an href");
  assert.match(APP_SHELL, new RegExp(`<main id="${href![1]}"`), "AppShell's main id must match the skip link's target exactly");
});

test("UI2-SKIP-04: no decorative animation on the skip link, and it is used in exactly one place in the whole app tree", () => {
  assert.doesNotMatch(stripComments(SKIP_LINK), /transition|animate|motion/i);
  // Actually count <SkipLink usages across src/app and src/components — not merely how many files
  // happen to be named layout.tsx, which would pass even if a second layout also rendered it.
  const roots = ["src/app", "src/components"];
  let usageCount = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        // SkipLink.tsx itself only DEFINES the component (`export function SkipLink()`), never
        // writes `<SkipLink` as a usage, so no self-match risk requiring exclusion here.
        const text = fs.readFileSync(full, "utf8");
        usageCount += (text.match(/<SkipLink\b/g) ?? []).length;
      }
    }
  };
  for (const root of roots) walk(path.resolve(root));
  assert.equal(usageCount, 1, "exactly one <SkipLink /> usage must exist anywhere in the app (the root layout's)");
});

// ── UI2-BREADCRUMB ───────────────────────────────────────────────────────────────────────────────

test("UI2-BREADCRUMB-01: semantic <nav aria-label=\"Breadcrumb\"> wrapping an ordered list, no clickable divs", () => {
  assert.match(BREADCRUMB, /<nav aria-label="Breadcrumb"/);
  assert.match(BREADCRUMB, /<ol\b/);
  assert.doesNotMatch(BREADCRUMB, /onClick=\{[^}]*\}[\s\S]{0,40}<div/);
});

test("UI2-BREADCRUMB-02: only the final item gets aria-current=\"page\" and renders as text, not a link; earlier items are real <Link>s", () => {
  assert.match(BREADCRUMB, /aria-current=\{current \? "page" : undefined\}/);
  assert.match(BREADCRUMB, /current \|\| !item\.href/);
  assert.match(BREADCRUMB, /import Link from "next\/link"/);
});

test("UI2-BREADCRUMB-03: long labels truncate visually but keep the full text available (title attribute), and Breadcrumb is exported from the shared index", () => {
  assert.match(BREADCRUMB, /truncate/);
  assert.match(BREADCRUMB, /title=\{item\.label\}/);
  assert.match(INDEX, /export \{ Breadcrumb, type BreadcrumbItem \} from "\.\/Breadcrumb"/);
});

// ── UI2-ERROR ────────────────────────────────────────────────────────────────────────────────────

test("UI2-ERROR-01: a root error.tsx exists, is a client component, and never claims data safety it cannot verify", () => {
  assert.match(ROOT_ERROR, /^"use client";/);
  assert.match(ROOT_ERROR, /export default function RootError/);
  assert.match(ROOT_ERROR, /onRetry=\{reset\}/);
  // The one thing this generic boundary is allowed to claim is what reset() itself guarantees —
  // never an assertion about unrelated data being safe. Checked against rendered JSX only — the
  // file's own doc comment legitimately explains that it does NOT make this claim.
  assert.doesNotMatch(stripComments(ROOT_ERROR), /your data is safe|nothing was lost|no data was affected/i);
});

test("UI2-ERROR-02: the raw error message/digest is only ever shown inside the technical-details disclosure, never on the primary surface", () => {
  assert.match(ROOT_ERROR, /technicalDetails=\{/);
  const beforeTechnicalDetails = ROOT_ERROR.slice(0, ROOT_ERROR.indexOf("technicalDetails="));
  assert.doesNotMatch(beforeTechnicalDetails, /error\.message|error\.digest/, "error.message/digest must not appear before the technicalDetails prop");
});

test("UI2-ERROR-03: global-error.tsx exists and renders its own <html>/<body> (the root-layout-failure case)", () => {
  assert.match(GLOBAL_ERROR, /^"use client";/);
  assert.match(GLOBAL_ERROR, /<html lang="en">/);
  assert.match(GLOBAL_ERROR, /<body/);
  assert.match(GLOBAL_ERROR, /export default function GlobalError/);
});

test("UI2-ERROR-04: ErrorState never fabricates 'what's safe' or 'what it affects' — both are caller-supplied and conditionally rendered, never hardcoded", () => {
  assert.match(ERROR_STATE, /whatItAffects && \(/);
  assert.match(ERROR_STATE, /whatIsSafe && \(/);
  assert.doesNotMatch(ERROR_STATE, />\s*Safe\s*<|>\s*This is safe/i);
  // Retry only ever appears when the caller passes onRetry — never inferred.
  assert.match(ERROR_STATE, /onRetry && \(/);
});

test("UI2-ERROR-05: ErrorState's alert region and technical details use existing primitives (Disclosure, BTN_PRIMARY) — no new error component system", () => {
  assert.match(ERROR_STATE, /role="alert"/);
  assert.match(ERROR_STATE, /import\s*{\s*Disclosure\s*}\s*from\s*"\.\/Disclosure"/);
  assert.match(ERROR_STATE, /import\s*{\s*BTN_PRIMARY\s*}\s*from\s*"\.\/Panel"/);
});

// ── UI2-LOADING ──────────────────────────────────────────────────────────────────────────────────

test("UI2-LOADING-01: the root loading.tsx uses the EXISTING skeleton primitives, no bare spinner text, no interpolated percentage", () => {
  assert.match(LOADING, /import\s*{\s*SkeletonLine,\s*SkeletonBlock,\s*LoadingRegion\s*}\s*from\s*"@\/components\/ui\/Skeleton"/);
  const rendered = stripComments(LOADING);
  assert.doesNotMatch(rendered, /Loading\.\.\.|Loading…/);
  assert.doesNotMatch(rendered, /%|percent/i);
});

test("UI2-LOADING-02: the LoadingRegion live-region announcement is never nested inside an aria-hidden ancestor", () => {
  const liveRegionIndex = LOADING.indexOf("<LoadingRegion");
  const hiddenWrapperIndex = LOADING.indexOf('aria-hidden="true"');
  assert.ok(liveRegionIndex > -1 && hiddenWrapperIndex > -1, "both must be present");
  assert.ok(liveRegionIndex < hiddenWrapperIndex, "LoadingRegion must render BEFORE (outside) the aria-hidden decorative block, or screen readers never hear it");
});

// ── UI2-ROUTE — not-found + orphan-route safety ─────────────────────────────────────────────────

test("UI2-ROUTE-01: not-found.tsx uses the shared EmptyState primitive and links back to Home, no giant illustration", () => {
  assert.match(NOT_FOUND, /import\s*{\s*EmptyState\s*}\s*from\s*"@\/components\/ui\/EmptyState"/);
  assert.match(NOT_FOUND, /href="\/home"/);
});

test("UI2-ROUTE-02: the previously-mislabeled 'orphan' routes (master-files, candidates/[id]/settings) are untouched — still real pages, not converted to redirects", () => {
  const masterFiles = read("src/app/master-files/page.tsx");
  const candidateSettings = read("src/app/candidates/[candidateId]/settings/page.tsx");
  assert.doesNotMatch(masterFiles, /redirect\(/, "master-files is actively linked from Profile/Resume/candidate-intelligence — it must not become a redirect stub in a hygiene-only phase");
  assert.doesNotMatch(candidateSettings, /redirect\(/, "candidates/[id]/settings is linked from the persistent CandidateSelector — it must not become a redirect stub in a hygiene-only phase");
});

test("UI2-ROUTE-03: the genuinely under-linked routes (dashboard, candidate-intelligence) are left exactly as they were — no destructive or premature redirect added", () => {
  const dashboard = read("src/app/dashboard/page.tsx");
  const candidateIntelligence = read("src/app/candidate-intelligence/page.tsx");
  assert.doesNotMatch(dashboard, /^\s*redirect\(/m, "dashboard's future belongs to whichever phase decides its relationship to Home — not this one");
  assert.doesNotMatch(candidateIntelligence, /^\s*redirect\(/m);
});

// ── UI2-NAMING ───────────────────────────────────────────────────────────────────────────────────

test("UI2-NAMING-01: AppSidebar's user-visible wordmark and admin/layout's user-visible copy say Career-Ops, not JobHunt", () => {
  // The two doc-COMMENT mentions of "JobHunt" in AppSidebar.tsx are documentation, not user-visible
  // strings — left alone deliberately (see Part 9's scope: user-visible text only).
  assert.doesNotMatch(APP_SIDEBAR, />JobHunt|>Career-Ops<\/span>JobHunt|JobHunt <span/, "no rendered wordmark text may say JobHunt");
  assert.match(APP_SIDEBAR, /Career-Ops <span className="font-medium text-tertiary">Admin<\/span>/);
  assert.match(APP_SIDEBAR, /text-primary">Career-Ops<\/p>/);
  assert.doesNotMatch(ADMIN_LAYOUT, /JobHunt/);
  assert.match(ADMIN_LAYOUT, /Career-Ops/);
});

test("UI2-NAMING-02: the remaining candidate-facing JobHunt inventory is smaller than before this phase, and the two files fixed here are gone from the user-visible count", () => {
  const files = fs
    .readdirSync(path.resolve("src/app"), { recursive: true })
    .filter((f) => typeof f === "string" && /\.(tsx|ts)$/.test(f) && !f.includes("__tests__"));
  let count = 0;
  const remaining: string[] = [];
  for (const f of files) {
    const full = path.join("src/app", f as string);
    if (!fs.statSync(full).isFile()) continue;
    const text = fs.readFileSync(full, "utf8");
    if (/JobHunt/.test(text)) {
      count++;
      remaining.push(full);
    }
  }
  assert.ok(!remaining.includes(path.join("src/app", "admin/layout.tsx")), "admin/layout.tsx must be fully resolved");
  // Regression guard, not a target to chase down in this phase: the count must never creep back UP
  // (a new JobHunt reference slipping in elsewhere), even though bringing it below 22 is explicitly
  // out of scope here — see Part 9's "no repository-wide cleanup" boundary.
  assert.ok(count > 0 && count <= 17, `expected 1-17 remaining src/app JobHunt references (this scan is src/app-scoped, not the whole repo), found ${count}: ${remaining.join(", ")}`);
});

// ── UI2-LANDMARK ─────────────────────────────────────────────────────────────────────────────────

test("UI2-LANDMARK-01: AppShell renders exactly one <main> per code path, and it is a real landmark (not a styled div)", () => {
  const mainTags = [...APP_SHELL.matchAll(/<main\b/g)];
  assert.equal(mainTags.length, 2, "one <main> in the chromeless path, one in the normal path — never zero, never a div standing in for it");
});

test("UI2-LANDMARK-02: the primary and admin navigation rails remain labelled landmarks", () => {
  assert.match(APP_SIDEBAR, /aria-label="Primary"/);
  assert.match(APP_SIDEBAR, /aria-label="Admin"/);
});
