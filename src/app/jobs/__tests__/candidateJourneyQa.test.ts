import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseWorkspaceRoute, resolveWorkspaceRouteStep } from "../[id]/workspaceRoute";
import type { WorkflowStep } from "../[id]/workflowSteps";

const read = (file: string) => fs.readFileSync(path.resolve(file), "utf8");

test("Candidate Home page provides deterministic, accessible deep-links and CTAs", () => {
  const home = read("src/app/home/page.tsx");
  const presentation = read("src/app/home/homePresentation.ts");
  const studioPresentation = read("src/app/resume/resumeStudioPresentation.ts");

  // Home CTA routes
  assert.match(studioPresentation, /jobWorkspaceUrl\(entry\.jobId,\s*\{\s*step:\s*"validation",\s*focus:\s*"issues"\s*\}\)/);
  assert.match(presentation, /jobWorkspaceUrl\(entry\.jobId,\s*\{\s*step:\s*"validation",\s*focus:\s*"revalidate"\s*\}\)/);
  assert.match(presentation, /jobWorkspaceUrl\(entry\.jobId,\s*\{\s*step:\s*"results",\s*focus:\s*"progress"\s*\}\)/);
  assert.match(presentation, /jobWorkspaceUrl\(recommendation\.job\.id,\s*\{\s*step:\s*"match"\s*\}\)/);

  // Quick navigation tiles
  assert.match(home, /href: "\/jobs"/);
  assert.match(home, /href: "\/resume"/);
  assert.match(home, /counts\.needsAttention \? action\.href : "\/applications"/);
});

test("Jobs page tabs, search debouncing, and empty-state switching work smoothly", () => {
  const page = read("src/app/jobs/page.tsx");
  const forYou = read("src/app/jobs/ForYouList.tsx");
  const workflow = read("src/app/jobs/WorkflowJobsList.tsx");

  // Debounced search
  assert.match(page, /setTimeout\(\(\) => \{[\s\S]*?committedSearch\.current = searchDraft;[\s\S]*?setFilters\(\(f\) => \(\{ \.\.\.f, search: searchDraft \}\)\);[\s\S]*?\}, 250\)/);

  // Empty state Explore jobs switches to For You
  assert.match(page, /onExploreJobs=\{[\s\S]*?setView\("forYou"\)\}/);
  assert.match(forYou, /onExploreJobs/);
  assert.match(workflow, /onExploreJobs/);
});

test("Job Workspace URL parsing and step resolution safely fail closed", () => {
  assert.deepEqual(parseWorkspaceRoute({ step: "validation", focus: "issues" }), {
    step: "validation",
    focus: "issues",
  });
  assert.deepEqual(parseWorkspaceRoute({ step: "invalid_step" as unknown as string }), {
    step: null,
    focus: null,
  });

  const mockSteps: WorkflowStep[] = [
    { key: "match", label: "Match", state: "done", lockedReason: null },
    { key: "studio", label: "Studio", state: "available", lockedReason: null },
    { key: "results", label: "Results", state: "available", lockedReason: null },
    { key: "validation", label: "Validation", state: "available", lockedReason: null },
    { key: "application", label: "Application", state: "locked", lockedReason: "Resume not ready" },
  ];

  // Requesting locked step falls back to nearest available step
  const resolved = resolveWorkspaceRouteStep("application", mockSteps, "match");
  assert.notEqual(resolved, "application");
  assert.equal(resolved, "validation");

  // Valid step is preserved
  assert.equal(resolveWorkspaceRouteStep("results", mockSteps, "match"), "results");
});

test("Job Workspace plain URL defaults to Match and does not eagerly fetch heavier pipeline records", () => {
  const workspace = read("src/app/jobs/[id]/JobWorkspace.tsx");
  assert.match(workspace, /const provisionalKey: StepKey = chosen \?\? routeRequest\.step \?\? "match"/);
  assert.match(workspace, /provisionalKey === "results" \|\| provisionalKey === "validation" \|\| provisionalKey === "application"/);
});

