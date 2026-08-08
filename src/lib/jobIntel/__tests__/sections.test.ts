import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDescriptionSections } from "@/lib/parseSections";
import { toExtractedSections } from "../sections";

test("qualifications section relabels to Required Qualifications", () => {
  const html = "<h2>Requirements</h2><p>Must have 5 years of experience.</p>";
  const sections = parseDescriptionSections(html);
  const result = toExtractedSections(sections);
  assert.ok(result.requiredQualifications && /5 years/.test(result.requiredQualifications));
});

test("niceToHave section relabels to Preferred Qualifications", () => {
  const html = "<h2>Nice to Have</h2><p>Experience with Snowflake.</p>";
  const sections = parseDescriptionSections(html);
  const result = toExtractedSections(sections);
  assert.ok(result.preferredQualifications && /Snowflake/.test(result.preferredQualifications));
});

test("common heading variation: 'What You'll Need' maps to Required Qualifications", () => {
  const html = "<h2>What You'll Need</h2><p>Strong SQL skills.</p>";
  const sections = parseDescriptionSections(html);
  const result = toExtractedSections(sections);
  assert.ok(result.requiredQualifications);
});

test("common heading variation: 'What You'll Do' maps to Responsibilities", () => {
  const html = "<h2>What You'll Do</h2><p>Own the data platform.</p>";
  const sections = parseDescriptionSections(html);
  const result = toExtractedSections(sections);
  assert.ok(result.responsibilities);
});

test("null sections: everything null, nothing fabricated", () => {
  const result = toExtractedSections(null);
  assert.deepEqual(result, {
    responsibilities: null,
    requiredQualifications: null,
    preferredQualifications: null,
    benefits: null,
  });
});
