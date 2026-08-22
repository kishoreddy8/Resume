import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

function read(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("responsive navigation keeps one tree and disables unavailable paging controls", () => {
  const sidebar = read("src/components/AppSidebar.tsx");
  assert.equal((sidebar.match(/<nav\b/g) ?? []).length, 1);
  assert.equal((sidebar.match(/<CandidateSelector\s*\/>/g) ?? []).length, 1);
  assert.match(sidebar, /disabled={!overflow\.left}/);
  assert.match(sidebar, /disabled={!overflow\.right}/);
  assert.match(sidebar, /lg:hidden/);
  assert.match(sidebar, /behavior: reduced \? "auto" : "smooth"/);
  assert.match(
    sidebar,
    /animate=\{\{ width: desktop \? \(open \? 264 : 48\) : "100%" \}\}/,
    "the desktop motion width must be explicitly cleared when the rail becomes mobile",
  );
});

test("candidate navigation follows the approved journey without changing the admin rail", () => {
  const sidebar = read("src/components/AppSidebar.tsx");
  const candidateOrder = [
    'href: "/home"',
    'href: "/jobs"',
    'href: "/resume"',
    'href: "/applications"',
    'href: "/profile"',
    'href: "/settings"',
  ].map((needle) => sidebar.indexOf(needle));
  assert.ok(candidateOrder.every((index) => index >= 0));
  assert.deepEqual(candidateOrder, [...candidateOrder].sort((a, b) => a - b));
  assert.match(sidebar, /const ADMIN_NAV/);
  assert.match(sidebar, /href: "\/admin\/scanner"/);
  assert.match(sidebar, /inAdmin \? "h-11 text-\[14px\] font-medium" : "h-12 text-\[15\.5px\]"/);
  assert.equal((sidebar.match(/size=\{20\}/g) ?? []).length, 6);
  assert.match(sidebar, /active[\s\S]*font-semibold text-\[var\(--accent\)\]/);
});

test("candidate account text remains readable while operational metadata stays quiet", () => {
  const selector = read("src/components/CandidateSelector.tsx");
  const adminLink = read("src/components/AdminRailLink.tsx");
  assert.match(selector, /h-\[54px\]/);
  assert.match(selector, /text-\[13\.5px\]/);
  assert.match(adminLink, /h-11/);
  assert.match(adminLink, /text-\[13px\] text-tertiary/);
});

test("candidate destinations share the wider desktop canvas and readable summary typography", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /--candidate-page-max: 1680px/);

  for (const file of [
    "src/app/jobs/page.tsx",
    "src/app/resume/page.tsx",
    "src/app/applications/page.tsx",
    "src/app/profile/page.tsx",
    "src/app/settings/page.tsx",
  ]) {
    assert.match(read(file), /max-w-\[var\(--candidate-page-max\)\]/, `${file} must use the shared canvas`);
  }

  const resume = read("src/app/resume/page.tsx");
  const applications = read("src/app/applications/page.tsx");
  const settings = read("src/app/settings/page.tsx");
  const profile = read("src/app/profile/page.tsx");
  assert.doesNotMatch(resume, /text-\[12px\][^\n]*\{detail\}/);
  assert.doesNotMatch(applications, /text-\[12px\][^\n]*\{hint\}/);
  assert.match(applications, /min-h-\[360px\]/);
  assert.match(settings, /lg:min-h-\[calc\(100dvh-var\(--workspace-chrome\)-8rem\)\]/);
  assert.match(settings, /\[&>\.candidate-panel\]:lg:flex-1/);
  assert.match(profile, /items-start gap-3 xl:grid-cols/);
});

test("profile selection and PIN surfaces scale for desktop while retaining touch targets", () => {
  const picker = read("src/app/page.tsx");
  const lockPrompt = read("src/components/ProfileLockPrompt.tsx");
  assert.match(picker, /max-w-6xl/);
  assert.match(picker, /min-h-24/);
  assert.match(picker, /max-w-lg/);
  assert.match(picker, /h-14 w-48/);
  assert.match(lockPrompt, /items-center justify-center/);
  assert.match(lockPrompt, /max-w-lg/);
  assert.match(lockPrompt, /h-14 w-48/);
  assert.match(lockPrompt, /min-h-11/);
});

test("WorkflowStepper paging is presentational and keeps one workspace instance", () => {
  const stepper = read("src/app/jobs/[id]/WorkflowStepper.tsx");
  const workspace = read("src/app/jobs/[id]/JobWorkspace.tsx");
  assert.equal((workspace.match(/<WorkflowStepper\b/g) ?? []).length, 1);
  assert.match(stepper, /disabled={!overflow\.left}/);
  assert.match(stepper, /disabled={!overflow\.right}/);
  assert.match(stepper, /prefers-reduced-motion: reduce/);
  assert.ok(stepper.includes("onClick={() => page(-1)}"));
  assert.ok(stepper.includes("onClick={() => page(1)}"));
  assert.ok(stepper.includes("onClick={() => navigable && onSelect(step.key)}"));
  assert.match(stepper, /h-11 w-11/);
  assert.match(stepper, /h-7 w-7/);
});

test("job bucket paging keeps compact arrows inside comfortable hit targets", () => {
  const strip = read("src/app/jobs/ScrollStrip.tsx");
  assert.match(strip, /h-11 w-11/);
  assert.match(strip, /h-7 w-7/);
});

test("Home overview links replace outline suppression with a visible focus ring", () => {
  const home = read("src/app/home/page.tsx");
  assert.match(home, /focus-visible:ring-2 focus-visible:ring-\[var\(--focus-ring\)\]/);
});

test("premium motion utilities and route focus respect reduced motion", () => {
  const css = read("src/app/globals.css");
  const workspace = read("src/app/jobs/[id]/JobWorkspace.tsx");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.premium-hover-lift:hover \{ transform: none; \}/);
  assert.match(css, /workspace-focus-target\[data-focused-from-route="true"\]/);
  assert.match(workspace, /behavior: reduced \? "auto" : "smooth"/);
  assert.doesNotMatch(workspace, /target\.click\(\)/);
  assert.doesNotMatch(workspace, /target\.submit\(\)/);
});