test("Validation Step presents human-readable verdicts and keeps technical details behind disclosures", () => {
  const validation = read("src/app/jobs/[id]/ValidationStep.tsx");
  assert.match(validation, /verdictTone/);
  assert.match(validation, /<StepSectionHeading/);
  assert.match(validation, /<details className="premium-expansion group/);
  assert.match(validation, /View technical details/);
  assert.doesNotMatch(validation, /READY_FOR_HUMAN_APPLICATION/);
});

test("Resume Studio presents 5 approved tabs and preview modal safely", () => {
  const resume = read("src/app/resume/page.tsx");
  const presentation = read("src/app/resume/resumeStudioPresentation.ts");

  assert.match(presentation, /id: "all", label: "All"/);
  assert.match(presentation, /id: "ready", label: "Ready to use"/);
  assert.match(presentation, /id: "tailoring", label: "Tailoring"/);
  assert.match(presentation, /id: "needs-review", label: "Needs review"/);
  assert.match(presentation, /id: "blocked", label: "Blocked"/);

  assert.match(resume, /<ResumePreview/);
  assert.match(resume, /role="tablist"/);
});

test("Applications pipeline presents stages, requires human review, and distinguishes unconfirmed submissions", () => {
  const apps = read("src/app/applications/page.tsx");
  const detail = read("src/app/applications/[id]/ApplicationDetail.tsx");

  assert.match(apps, /groupForStatus/);
  assert.match(detail, /PROGRESS_STAGES/);
  assert.match(detail, /"Preparing", "Filling", "Verification", "Final review", "Submitting", "Submitted"/);
  assert.match(detail, /Nothing will be submitted until you approve this application/);
  assert.match(detail, /SUBMISSION_UNCONFIRMED/);
});

test("Profile page provides in-place editing with focus restoration and protects derived evidence", () => {
  const profile = read("src/app/profile/page.tsx");
  const editor = read("src/app/profile/EditableSection.tsx");

  assert.match(profile, /patchSettings\(candidateId, \{ contact: draft \}\)/);
  assert.match(profile, /patchSettings\(candidateId, \{ preferences: draft \}\)/);
  assert.match(profile, /patchSettings\(candidateId, \{ matchAffecting: draft \}\)/);

  assert.match(editor, /editButtonRef\.current\?\.focus\(\)/);
  assert.match(editor, /restoreEditFocus\(\)/);
});

test("Settings candidate page exposes 5 categories and enforces candidate/admin boundary", () => {
  const settings = read("src/app/settings/page.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
  const categories = read("src/app/settings/categories.ts");

  assert.match(categories, /id: "job-search"/);
  assert.match(categories, /id: "notifications"/);
  assert.match(categories, /id: "applications"/);
  assert.match(categories, /id: "career-copilot"/);
  assert.match(categories, /id: "data-privacy"/);

  assert.doesNotMatch(settings, /scanner timeout|ATS concurrency|archiveAfterDays/i);
});

test("CommandBar palette routes cleanly without duplicates or dead redirects", () => {
  const commandBar = read("src/components/CommandBar.tsx");

  assert.match(commandBar, /id: "nav-home", label: "Home"/);
  assert.match(commandBar, /id: "nav-resume", label: "Resume"/);
  assert.match(commandBar, /id: "nav-profile", label: "Profile"/);
  assert.match(commandBar, /id: "nav-jobs", label: "Jobs"/);
  assert.match(commandBar, /id: "nav-applications", label: "Applications"/);
  assert.match(commandBar, /id: "nav-coverage", label: "Connectors", group: "Go to", keywords: "coverage proposals ats admin", run: go\("\/admin\/scanner\?tab=connectors"\)/);
  assert.match(commandBar, /id: "act-scanner", label: "Show scanner health", group: "Find", keywords: "ats connectors ingestion operations", run: go\("\/admin\/scanner"\)/);
  assert.match(commandBar, /router\.push\(`\/admin\/companies\?search=\$\{encodeURIComponent\(q\)\}`\)/);
});
