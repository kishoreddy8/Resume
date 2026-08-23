import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUnifiedWriterHandoff, type UnifiedWriterHandoffInput } from "../unifiedHandoff";

/**
 * CLAUDE WRITER SPEED PHASE (2026-08-23) — pure-function tests for buildUnifiedWriterHandoff. No DB,
 * no filesystem, no Claude — these test the splice logic in isolation against a synthetic prompt
 * shaped exactly like buildExternalWriterPrompt's real output (the three anchor headers, in the same
 * relative order). See externalHandoff.test.ts for end-to-end tests against the real exporter.
 */

function fakePrompt(opts: { includeRepairSection?: boolean } = {}): string {
  return `# External Resume Writer Agent Task — Iteration 1

**Writer mode: INITIAL_GENERATION.**

## Role & Context
Some role/context prose.

---

## THE CANONICAL STANDARD IS MANDATORY

Some canonical-standard framing prose.

## CANDIDATE CONTACT DETAILS — VERIFIED HARD FACTS, REPRODUCE EXACTLY
- Full name: Test Candidate

${opts.includeRepairSection ? "## TARGETED REPAIR — CHANGE ONLY WHAT IS LISTED HERE\n\nEditable paths: resume.tagline\n\n" : ""}## PROFESSIONAL IDENTITY — WHO THIS CANDIDATE IS
Some identity prose.

## CRITICAL TAILORING GUARDRAILS & OBJECTIVES

1. **Truthfulness**: some rule text.

---

## JD PRIORITY MATRIX — use this to decide POSITIONING
- [P2] Some Requirement (REQUIRED, candidate evidence: STRONG)

---

## OUTPUT REQUIREMENT: \`writer_output.json\`

Schema goes here.
`;
}

function baseInput(overrides: Partial<UnifiedWriterHandoffInput> = {}): UnifiedWriterHandoffInput {
  return {
    promptContent: fakePrompt(),
    instructionsFileContent: "# Resume Tailoring Instructions\n\nInstruction version: 2026-08-23\n\n---\n\nSOME CANONICAL RULE TEXT MARKER",
    masterReferenceFileContent: '{"experience":[{"employer":"Acme Corp"}]}',
    masterReferenceIsJson: true,
    jobRequirementsFileContent: '[{"label":"Python","criticality":"REQUIRED"}]',
    msiFileContent: "# Master Skills Inventory\nMSI TEXT MARKER",
    ...overrides,
  };
}

