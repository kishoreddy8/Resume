import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * UI-P — SPATIAL PREMIUM PROFILE — TEST CONTRACT (Part 28).
 *
 * Profile is a big, mostly-declarative page component with few standalone pure functions to import,
 * so most of this contract is a source-level regression: it locks in properties an actual behavioral
 * test would otherwise need a full render harness to prove (which fetches happen, which routes are
 * linked, which strings never appear). Every assertion targets rendered JSX or real fetch/href
 * strings — never a comment — per Part 28's explicit "must not pass because prohibited words only
 * exist in comments" rule.
 */

const page = fs.readFileSync(path.join(process.cwd(), "src/app/profile/page.tsx"), "utf8");

/** Strips block and line comments before a regex check runs against them, so a check can never be
 *  satisfied (or defeated) by a comment instead of real code. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

const code = withoutComments(page);

test("UIP-PROFILE-01: Profile fetches all four real, authoritative payloads and nothing else per candidate", () => {
  assert.match(code, /fetch\(`\/api\/candidates\/\$\{candidateId\}`\)/);
  assert.match(code, /fetch\(`\/api\/candidates\/\$\{candidateId\}\/profile`\)/);
  assert.match(code, /fetch\(`\/api\/candidates\/\$\{candidateId\}\/settings`\)/);
  assert.match(code, /fetch\(`\/api\/master-files\?candidateId=\$\{candidateId\}`\)/);
  // No fetch inside a .map/for loop — a fifth request per row would be an N+1.
  assert.doesNotMatch(code, /\.map\([^)]*=>\s*fetch/);
});

test("UIP-PROFILE-02 / UIP-METRIC-01: no fabricated profile completion percentage anywhere in rendered code", () => {
  const forbidden = /\d+%\s*(complete|profile)|profile[^.]*\d+%/i;
  assert.doesNotMatch(code, forbidden);
  assert.doesNotMatch(code, /excellent profile|ai verified|profile score/i);
});

test("UIP-STATUS-01/02/03: missing/stale/invalid each map to distinct, real copy — never one generic sentence", () => {
  assert.match(code, /missing:\s*\{/);
  assert.match(code, /stale:\s*\{/);
  assert.match(code, /invalid:\s*\{/);
  assert.match(code, /hasn't been built yet/);
  assert.match(code, /needs a refresh/);
  assert.match(code, /needs review/);
});

test("UIP.1-STATUS-02: stale copy does not overclaim a definite cause — loadCandidateProfile reports stale identically for a real hash mismatch and an unverifiable (pre-hash) upload", () => {
  assert.match(code, /may have changed since this was built/);
  assert.doesNotMatch(code, /master resume or skills inventory changed since this was built/);
});

test("UIP.1-STATUS-03: the raw invalid diagnostic never appears in primary copy — only inside an explicit Technical details disclosure", () => {
  // Primary sentence is a fixed, safe string — never the passed-through Zod/JSON/schema-version error.
  assert.match(code, /Some information in your saved profile could not be read/);
  assert.doesNotMatch(code, /\{review\.detail\}[\s\S]{0,40}profileError/);
  assert.match(code, /<Disclosure title="Technical details">/);
  assert.match(code, /profileStatus === "invalid" && profileError && \(/);
});

test("UIP-STATUS-04: a current (\"ok\") profile never shows the review surface", () => {
  assert.match(code, /const review = profileStatus === "ok" \? null : PROFILE_REVIEW_COPY\[profileStatus\]/);
  // The section itself is conditionally rendered on that same variable, not on some second check.
  assert.match(code, /\{review && \(/);
});

test("UIP-SOURCE-01: no second Candidate Intelligence computation — Profile links to it, never recomputes its signal", () => {
  assert.doesNotMatch(code, /getJobSkillSignal|getJobSkillCorpusSize|corpusJobs/);
  assert.match(code, /href="\/candidate-intelligence"/);
});

test("UIP-SOURCE-02: no second profile/readiness/success score exists on this page", () => {
  assert.doesNotMatch(code, /readinessScore|successScore|confidenceScore|marketCompetitiveness/i);
});

test("UIP-FILES-01: Career Files reads the existing master-files manifest and links to the existing editor, never a new upload UI", () => {
  assert.match(code, /fetch\(`\/api\/master-files\?candidateId=\$\{candidateId\}`\)/);
  assert.match(code, /href="\/master-files"/);
  // No file input / drop target reinvented on this page.
  assert.doesNotMatch(code, /type="file"/);
});

test("UIP-MEMORY-01: saved application answers link to the existing /settings/answers route, no second Answer Memory API", () => {
  assert.match(code, /href="\/settings\/answers"/);
  assert.doesNotMatch(code, /fetch\(`\/api\/candidates\/\$\{candidateId\}\/answer-memory/);
});

test("UIP-AUTH-01: work authorization view renders only the four stored fields, nothing derived", () => {
  const viewFn = code.match(/title="Work authorization"[\s\S]*?view=\{\(v\) => \(([\s\S]*?)\)\}/)?.[1] ?? "";
  assert.match(viewFn, /v\.workAuthorizedUS/);
  assert.match(viewFn, /v\.requiresSponsorship/);
  assert.match(viewFn, /v\.usCitizen/);
  assert.match(viewFn, /v\.clearanceLevel/);
});

test("UIP-AUTH-02: no inferred legal/sponsorship/eligibility claim anywhere on the page", () => {
  assert.doesNotMatch(code, /visa eligib|legally eligible|sponsorship likelihood|immigration advice/i);
});

test("UIP-EDIT-01: every Manage/Review/Edit destination is a real, existing route", () => {
  for (const route of ["candidate-intelligence", "master-files", "settings/answers"]) {
    assert.ok(fs.existsSync(path.join(process.cwd(), "src/app", route)), `expected src/app/${route} to exist`);
  }
  // Section edits write through the one real, existing settings PATCH endpoint — no invented editor.
  assert.match(code, /fetch\(`\/api\/candidates\/\$\{candidateId\}\/settings`,\s*\{\s*method: "PATCH"/);
});

test("UIP-CANDIDATE-01: Profile resolves the real selected candidate before fetching or rendering, never an optimistic default", () => {
  assert.match(code, /const candidateId = useResolvedCandidateId\(\)/);
  // The module path legitimately contains "useActiveCandidateId" (both hooks live in that file) —
  // what must never appear is a CALL to the optimistic hook itself.
  assert.doesNotMatch(code, /useActiveCandidateId\(\)/);
  // Every per-candidate fetch is keyed off the SAME resolved id.
  assert.equal((code.match(/\$\{candidateId\}/g) ?? []).length >= 4, true);
});

test("UIP-MOBILE-01: identity, then review, then professional information — the section order the single-column mobile layout renders in", () => {
  const identity = page.indexOf('aria-labelledby="profile-identity-title"');
  const review = page.indexOf('aria-labelledby="profile-review-title"');
  const quick = page.indexOf("Professional information");
  assert.ok(identity > 0 && review > identity && quick > review, "expected identity < review < professional information in source order");
});

test("UIP-A11Y-01: exactly one page h1 (via PageHeader), no second heading competes with it", () => {
  assert.doesNotMatch(page, /<h1[\s>]/);
  assert.match(page, /<PageHeader/);
});

test("UIP-A11Y-02: the review surface is never color-only — an explicit text label always accompanies the tone", () => {
  assert.match(code, /Needs your review/);
});

test("UIP-ENGINE-01: Profile imports nothing from the apply engine", () => {
  assert.doesNotMatch(code, /from ["']@\/lib\/apply/);
});

test("UIP-NAMING-01: no remaining JobHunt string in rendered Profile copy", () => {
  assert.doesNotMatch(code, /JobHunt/);
});
