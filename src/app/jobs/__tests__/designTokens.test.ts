import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * UI-0 DEFECT 6 — missing/mismatched design tokens.
 *
 * ROOT CAUSE: not two missing tokens needing new colour decisions, but THREE naming-drift bugs —
 * three components referenced a `var(--x)` that was never declared anywhere in globals.css, so the
 * browser silently resolved it to nothing (transparent background / no shadow), each time when an
 * already-measured, already-contrast-verified equivalent token already existed under its real name:
 *
 *   --tile-orange-bg/-fg  (resume/page.tsx "amber" tone, applications/page.tsx "needs-action" tile)
 *     → the local tone KEY is literally named "amber"; the intended reference was always the
 *       existing, contrast-verified --tile-amber-bg/-fg pair, not a second "orange" identity.
 *   --surface-subtle      (home/page.tsx empty state)
 *     → the same "quiet secondary background" role --surface-muted already fills, used identically
 *       elsewhere (resume/page.tsx, applications/page.tsx).
 *   --shadow-lift-1       (home/page.tsx tile hover)
 *     → a plain typo for the real --lift-1 elevation token.
 *
 * TOKEN COMPLETION, NOT PALETTE REDESIGN: this repoints three broken references at tokens that
 * already exist, are already defined for both light and dark, and were already contrast-verified
 * when they were first approved (see globals.css's own inline rationale for --tile-amber-*). No new
 * colour value is introduced anywhere in this fix.
 */

function read(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

const CSS = read("src/app/globals.css");

test("Y/Z: the three previously-undefined tokens are gone from every component — no lingering reference", () => {
  for (const file of ["src/app/resume/page.tsx", "src/app/applications/page.tsx", "src/app/home/page.tsx"]) {
    const source = read(file);
    assert.doesNotMatch(source, /--tile-orange-(bg|fg)/, `${file} must not reference the undefined --tile-orange-* tokens`);
    assert.doesNotMatch(source, /--surface-subtle/, `${file} must not reference the undefined --surface-subtle token`);
    assert.doesNotMatch(source, /--shadow-lift-1/, `${file} must not reference the mistyped --shadow-lift-1 token`);
  }
});

test("resume and applications tiles now reference the real, existing amber tile tokens", () => {
  const resume = read("src/app/resume/page.tsx");
  const applications = read("src/app/applications/page.tsx");
  assert.match(resume, /bg-\[var\(--tile-amber-bg\)\] text-\[var\(--tile-amber-fg\)\]/);
  assert.match(applications, /bg-\[var\(--tile-amber-bg\)\] text-\[var\(--tile-amber-fg\)\]/);
});

test("home's empty state and tile hover now reference real, existing tokens", () => {
  const home = read("src/app/home/page.tsx");
  assert.match(home, /bg-\[var\(--surface-muted\)\]/);
  assert.match(home, /hover:shadow-\[var\(--lift-1\)\]/);
});

/**
 * Extracts the character ranges of every top-level `@media (prefers-color-scheme: dark) { ... }`
 * block by brace-counting (the file has multiple such blocks — one per themed section — and plain
 * regex cannot reliably match balanced, possibly-nested braces).
 */
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

test("AA: every token this fix repoints to has a real value outside dark-mode media queries (light default) AND an explicit dark override", () => {
  const darkRanges = darkMediaRanges(CSS);
  assert.ok(darkRanges.length > 0, "at least one dark-mode media block must exist");

  let lightOnly = CSS;
  for (const [start, end] of darkRanges.slice().reverse()) {
    lightOnly = lightOnly.slice(0, start) + lightOnly.slice(end);
  }
  const darkOnly = darkRanges.map(([start, end]) => CSS.slice(start, end)).join("\n");

  for (const token of ["--tile-amber-bg", "--tile-amber-fg", "--surface-muted", "--lift-1"]) {
    assert.match(lightOnly, new RegExp(`${token}:`), `${token} must have a light-mode (default) value`);
    /* --lift-1 and --surface-muted are explicitly overridden for dark; --tile-amber-* also has an
     * explicit, separately-tuned dark variant (globals.css documents why: a light-mode pill colour
     * would be "a lamp on this surface" against graphite). */
    assert.match(darkOnly, new RegExp(`${token}:`), `${token} must have an explicit dark-mode override`);
  }
});

test("token-lint: every var(--x) referenced anywhere under src/app is declared somewhere in globals.css", () => {
  /* The general-purpose regression this defect's root cause calls for — the audit's own
   * recommendation. Prevents an entire class of silent invisible-element bugs from recurring. */
  const definedTokens = new Set(
    [...CSS.matchAll(/(?:^|[\s{;])(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]!)
  );

  const usedTokens = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.isFile() && /\.(tsx|ts)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        for (const m of text.matchAll(/var\((--[a-z0-9-]+)\)/gi)) usedTokens.add(m[1]!);
      }
    }
  };
  walk(path.resolve("src/app"));
  walk(path.resolve("src/components"));

  /* Font variables are supplied by next/font at runtime, not declared as static custom properties
   * in globals.css — the one legitimate class of exception to "every var(--x) must be declared
   * here", and confirmed present in the @theme inline block that maps them through. */
  const runtimeSupplied = new Set(["--font-geist-sans", "--font-geist-mono"]);

  const undefinedTokens = [...usedTokens].filter((t) => !definedTokens.has(t) && !runtimeSupplied.has(t));
  assert.deepEqual(undefinedTokens, [], `these tokens are referenced but never defined: ${undefinedTokens.join(", ")}`);
});
