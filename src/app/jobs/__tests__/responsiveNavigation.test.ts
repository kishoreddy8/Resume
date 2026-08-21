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
