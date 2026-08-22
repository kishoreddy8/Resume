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
