import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("the workspace hero presents job identity, persisted save, status, and one next action", () => {
  const header = read("src/app/jobs/[id]/JobIdentityHeader.tsx");
  const workspace = read("src/app/jobs/[id]/JobWorkspace.tsx");
  assert.match(header, /md:text-\[28px\]/);
  assert.match(header, /<SaveJobButton/);
  assert.match(header, /initialSaved=\{job\.pinned === 1\}/);
  assert.match(header, /View original/);
  assert.match(header, /status\.label/);
  assert.equal((header.match(/\{primary &&/g) ?? []).length, 1);
  assert.match(header, /href=\{primary\.href\}/);
  assert.match(header, /scroll=\{false\}/);
  assert.match(workspace, /workspaceHeroPresentation\(/);
  assert.match(workspace, /jobWorkspaceUrl\(jobId/);
  assert.doesNotMatch(workspace, /primary[\s\S]{0,400}(fetch|\.click\(|\.submit\()/);
});

test("the five-step navigator is larger, scrollable, and state-readable without raw enums", () => {
  const stepper = read("src/app/jobs/[id]/WorkflowStepper.tsx");
  const model = read("src/app/jobs/[id]/workflowSteps.ts");
  for (const label of ["Match", "Resume Studio", "Tailoring Results", "Validation", "Application"]) {
    assert.match(model, new RegExp(`label: "${label}"`));
  }
  assert.match(stepper, /overflow-x-auto/);
  assert.match(stepper, /h-\[72px\]/);
  assert.match(stepper, /text-\[14px\]/);
  assert.match(stepper, /STATE_WORD\[step\.state\]/);
  assert.match(stepper, /bg-\[var\(--accent-tint\)\]/);
});

test("validation leads with the verdict and limits visible issues before technical disclosure", () => {
  const source = read("src/app/jobs/[id]/ValidationStep.tsx");
  assert.match(source, />Validation result</);
  assert.match(source, /issues\.slice\(0, 5\)/);
  assert.match(source, /View technical details/);
  assert.match(source, /<details/);
  assert.match(source, /dims\.map/);
  assert.match(source, /issues\.map/);
  assert.match(source, /data-workspace-focus="issues"/);
  assert.match(source, /tabIndex=\{-1\}/);
});

test("canonical refusal or missing readiness hides StartApplication behind a review state", () => {
  const application = read("src/app/jobs/[id]/ApplicationReadyStep.tsx");
  const workspace = read("src/app/jobs/[id]/JobWorkspace.tsx");
  const guard = application.indexOf("!quality?.readiness || quality.readiness.humanMaySend === false");
  const unavailable = application.indexOf("Application unavailable");
  const normalScreen = application.indexOf("Application overview");
  assert.ok(guard >= 0 && unavailable > guard && normalScreen > unavailable);
  assert.match(application, /Review issues/);
  assert.match(application, /Application readiness required/);
  assert.match(workspace, /quality\.state === "loading"/);
  assert.match(workspace, /onReviewIssues=/);
  assert.match(application, /href=\{reviewIssuesHref\}/);
  assert.match(workspace, /focus: "issues"/);
});

test("pipeline internals stay behind explicit disclosures", () => {
  const workspace = read("src/app/jobs/[id]/JobWorkspace.tsx");
  assert.match(workspace, /Resume actions and pipeline details/);
  assert.match(workspace, /Open the full resume pipeline/);
  assert.ok((workspace.match(/<LazyDetails/g) ?? []).length >= 2);
  assert.match(workspace, /open \? children : null/);
});

test("query changes remount the workspace and focus waits for the rendered target without writes", () => {
  const page = read("src/app/jobs/[id]/page.tsx");
  const workspace = read("src/app/jobs/[id]/JobWorkspace.tsx");
  assert.match(page, /key=\{`\$\{id\}:\$\{routeRequest\.step/);
  assert.match(workspace, /locateAfterRender/);
  assert.match(workspace, /attempts < 30/);
  assert.match(workspace, /requestAnimationFrame\(locateAfterRender\)/);
  assert.match(workspace, /reduced \? "auto" : "smooth"/);
  const focusEffect = workspace.slice(
    workspace.indexOf("const requestKey"),
    workspace.indexOf("The newest run")
  );
  assert.doesNotMatch(focusEffect, /fetch\(|method:\s*["'](?:POST|PATCH|PUT|DELETE)/);
});

test("a plain job click lands on Match and does not prefetch a later workflow step", () => {
  const workspace = read("src/app/jobs/[id]/JobWorkspace.tsx");
  assert.match(workspace, /chosen \?\? routeRequest\.step \?\? "match"/);
  assert.match(workspace, /routeRequest\.step \? defaultStep\(workflowInput\) : "match"/);
});
