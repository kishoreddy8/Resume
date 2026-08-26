import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * UI-M — MOBILE + RESPONSIVE SHELL FOUNDATION.
 *
 * Static, source-text regression tests — same discipline as designTokens.test.ts /
 * ui1DesignSystemV2.test.ts / ui2ShellHygiene.test.ts: no rendering harness exists in this repo, so
 * every assertion here reads real source text rather than mounting a component.
 */

function read(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

/** Strips /* *\/ and // comments — a test banning a phrase can otherwise self-match this file's
 *  own (or the source file's own) doc-comment prose explaining that it does NOT do that thing. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const MOBILE_NAV = read("src/components/MobileBottomNav.tsx");
const APP_SHELL = read("src/components/AppShell.tsx");
const APP_SIDEBAR = read("src/components/AppSidebar.tsx");
const BOTTOM_SHEET = read("src/components/ui/BottomSheet.tsx");
const UI_INDEX = read("src/components/ui/index.ts");
const MOTION_TOKENS = read("src/lib/motion/tokens.ts");
const GLOBALS_CSS = read("src/app/globals.css");
const THEME_LIB = read("src/lib/theme/index.ts");
const THEME_SCRIPT = read("src/components/ThemeScript.tsx");
const LAYOUT = read("src/app/layout.tsx");
const SETTINGS_PAGE = read("src/app/settings/page.tsx");
const SETTINGS_CATEGORIES = read("src/app/settings/categories.ts");
const ACTIVITY_PAGE = read("src/app/activity/page.tsx");
const BREADCRUMB = read("src/components/ui/Breadcrumb.tsx");

// ── UI-M-NAV — frozen five-tab mobile bottom nav ────────────────────────────────────────────────

test("UI-M-NAV-01: MobileBottomNav declares exactly the five frozen destinations, in order", () => {
  const hrefs = [...MOBILE_NAV.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["/home", "/jobs", "/applications", "/activity", "/profile"]);
});

test("UI-M-NAV-02: no forbidden destination (Auto, Interview, Admin) appears as a mobile nav tab", () => {
  const body = stripComments(MOBILE_NAV);
  assert.doesNotMatch(body, /href:\s*"\/(auto|interview|admin)/i);
  assert.doesNotMatch(body, /label:\s*"(Auto|Interview|Admin)"/);
});

test("UI-M-NAV-03: is a semantic <nav> with an accessible label, real <Link>s, and aria-current on the active tab", () => {
  assert.match(MOBILE_NAV, /<nav\s+aria-label="Primary"/);
  assert.match(MOBILE_NAV, /import Link from "next\/link"/);
  assert.match(MOBILE_NAV, /<Link\b/);
  assert.match(MOBILE_NAV, /aria-current=\{active \? "page" : undefined\}/);
});

test("UI-M-NAV-04: every tab has a visible text label alongside its icon — never icon-only", () => {
  // One <Icon ... /> per item and one rendered `{item.label}` — icon-only would drop the label span.
  assert.match(MOBILE_NAV, /<Icon\b/);
  assert.match(MOBILE_NAV, /\{item\.label\}/);
});

test("UI-M-NAV-05: active state is never color-only — a font-weight (and, absent reduced motion, a shape) change accompanies the color", () => {
  assert.match(MOBILE_NAV, /font-semibold/);
  assert.match(MOBILE_NAV, /font-medium/);
});

test("UI-M-NAV-06: nav is hidden at lg and up (AppSidebar owns desktop nav there), and reduced motion drops the sliding indicator to a static bar", () => {
  assert.match(MOBILE_NAV, /lg:hidden/);
  assert.match(MOBILE_NAV, /useReducedMotion/);
  assert.match(MOBILE_NAV, /reduced\s*\?/);
  assert.match(MOBILE_NAV, /layoutId="mobile-nav-indicator"/);
});

// ── UI-M-A11Y — touch targets, safe area, no color-only state ───────────────────────────────────

test("UI-M-A11Y-01: every mobile nav tab meets the 44x44 minimum touch target", () => {
  assert.match(MOBILE_NAV, /min-h-\[56px\]/);
});

test("UI-M-A11Y-02: bottom nav reserves the OS safe area, and AppShell pads content clear of the fixed nav", () => {
  assert.match(MOBILE_NAV, /env\(safe-area-inset-bottom\)/);
  assert.match(APP_SHELL, /calc\(56px\+env\(safe-area-inset-bottom\)/);
});

test("UI-M-A11Y-03: the theme control is a labelled radio group, not an icon-only toggle", () => {
  assert.match(SETTINGS_PAGE, /role="radiogroup"/);
  assert.match(SETTINGS_PAGE, /aria-label="Theme"/);
  assert.match(SETTINGS_PAGE, /type="radio"/);
  // Real text labels ("System" / "Light" / "Dark"), not solely an icon glyph.
  assert.match(SETTINGS_PAGE, /label:\s*"System"/);
  assert.match(SETTINGS_PAGE, /label:\s*"Light"/);
  assert.match(SETTINGS_PAGE, /label:\s*"Dark"/);
});

// ── UI-M-SHEET — the one reusable BottomSheet primitive ──────────────────────────────────────────

test("UI-M-SHEET-01: BottomSheet uses a native <dialog> with showModal()/close(), not a hand-rolled modal", () => {
  assert.match(BOTTOM_SHEET, /<dialog/);
  assert.match(BOTTOM_SHEET, /\.showModal\(\)/);
  assert.match(BOTTOM_SHEET, /\.close\(\)/);
});

test("UI-M-SHEET-02: Escape (native onCancel) is intercepted so the caller's onClose runs and the exit animation gets to play", () => {
  assert.match(BOTTOM_SHEET, /onCancel=\{/);
  assert.match(BOTTOM_SHEET, /preventDefault\(\)/);
  assert.match(BOTTOM_SHEET, /onExitComplete=\{[^}]*\.close\(\)/);
});

test("UI-M-SHEET-03: focus is restored to the triggering element on close", () => {
  assert.match(BOTTOM_SHEET, /restoreFocusTo/);
  assert.match(BOTTOM_SHEET, /document\.activeElement/);
  assert.match(BOTTOM_SHEET, /restoreFocusTo\.current\?\.focus\(\)/);
});

test("UI-M-SHEET-04: a visible, labelled Close control exists (not dismiss-by-gesture-only)", () => {
  assert.match(BOTTOM_SHEET, /aria-label="Close"/);
  assert.match(BOTTOM_SHEET, /onClick=\{onClose\}/);
});

test("UI-M-SHEET-05: sheet motion uses the shared emphasized token, backdrop uses the shared normal duration, and reduced motion drops to an instant/simple transition", () => {
  assert.match(BOTTOM_SHEET, /import\s*\{\s*MOTION_EMPHASIZED,\s*MOTION_NORMAL_MS\s*\}\s*from\s*"@\/lib\/motion\/tokens"/);
  assert.match(BOTTOM_SHEET, /transition=\{reduced \? \{ duration: 0\.12 \} : MOTION_EMPHASIZED\}/);
  assert.match(BOTTOM_SHEET, /MOTION_NORMAL_MS \/ 1000/);
});

test("UI-M-SHEET-06: BottomSheet is exported from the shared ui barrel", () => {
  assert.match(UI_INDEX, /export\s*\{\s*BottomSheet\s*\}\s*from\s*"\.\/BottomSheet"/);
});

// ── UI-M-THEME — explicit System/Light/Dark preference ───────────────────────────────────────────

test("UI-M-THEME-01: every prefers-color-scheme dark block is guarded against an explicit Light choice", () => {
  const mediaBlocks = GLOBALS_CSS.match(/@media \(prefers-color-scheme: dark\)/g) ?? [];
  assert.ok(mediaBlocks.length >= 6, "expected at least the 6 known dark media blocks to still exist");
  assert.match(GLOBALS_CSS, /:root:not\(\[data-theme="light"\]\)/);
});

test("UI-M-THEME-02: an explicit Dark choice is mirrored via a [data-theme=\"dark\"] block for every guarded selector", () => {
  const notLightCount = (GLOBALS_CSS.match(/:not\(\[data-theme="light"\]\)/g) ?? []).length;
  const explicitDarkCount = (GLOBALS_CSS.match(/\[data-theme="dark"\]/g) ?? []).length;
  assert.ok(notLightCount >= 6, `expected >= 6 :not([data-theme="light"]) guards, found ${notLightCount}`);
  assert.ok(
    explicitDarkCount >= notLightCount,
    `every :not([data-theme="light"]) guard needs at least one [data-theme="dark"] twin (guards=${notLightCount}, twins=${explicitDarkCount})`,
  );
});

/** Every flat declaration body `{ ...no nested braces... }` that immediately follows `selector`,
 *  in file order, with CSS comments stripped (a comment explaining ONE copy's tokens is not a value
 *  difference — only the declarations themselves need to match). Every dark-token block in
 *  globals.css is a flat custom-property list (no nested rules), so a non-greedy `{[^}]*}` per
 *  match is a safe, simple parse. */
function allDeclarationBodies(source: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped + "\\s*\\{([^}]*)\\}", "g");
  const bodies: string[] = [];
  for (const m of source.matchAll(re)) {
    bodies.push(m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim());
  }
  return bodies;
}

