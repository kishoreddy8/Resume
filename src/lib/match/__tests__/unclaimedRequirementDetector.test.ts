import assert from "node:assert/strict";
import { test } from "node:test";
import { detectUnclaimedRequirements } from "../unclaimedRequirementDetector";

test("a line containing a known taxonomy skill is excluded (already claimed by job_skills)", () => {
  const units = detectUnclaimedRequirements({
    jobTitle: "Data Engineer",
    requiredQualificationsText: "Strong experience with Python and distributed systems design",
    preferredQualificationsText: null,
    alreadyClaimedEvidence: [],
  });
  assert.equal(units.length, 0, "a line matched by the same taxonomy alias set job_skills uses must never also become UNRESOLVED");
});

test("a line overlapping an already-claimed certification evidence snippet is excluded", () => {
  const line = "Must hold a valid PMP certification prior to starting";
  const units = detectUnclaimedRequirements({
    jobTitle: "Program Manager",
    requiredQualificationsText: line,
    preferredQualificationsText: null,
    alreadyClaimedEvidence: [line],
  });
  assert.equal(units.length, 0);
});

test("a genuinely novel required line with no taxonomy coverage becomes an UNRESOLVED-shaped unit", () => {
  const units = detectUnclaimedRequirements({
    jobTitle: "Data Engineer",
    requiredQualificationsText: "Experience with modern data mesh architecture practices across teams",
    preferredQualificationsText: null,
    alreadyClaimedEvidence: [],
  });
  assert.equal(units.length, 1);
  assert.equal(units[0].fromUnclaimedText, true);
  assert.equal(units[0].requirementLevel, "Required");
});

test("boilerplate/EEO lines are excluded even when they're in the required-qualifications section", () => {
  const units = detectUnclaimedRequirements({
    jobTitle: "Data Engineer",
    requiredQualificationsText: [
      "We are an Equal Opportunity Employer and value diversity",
      "Competitive salary and comprehensive health insurance",
    ].join("\n"),
    preferredQualificationsText: null,
    alreadyClaimedEvidence: [],
  });
  assert.equal(units.length, 0);
});

test("very short lines (e.g. section headers) are excluded", () => {
  const units = detectUnclaimedRequirements({
    jobTitle: "Data Engineer",
    requiredQualificationsText: "Requirements:",
    preferredQualificationsText: null,
    alreadyClaimedEvidence: [],
  });
  assert.equal(units.length, 0);
});

test("more than the cap of unclaimed lines collapses overflow into one summary unit, counted once", () => {
  const lines = Array.from({ length: 9 }, (_, i) => `Genuinely novel requirement phrase number ${i} not in any taxonomy`);
  const units = detectUnclaimedRequirements({
    jobTitle: "Data Engineer",
    requiredQualificationsText: lines.join("\n"),
    preferredQualificationsText: null,
    alreadyClaimedEvidence: [],
  });
  // 5 individual + 1 summary unit for the remaining 4
  assert.equal(units.length, 6);
  assert.ok(units[5].label.includes("4 additional"));
});

test("required and preferred sections are classified by section membership, not guessed", () => {
  const units = detectUnclaimedRequirements({
    jobTitle: "Data Engineer",
    requiredQualificationsText: "Experience with modern data mesh architecture practices",
    preferredQualificationsText: "Familiarity with emerging data contract governance frameworks",
    alreadyClaimedEvidence: [],
  });
  assert.equal(units.length, 2);
  assert.equal(units.find((u) => u.label.includes("data mesh"))?.requirementLevel, "Required");
  assert.equal(units.find((u) => u.label.includes("data contract"))?.requirementLevel, "Preferred");
});
