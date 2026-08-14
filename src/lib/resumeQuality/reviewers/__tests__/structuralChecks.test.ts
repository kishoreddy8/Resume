import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResumeContent } from "../../../../../tools/tailoring-engine/types";
import { evaluateStructuralChecks } from "../structuralChecks";

function baseResume(overrides: Partial<ResumeContent> = {}): ResumeContent {
  return {
    name: "Test Candidate",
    tagline: "Data Engineer",
    location: "Remote",
    phone: "555-0100",
    email: "test@example.com",
    summary: ["A complete, well-formed professional summary."],
    skillGroups: [{ label: "Core", items: ["Azure"] }],
    experience: [{ title: "Data Engineer", company: "Acme", dates: "2020 - 2023", bullets: ["Built pipelines."] }],
    education: ["B.S. Computer Science"],
    ...overrides,
  };
}

test("27. required sections present -> perfect formattingScore, no blocking issues", () => {
  const result = evaluateStructuralChecks(baseResume());
  assert.equal(result.formattingScore, 100);
  assert.deepEqual(result.blockingIssues, []);
});

test("28. a missing section (empty Professional Experience) is flagged as a blocking issue", () => {
  const result = evaluateStructuralChecks(baseResume({ experience: [] }));
  assert.ok(result.blockingIssues.some((i) => i.includes("Experience")));
  assert.ok(result.formattingScore < 100);
});

test("28b. a missing Technical Skills section is flagged as a blocking issue", () => {
  const result = evaluateStructuralChecks(baseResume({ skillGroups: [] }));
  assert.ok(result.blockingIssues.some((i) => i.includes("Technical Skills")));
});

test("28c. an empty Professional Summary is flagged as a blocking issue", () => {
  const result = evaluateStructuralChecks(baseResume({ summary: [] }));
  assert.ok(result.blockingIssues.some((i) => i.includes("Summary")));
});

test("29. a malformed experience entry (role with zero bullets) is flagged", () => {
  const result = evaluateStructuralChecks(baseResume({ experience: [{ title: "Data Engineer", company: "Acme", dates: "2020", bullets: [] }] }));
  assert.ok(result.corrections.some((c) => c.description.includes("no bullets")));
});

test("29b. an experience entry missing company/title is flagged", () => {
  const result = evaluateStructuralChecks(baseResume({ experience: [{ title: "", company: "", dates: "2020", bullets: ["x"] }] }));
  assert.ok(result.corrections.some((c) => c.description.includes("missing a company or title")));
});

test("duplicate Technical Skills headings are flagged", () => {
  const result = evaluateStructuralChecks(
    baseResume({ skillGroups: [{ label: "Cloud", items: ["Azure"] }, { label: "Cloud", items: ["AWS"] }] })
  );
  assert.ok(result.corrections.some((c) => c.description.includes("Duplicate")));
});

test("formattingScore stays within 0-100 bounds even with every section broken", () => {
  const result = evaluateStructuralChecks({ ...baseResume(), summary: [], skillGroups: [], experience: [], education: [] });
  assert.ok(result.formattingScore >= 0 && result.formattingScore <= 100);
});