/** Two independent copies of the same dark tokens (one OS-driven, one explicit-choice) exist
 *  because plain CSS cannot express "this media query OR this attribute" as one rule body — see
 *  the UI-M comment at the top of the first dark block in globals.css. That means nothing stops
 *  the two copies from drifting apart by hand-edit. Since a token-indirection refactor big enough
 *  to remove the duplication entirely is out of scope for this phase, this pins every pair
 *  byte-identical (modulo whitespace) instead, so any future edit to one without the other fails
 *  the suite immediately rather than shipping a light/dark inconsistency silently.
 *
 *  Pairing is by FILE ORDER rather than by naming each block's first property: every guarded block
 *  in globals.css is immediately followed by its own explicit-theme twin before the next guarded
 *  block begins, so the Nth bare `:root:not([data-theme="light"]) {` and the Nth bare
 *  `:root[data-theme="dark"] {` are always each other's twin — this holds regardless of how the
 *  file is reformatted, unlike matching on exact leading whitespace or the first property name. */
test("UI-M-THEME-07: every OS-driven dark block and its explicit [data-theme=dark] twin declare identical values", () => {
  const guarded = allDeclarationBodies(GLOBALS_CSS, ':root:not([data-theme="light"])');
  const explicit = allDeclarationBodies(GLOBALS_CSS, ':root[data-theme="dark"]');
  assert.equal(guarded.length, 5, `expected 5 bare :root:not([data-theme="light"]) blocks, found ${guarded.length}`);
  assert.equal(explicit.length, 5, `expected 5 bare :root[data-theme="dark"] blocks, found ${explicit.length}`);
  for (let i = 0; i < guarded.length; i++) {
    assert.equal(explicit[i], guarded[i], `dark block #${i + 1}: explicit [data-theme="dark"] copy has drifted from its OS-driven twin`);
  }

  // The admin class-selector rules are a compound selector, not a bare :root block — checked
  // separately, one class at a time so a mismatch names exactly which status color drifted.
  for (const cls of ["admin-status-positive", "admin-status-warning", "admin-status-critical", "admin-status-info"]) {
    const [guardedRule] = allDeclarationBodies(GLOBALS_CSS, `:root:not([data-theme="light"]) .${cls}`);
    const [explicitRule] = allDeclarationBodies(GLOBALS_CSS, `:root[data-theme="dark"] .${cls}`);
    assert.equal(explicitRule, guardedRule, `${cls}: explicit [data-theme="dark"] copy has drifted from its OS-driven twin`);
  }
});

