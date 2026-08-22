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

test("For You uses a candidate-facing role label without internal tier shorthand", () => {
  const source = fs.readFileSync(path.resolve("src/app/jobs/ForYouList.tsx"), "utf8");
  assert.match(source, />Primary role</);
  assert.doesNotMatch(source, /`P · \$\{prefs\.primaryTargetRole\}`/);
});

test("For You exposes and activates the selected option through the focused listbox", () => {
  const source = fs.readFileSync(path.resolve("src/app/jobs/ForYouList.tsx"), "utf8");
  assert.match(source, /aria-activedescendant=/);
  assert.match(source, /optionId={`candidate-job-\$\{job\.id\}`}/);
  assert.match(source, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(source, /openJob\(selectedJobId\)/);
});

test("Jobs exposes the approved five candidate views in order", () => {
  const source = fs.readFileSync(path.resolve("src/app/jobs/page.tsx"), "utf8");
  const labels = ["For You", "All Jobs", "Saved", "Tailoring", "Needs Review"];
  let cursor = -1;
  for (const label of labels) {
    const next = source.indexOf(`label: "${label}"`);
    assert.ok(next > cursor, `${label} should appear in the approved order`);
    cursor = next;
  }
  assert.match(source, /role="tablist"/);
  assert.match(source, /aria-selected=\{view === id\}/);
});

test("saved jobs use the existing candidate pin field with optimistic rollback", () => {
  const row = fs.readFileSync(path.resolve("src/app/jobs/JobRow.tsx"), "utf8");
  const button = fs.readFileSync(path.resolve("src/app/jobs/SaveJobButton.tsx"), "utf8");
  const feed = fs.readFileSync(path.resolve("src/app/jobs/ForYouList.tsx"), "utf8");
  const route = fs.readFileSync(path.resolve("src/app/api/candidates/[candidateId]/for-you/route.ts"), "utf8");
  assert.match(row, /initialSaved=\{job\.pinned === 1\}/);
  assert.match(button, /method: "PATCH"/);
  assert.match(button, /body: JSON\.stringify\(\{ candidateId, pinned: next \}\)/);
  assert.match(button, /setSaved\(previous\)/);
  assert.match(button, /event\.stopPropagation\(\)/);
  assert.match(button, /aria-label=\{saved \? "Remove saved job" : "Save job"\}/);
  assert.match(button, /className={`grid h-11 w-11/);
  assert.match(button, /useReducedMotion\(\)/);
  assert.equal(button.match(/fetch\(`/g)?.length, 1, "saving should be the button's only request");
  assert.match(button, /async function toggle\(\)[\s\S]*fetch\(`/);
  assert.match(feed, /params\.set\("savedOnly", "true"\)/);
  assert.match(route, /if \(savedOnly\) filtered = filtered\.filter\(\(item\) => item\.saved\)/);
});

test("workflow views consume the authoritative batched resume library contract", () => {
  const source = fs.readFileSync(path.resolve("src/app/jobs/WorkflowJobsList.tsx"), "utf8");
  assert.match(source, /\/resume-library`/);
  assert.match(source, /entry\.isLegacyMissingAnalysis && entry\.canRevalidate/);
  assert.match(source, /entry\.readiness === "BLOCKED"/);
  assert.match(source, /jobWorkspaceUrl/);
});

test("Settings summarizes persisted role facts and delegates editing to Profile", () => {
  const source = fs.readFileSync(path.resolve("src/app/settings/page.tsx"), "utf8");
  assert.match(source, /Array\.from\(new Set\(/, "displayed role chips should be deduplicated");
  assert.match(source, /href="\/profile"/);
  assert.match(source, /Your search uses Profile information/);
  assert.doesNotMatch(source, /function RoleEditor/);
  assert.doesNotMatch(source, /method: "PATCH"/);
});

test("candidate Jobs omits the operational scan action while admin retains it", () => {
  const candidateJobs = fs.readFileSync(path.resolve("src/app/jobs/page.tsx"), "utf8");
  const adminCompanies = fs.readFileSync(path.resolve("src/app/admin/companies/page.tsx"), "utf8");
  const adminNavigation = fs.readFileSync(path.resolve("src/components/AppSidebar.tsx"), "utf8");

  assert.doesNotMatch(candidateJobs, /Scan now/);
  assert.doesNotMatch(candidateJobs, /fetch\("\/api\/scan"/);
  assert.match(adminCompanies, /adminApiUrl\("\/api\/scan"/);
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
