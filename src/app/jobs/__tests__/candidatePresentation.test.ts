import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { sourceLabel } from "../sourceLabel";

test("sourceLabel only presents stored source identifiers in candidate-readable form", () => {
  assert.equal(sourceLabel(null), null);
  assert.equal(sourceLabel("built_in"), null);
  assert.equal(sourceLabel("smart_recruiters"), "Smart Recruiters");
  assert.equal(sourceLabel("greenhouse"), "Greenhouse");
});

test("For You uses the candidate-facing role label and Settings destination", () => {
  const source = fs.readFileSync(path.resolve("src/app/jobs/ForYouList.tsx"), "utf8");
  assert.match(source, /ROLE_FAMILY_LABEL\.PRIMARY/);
  assert.match(source, /href="\/settings"/);
  assert.doesNotMatch(source, /`P · \$\{prefs\.primaryTargetRole\}`/);
});

test("Settings deduplicates role chips without changing the established removal transition", () => {
  const source = fs.readFileSync(path.resolve("src/app/settings/page.tsx"), "utf8");
  assert.match(source, /Array\.from\(new Set\(/, "displayed role chips should be deduplicated");
  assert.match(
    source,
    /const \[next, \.\.\.rest\] = prefs\.secondaryTargetRoles;/,
    "removing a primary role must retain the established promotion semantics"
  );
  assert.doesNotMatch(
    source,
    /const secondary = prefs\.secondaryTargetRoles\.filter/,
    "the UI must not normalize secondary roles before applying the established transition"
  );
});