test("1. embeds CANONICAL TAILORING RULES content verbatim", () => {
  const doc = buildUnifiedWriterHandoff(baseInput());
  assert.match(doc, /SOME CANONICAL RULE TEXT MARKER/);
  assert.match(doc, /## CANONICAL TAILORING RULES/);
});

test("2. embeds MASTER RESUME FACTS content verbatim with a json fence when masterReferenceIsJson is true", () => {
  const doc = buildUnifiedWriterHandoff(baseInput());
  assert.match(doc, /```json\n\{"experience":\[\{"employer":"Acme Corp"\}\]\}\n```/);
  assert.match(doc, /## MASTER RESUME FACTS/);
});

test("3. embeds MASTER RESUME FACTS content with a text fence when masterReferenceIsJson is false", () => {
  const doc = buildUnifiedWriterHandoff(baseInput({ masterReferenceFileContent: "Plain text master resume.", masterReferenceIsJson: false }));
  assert.match(doc, /```text\nPlain text master resume\.\n```/);
  assert.doesNotMatch(doc, /```json\nPlain text master resume/);
});

test("4. embeds MASTER SKILLS INVENTORY content verbatim", () => {
  const doc = buildUnifiedWriterHandoff(baseInput());
  assert.match(doc, /MSI TEXT MARKER/);
  assert.match(doc, /## MASTER SKILLS INVENTORY/);
});

test("5. embeds JD REQUIREMENTS content verbatim", () => {
  const doc = buildUnifiedWriterHandoff(baseInput());
  assert.match(doc, /```json\n\[\{"label":"Python","criticality":"REQUIRED"\}\]\n```/);
  assert.match(doc, /## JD REQUIREMENTS/);
});

test("6. omits PREVIOUS RESUME CONTENT section when not provided (INITIAL_GENERATION case)", () => {
  const doc = buildUnifiedWriterHandoff(baseInput());
  assert.doesNotMatch(doc, /## PREVIOUS RESUME CONTENT/);
});

test("7. embeds PREVIOUS RESUME CONTENT verbatim when provided (repair case)", () => {
  const doc = buildUnifiedWriterHandoff(
    baseInput({ promptContent: fakePrompt({ includeRepairSection: true }), previousResumeFileContent: '{"tagline":"Old Tagline"}' })
  );
  assert.match(doc, /## PREVIOUS RESUME CONTENT/);
  assert.match(doc, /```json\n\{"tagline":"Old Tagline"\}\n```/);
});

test("8. omits PREVIOUS COVER LETTER CONTENT section when not provided", () => {
  const doc = buildUnifiedWriterHandoff(baseInput({ previousResumeFileContent: '{"tagline":"x"}' }));
  assert.doesNotMatch(doc, /## PREVIOUS COVER LETTER CONTENT/);
});

test("9. embeds PREVIOUS COVER LETTER CONTENT verbatim when provided", () => {
  const doc = buildUnifiedWriterHandoff(
    baseInput({ previousResumeFileContent: '{"tagline":"x"}', previousCoverLetterFileContent: '{"salutation":"Dear Hiring Team,"}' })
  );
  assert.match(doc, /## PREVIOUS COVER LETTER CONTENT/);
  assert.match(doc, /Dear Hiring Team,/);
});

test("10. the repair-plan section from the original prompt survives unmodified", () => {
  const doc = buildUnifiedWriterHandoff(baseInput({ promptContent: fakePrompt({ includeRepairSection: true }) }));
  assert.match(doc, /## TARGETED REPAIR — CHANGE ONLY WHAT IS LISTED HERE/);
  assert.match(doc, /Editable paths: resume\.tagline/);
});

test("11. every original section header from the prompt is still present, in the same relative order", () => {
  const original = fakePrompt();
  const doc = buildUnifiedWriterHandoff(baseInput());
  const headers = [
    "## Role & Context",
    "## THE CANONICAL STANDARD IS MANDATORY",
    "## CANDIDATE CONTACT DETAILS",
    "## PROFESSIONAL IDENTITY",
    "## CRITICAL TAILORING GUARDRAILS & OBJECTIVES",
    "## JD PRIORITY MATRIX",
    "## OUTPUT REQUIREMENT",
  ];
  for (const h of headers) {
    assert.ok(original.includes(h), `sanity: fixture must contain ${h}`);
    assert.ok(doc.includes(h), `${h} must survive in the unified handoff`);
  }
  const indices = headers.map((h) => doc.indexOf(h));
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i] > indices[i - 1], `${headers[i]} must appear after ${headers[i - 1]}`);
  }
});

test("12. output is deterministic — identical input produces byte-identical output", () => {
  const input = baseInput({ previousResumeFileContent: '{"a":1}', previousCoverLetterFileContent: '{"b":2}' });
  const a = buildUnifiedWriterHandoff(input);
  const b = buildUnifiedWriterHandoff(input);
  assert.equal(a, b);
});

test("13. throws (fails safely) when the CANDIDATE CONTACT DETAILS anchor is missing, rather than silently omitting canonical rules", () => {
  const broken = fakePrompt().replace("## CANDIDATE CONTACT DETAILS — VERIFIED HARD FACTS, REPRODUCE EXACTLY", "## SOMETHING ELSE");
  assert.throws(() => buildUnifiedWriterHandoff(baseInput({ promptContent: broken })), /expected anchor/);
});

test("14. throws when the CRITICAL TAILORING GUARDRAILS anchor is missing", () => {
  const broken = fakePrompt().replace("## CRITICAL TAILORING GUARDRAILS & OBJECTIVES", "## SOMETHING ELSE");
  assert.throws(() => buildUnifiedWriterHandoff(baseInput({ promptContent: broken })), /expected anchor/);
});

test("15. throws when the JD PRIORITY MATRIX anchor is missing", () => {
  const broken = fakePrompt().replace("## JD PRIORITY MATRIX — use this to decide POSITIONING", "## SOMETHING ELSE");
  assert.throws(() => buildUnifiedWriterHandoff(baseInput({ promptContent: broken })), /expected anchor/);
});

test("16. the embedded MASTER RESUME FACTS block appears before CRITICAL TAILORING GUARDRAILS, which references it", () => {
  const doc = buildUnifiedWriterHandoff(baseInput());
  const factsIdx = doc.indexOf("## MASTER RESUME FACTS");
  const guardrailsIdx = doc.indexOf("## CRITICAL TAILORING GUARDRAILS");
  assert.ok(factsIdx > -1 && guardrailsIdx > -1);
  assert.ok(factsIdx < guardrailsIdx);
});

test("17. the embedded JD REQUIREMENTS block appears immediately before JD PRIORITY MATRIX, which is built from it", () => {
  const doc = buildUnifiedWriterHandoff(baseInput());
  const reqIdx = doc.indexOf("## JD REQUIREMENTS");
  const matrixIdx = doc.indexOf("## JD PRIORITY MATRIX");
  assert.ok(reqIdx > -1 && matrixIdx > -1);
  assert.ok(reqIdx < matrixIdx);
});
