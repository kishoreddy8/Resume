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

test("For You exposes and activates the selected option through the focused listbox", () => {
  const source = fs.readFileSync(path.resolve("src/app/jobs/ForYouList.tsx"), "utf8");
  assert.match(source, /aria-activedescendant=/);
  assert.match(source, /optionId={`recommended-job-\$\{job\.id\}`}/);
  assert.match(source, /e\.key === "Enter" \|\| e\.key === " "/);
  assert.match(source, /openJob\(selectedJobId\)/);
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

test("candidate Jobs omits the operational scan action while admin retains it", () => {
  const candidateJobs = fs.readFileSync(path.resolve("src/app/jobs/page.tsx"), "utf8");
  const adminCompanies = fs.readFileSync(path.resolve("src/app/admin/companies/page.tsx"), "utf8");
  const adminNavigation = fs.readFileSync(path.resolve("src/components/AppSidebar.tsx"), "utf8");

  assert.doesNotMatch(candidateJobs, /Scan now/);
  assert.doesNotMatch(candidateJobs, /fetch\("\/api\/scan"/);
  assert.match(adminCompanies, /fetch\("\/api\/scan"/);
  assert.match(adminCompanies, />\s*Scan\s*</);
  assert.match(adminNavigation, /href: "\/admin\/companies", label: "Companies"/);
});

test("candidate Settings omits writer operations while admin Settings remains authoritative", () => {
  const candidateSettings = fs.readFileSync(path.resolve("src/app/settings/page.tsx"), "utf8");
  const adminSettings = fs.readFileSync(path.resolve("src/app/admin/settings/page.tsx"), "utf8");

  assert.doesNotMatch(candidateSettings, /Resume writer/);
  assert.doesNotMatch(candidateSettings, /writerEnabled/);
  assert.doesNotMatch(candidateSettings, /scheduler:\s*\{\s*writerEnabled/);
  assert.match(adminSettings, /function ResumeWriterControl/);
  assert.match(adminSettings, /scheduler:\s*\{\s*writerEnabled: next\s*\}/);
  assert.match(adminSettings, /<ResumeWriterControl/);
});

test("candidate privacy and approval copy state the supported trust boundary", () => {
  const settings = fs.readFileSync(path.resolve("src/app/settings/page.tsx"), "utf8");

  assert.doesNotMatch(settings, /Everything stays on this machine/);
  assert.doesNotMatch(settings, /nothing is uploaded/);
  assert.match(settings, /Your JobHunt data is stored locally on this Mac\./);
  assert.match(settings, /Some AI-assisted features may send the content needed for a task/);
  assert.match(settings, /Always required before submission/);
  assert.match(settings, /there is no setting that\s+changes that\./);
  assert.doesNotMatch(settings, /label="Final approval"[\s\S]{0,500}<input/);
});