test("UI-M-THEME-03: theme preference persists client-side only (localStorage) — no new API route or DB table", () => {
  assert.match(THEME_LIB, /localStorage/);
  assert.doesNotMatch(stripComments(THEME_LIB), /fetch\(|CREATE TABLE|\/api\//);
});

test("UI-M-THEME-04: System is the safe fallback everywhere the stored preference is read", () => {
  assert.match(THEME_LIB, /export type ThemePreference = "system" \| "light" \| "dark"/);
  assert.match(THEME_LIB, /return "system"/);
});

test("UI-M-THEME-05: a pre-hydration script sets data-theme before paint, and it is the first child of <body>", () => {
  assert.match(THEME_SCRIPT, /dangerouslySetInnerHTML/);
  assert.match(THEME_LIB, /THEME_INIT_SCRIPT/);
  const bodyIndex = LAYOUT.search(/<body\b[^>]*>/);
  const themeScriptIndex = LAYOUT.indexOf("<ThemeScript");
  const skipLinkIndex = LAYOUT.indexOf("<SkipLink");
  assert.ok(bodyIndex > -1 && themeScriptIndex > bodyIndex, "<ThemeScript /> must render inside <body>");
  assert.ok(themeScriptIndex < skipLinkIndex, "<ThemeScript /> must render before every other body child");
});

test("UI-M-THEME-06: no dark-mode inversion trick (no CSS filter: invert on the theme root)", () => {
  assert.doesNotMatch(GLOBALS_CSS, /filter:\s*invert/);
});

// ── UI-M-RESPONSIVE — one mobile nav surface, sidebar preserved on desktop ───────────────────────

test("UI-M-RESPONSIVE-01: AppShell renders MobileBottomNav for the candidate product only, never inside Admin", () => {
  assert.match(APP_SHELL, /import\s*\{\s*MobileBottomNav\s*\}\s*from\s*"@\/components\/MobileBottomNav"/);
  assert.match(APP_SHELL, /\{!pathname\.startsWith\("\/admin"\) && <MobileBottomNav \/>\}/);
});

test("UI-M-RESPONSIVE-02: AppSidebar's candidate rail renders nothing below lg (MobileBottomNav is the one mobile nav surface)", () => {
  assert.match(APP_SIDEBAR, /className="hidden w-full shrink-0 flex-col overflow-hidden[^"]*lg:flex/);
});

// ── UI-M-SAFETY — apply-engine and dependency boundaries ─────────────────────────────────────────

test("UI-M-SAFETY-01: no UI-M file imports from the application-submission engine", () => {
  const uiMFiles = [
    ["MobileBottomNav.tsx", MOBILE_NAV],
    ["AppShell.tsx", APP_SHELL],
    ["BottomSheet.tsx", BOTTOM_SHEET],
    ["activity/page.tsx", ACTIVITY_PAGE],
    ["settings/page.tsx", SETTINGS_PAGE],
    ["theme/index.ts", THEME_LIB],
  ] as const;
  for (const [name, source] of uiMFiles) {
    assert.doesNotMatch(source, /from\s*["']@\/lib\/apply/, `${name} must not import from src/lib/apply`);
  }
});

// ── Supporting shell-page + primitive confirmations ──────────────────────────────────────────────

test("UI-M-ACTIVITY-01: /activity reuses the existing notifications API only — no new notification type, no new backend route", () => {
  assert.match(ACTIVITY_PAGE, /\/api\/candidates\/\$\{candidateId\}\/notifications/);
  assert.doesNotMatch(stripComments(ACTIVITY_PAGE), /CREATE TABLE|new notification type/i);
});

test("UI-M-BREADCRUMB-01: Breadcrumb already truncates per-crumb and stays min-w-0 end to end, so it can collapse on mobile without new code", () => {
  assert.match(BREADCRUMB, /min-w-0/);
  assert.match(BREADCRUMB, /truncate/);
});

test("UI-M-MOTION-01: MOTION_NORMAL exists as a 200ms critically-damped spring alongside the existing MOTION_EMPHASIZED", () => {
  assert.match(MOTION_TOKENS, /export const MOTION_NORMAL: Transition = \{ type: "spring", duration: MOTION_NORMAL_MS \/ 1000, bounce: 0 \}/);
});

test("UI-M-SETTINGS-01: Appearance is a real settings category, not a redesign of the other categories", () => {
  assert.match(SETTINGS_CATEGORIES, /"appearance"/);
  assert.match(SETTINGS_CATEGORIES, /label: "Appearance"/);
});
