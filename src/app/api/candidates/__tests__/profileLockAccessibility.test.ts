import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const source = fs.readFileSync(path.resolve("src/components/ProfileLockPrompt.tsx"), "utf8");

test("profile lock contains focus and makes background siblings inert", () => {
  assert.match(source, /e\.key === "Tab"/);
  assert.match(source, /element\.inert = true/);
  assert.match(source, /previousFocusRef\.current\.focus\(\)/);
});

test("profile lock announces errors and does not let Escape dismiss protection", () => {
  assert.match(source, /role="alert"/);
  assert.match(source, /aria-live="assertive"/);
  assert.match(source, /e\.key === "Escape"/);
  assert.match(source, /e\.stopPropagation\(\)/);
});
