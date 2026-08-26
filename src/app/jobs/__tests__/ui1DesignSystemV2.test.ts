import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * UI-1 — DESIGN SYSTEM V2 CONSOLIDATION.
 *
 * Static, source-text regression tests — the same discipline `designTokens.test.ts` already
 * established for this file: no rendering harness exists in this repo (confirmed: no
 * testing-library/jsdom dependency anywhere), so every assertion here reads real source text
 * rather than mounting a component.
 */

function read(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

const CSS = read("src/app/globals.css");
const STATUS = read("src/components/ui/Status.tsx");
const PANEL = read("src/components/ui/Panel.tsx");
const BUTTON = read("src/components/ui/Button.tsx");
const CHOREOGRAPHY = read("src/app/jobs/[id]/choreography.ts");
const MOTION_TOKENS = read("src/lib/motion/tokens.ts");
const LAYOUT = read("src/app/layout.tsx");

/** Same brace-counting technique `designTokens.test.ts` uses — a top-level dark-mode media block
 *  can nest further media queries inside it, so a plain regex cannot find its true end. */
function darkMediaRanges(css: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const marker = "@media (prefers-color-scheme: dark)";
  let searchFrom = 0;
  for (;;) {
    const start = css.indexOf(marker, searchFrom);
    if (start === -1) break;
    const openBrace = css.indexOf("{", start);
    let depth = 1;
    let i = openBrace + 1;
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    ranges.push([start, i]);
    searchFrom = i;
  }
  return ranges;
}

function splitLightDark(css: string): { light: string; dark: string } {
  const darkRanges = darkMediaRanges(css);
  let light = css;
  for (const [start, end] of darkRanges.slice().reverse()) light = light.slice(0, start) + light.slice(end);
  const dark = darkRanges.map(([start, end]) => css.slice(start, end)).join("\n");
  return { light, dark };
}

// ── UI1-COLOR-01/02 — brand primary is distinct from success ───────────────────────────────────

test("UI1-COLOR-01: --accent (brand primary) and --success are declared as distinct values", () => {
  const accentMatch = CSS.match(/--accent:\s*(#[0-9a-fA-F]{6});/);
  const successMatch = CSS.match(/--success:\s*(#[0-9a-fA-F]{6});/);
  assert.ok(accentMatch, "--accent must be declared as a hex colour");
  assert.ok(successMatch, "--success must be declared as a hex colour");
  assert.notEqual(accentMatch![1].toLowerCase(), successMatch![1].toLowerCase(), "brand primary must never equal the success colour");
});

test("UI1-COLOR-02: the primary CTA (BTN_PRIMARY and Button's primary variant) never references --success or --pill-success", () => {
  const btnPrimaryMatch = PANEL.match(/export const BTN_PRIMARY =\s*\n?\s*"([^"]+)"/);
  assert.ok(btnPrimaryMatch, "BTN_PRIMARY must be found");
  assert.doesNotMatch(btnPrimaryMatch![1], /--success|--pill-success/, "BTN_PRIMARY must not use the success token");

  const primaryVariantMatch = BUTTON.match(/primary:\s*BTN_PRIMARY/);
  assert.ok(primaryVariantMatch, "Button's primary variant must be BTN_PRIMARY, not a second, possibly-green definition");
  assert.doesNotMatch(BUTTON, /attention:[\s\S]*?--success/, "the attention variant must not fall back to success green");
  assert.doesNotMatch(BUTTON, /danger:[\s\S]*?--success/, "the danger variant must not reference success green");
});

test("UI1-COLOR-03: Status's 'active' (selected/nav) tone uses brand accent, never success green", () => {
  const activeDot = STATUS.match(/active:\s*"([^"]+)"/);
  assert.ok(activeDot, "Status DOT map must define an 'active' tone");
  assert.match(activeDot![1], /--accent/, "'active' (selected/primary) must render in the brand accent");
  assert.doesNotMatch(activeDot![1], /--success/, "'active' must never render in the success colour");
});

// ── UI1-TOKEN-02 — dead Stage-1 layer removed, proven unused first ──────────────────────────────

test("UI1-TOKEN-02: the superseded Stage-1 accent/shadow/surface-selected tokens are gone, and nothing ever consumed them", () => {
  assert.doesNotMatch(CSS, /--shadow-sm:/, "--shadow-sm must be removed (0 consumers, proven before removal)");
  assert.doesNotMatch(CSS, /--shadow-md:/, "--shadow-md must be removed (0 consumers, proven before removal)");
  assert.doesNotMatch(CSS, /--surface-selected:/, "--surface-selected must be removed (0 consumers, proven before removal)");
  assert.doesNotMatch(CSS, /--radius-card:\s*var\(--radius-lg\)/, "the dead --radius-card -> --radius-lg Tailwind-theme alias must be gone");
  // Stripped of comments first: this file's own prose legitimately DOCUMENTS the removed value
  // (the same way it documents every other measured decision) — only a live declaration is a bug.
  const cssWithoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(cssWithoutComments, /#2563eb/, "the old Stage-1 link-blue accent value must not remain DECLARED anywhere");

  // The Cinematic accent (the value that was ALREADY winning the cascade) must still be exactly
  // what every consumer already relies on — removing the dead duplicate must not change this.
  assert.match(CSS, /--accent:\s*#5145F5;/i, "the live light-mode accent value must be unchanged");
  assert.match(CSS, /--accent:\s*#6366f1;/i, "the live dark-mode accent value must be unchanged");
});

test("UI1-TOKEN-02b: --radius-card/panel/modal are formalized as real values, not merely deleted", () => {
  assert.match(CSS, /--radius-card:\s*14px;/);
  assert.match(CSS, /--radius-panel:\s*16px;/);
  assert.match(CSS, /--radius-modal:\s*20px;/);
});

// ── UI1-MOTION-01/02 — shared motion tokens exist, reduced-motion untouched ─────────────────────

test("UI1-MOTION-01: the four shared motion-duration tokens exist in globals.css at the approved values", () => {
  assert.match(CSS, /--motion-fast:\s*120ms;/);
  assert.match(CSS, /--motion-normal:\s*200ms;/);
  assert.match(CSS, /--motion-emphasized:\s*320ms;/);
  assert.match(CSS, /--motion-stagger:\s*55ms;/);
});

test("UI1-MOTION-01b: the JS/Motion runtime constants match the CSS tokens exactly, and choreography.ts draws from them rather than a private copy", () => {
  assert.match(MOTION_TOKENS, /export const MOTION_FAST_MS = 120;/);
  assert.match(MOTION_TOKENS, /export const MOTION_NORMAL_MS = 200;/);
  assert.match(MOTION_TOKENS, /export const MOTION_STAGGER_MS = 55;/);
  assert.match(MOTION_TOKENS, /duration:\s*0\.32,\s*bounce:\s*0/, "the emphasized spring must stay critically damped, duration 0.32s (320ms)");

  assert.match(CHOREOGRAPHY, /import\s*{\s*MOTION_EMPHASIZED,\s*MOTION_STAGGER_MS\s*}\s*from\s*"@\/lib\/motion\/tokens"/, "choreography.ts must import the shared tokens rather than redeclaring them");
  assert.doesNotMatch(CHOREOGRAPHY, /type:\s*"spring",\s*duration:\s*0\.32/, "choreography.ts must no longer own a private copy of the spring config");
  assert.match(CHOREOGRAPHY, /staggerChildren:\s*MOTION_STAGGER_MS\s*\/\s*1000/, "the stagger must be derived from the shared constant, not a private 0.055 literal");
});

test("UI1-MOTION-02: the global prefers-reduced-motion override is unchanged", () => {
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(CSS, /animation-duration:\s*0\.01ms\s*!important;/);
  assert.match(CSS, /transition-duration:\s*0\.01ms\s*!important;/);
});

// ── UI1-A11Y-01/02 ───────────────────────────────────────────────────────────────────────────────

test("UI1-A11Y-01: --focus-ring is still declared and :focus-visible still reads it", () => {
  assert.match(CSS, /--focus-ring:\s*#5145F5;/);
  assert.match(CSS, /:focus-visible\s*{\s*outline:\s*2px solid var\(--focus-ring\)/);
});

test("UI1-A11Y-02: Status's 'attention' tone reads the new --attention token (not --warning), and status is never colour-alone", () => {
  const attentionDot = STATUS.match(/attention:\s*"([^"]+)"/);
  const attentionText = [...STATUS.matchAll(/attention:\s*"([^"]+)"/g)];
  assert.ok(attentionDot, "Status DOT map must define an 'attention' tone");
  assert.match(attentionDot![1], /--attention\b/, "'attention' must render via the distinct --attention token");
  assert.doesNotMatch(attentionDot![1], /--warning\b/, "'attention' must no longer be an alias for --warning");
  assert.equal(attentionText.length, 2, "both the dot (shape) and the text (word) maps must define 'attention'");

  // Status always renders a StatusDot AND the word together — colour is never the only signal.
  assert.match(STATUS, /<StatusDot tone={tone}/);
  assert.match(STATUS, /{children}/);
});

test("UI1-A11Y-02b: Pill gains an 'attention' tone distinct from 'warning', without removing 'warning'", () => {
  assert.match(PANEL, /"success" \| "warning" \| "attention" \| "info" \| "danger" \| "neutral"/);
  assert.match(PANEL, /attention:\s*"bg-\[var\(--attention-bg\)\] text-\[var\(--attention-fg\)\]"/);
  assert.match(PANEL, /warning:\s*"bg-\[var\(--pill-amber-bg\)\] text-\[var\(--pill-amber-fg\)\]"/, "the existing 'warning' tone must be untouched");
});

// ── UI1-THEME-01 — light AND dark values exist for every new brand/semantic role ────────────────

test("UI1-THEME-01: --secondary, --accent-pressed, --attention-border and --safety-stop-border each have a light value and an explicit dark override", () => {
  const { light, dark } = splitLightDark(CSS);
  for (const token of ["--secondary", "--accent-pressed", "--attention-border", "--safety-stop-border"]) {
    assert.match(light, new RegExp(`${token}:`), `${token} must have a light-mode (default) value`);
    assert.match(dark, new RegExp(`${token}:`), `${token} must have an explicit dark-mode override`);
  }
});

test("UI1-THEME-01b: --secondary clears 4.5:1 contrast on white, the canvas, and its own tint (measured, not guessed)", () => {
  // Mirrors this file's own established practice of measuring rather than asserting a colour by
  // eye — see globals.css's own inline rationale for --text-tertiary and the pill foregrounds.
  function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function luminance([r, g, b]: [number, number, number]): number {
    const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  function contrast(a: string, b: string): number {
    const [l1, l2] = [luminance(hexToRgb(a)), luminance(hexToRgb(b))].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  }
  const secondary = CSS.match(/--secondary:\s*(#[0-9a-fA-F]{6});/)![1];
  for (const bg of ["#FFFFFF", "#F4F4FA", "#E3F4F8"]) {
    assert.ok(contrast(secondary, bg) >= 4.5, `--secondary (${secondary}) must clear 4.5:1 against ${bg}, measured ${contrast(secondary, bg).toFixed(2)}:1`);
  }
});

// ── UI1-NAME-01 — Career-Ops naming, scoped to what this phase touched ──────────────────────────

test("UI1-NAME-01: the app's title metadata says Career-Ops, not JobHunt", () => {
  assert.match(LAYOUT, /title:\s*"Career-Ops"/);
  assert.doesNotMatch(LAYOUT, /"JobHunt"/);
});

test("UI1-NAME-01b: none of the files touched by this design-system consolidation introduce a new JobHunt reference", () => {
  for (const source of [CSS, STATUS, PANEL, BUTTON, CHOREOGRAPHY, MOTION_TOKENS, read("src/components/ui/EmptyState.tsx"), read("src/components/ui/Disclosure.tsx")]) {
    assert.doesNotMatch(source, /JobHunt/);
  }
});
