import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDescriptionSections } from "@/lib/parseSections";
import { extractSkills } from "../skills";

function skillsFor(html: string, descriptionText?: string) {
  const sections = parseDescriptionSections(html);
  return extractSkills({ descriptionHtml: html, descriptionText: descriptionText ?? html.replace(/<[^>]+>/g, " "), sections });
}

const COMPLETE_JD = `
  <h2>Responsibilities</h2>
  <p>Build data pipelines and own our warehouse.</p>
  <h2>Required Qualifications</h2>
  <ul>
    <li>5+ years of experience with Python and SQL.</li>
    <li>Strong experience with AWS or Azure.</li>
    <li>Must have Docker experience.</li>
  </ul>
  <h2>Nice to Have</h2>
  <ul>
    <li>Experience with Snowflake is a plus.</li>
    <li>Familiarity with Terraform preferred.</li>
  </ul>
`;

test("complete JD: required skills come from the Required Qualifications section", () => {
  const skills = skillsFor(COMPLETE_JD);
  const python = skills.find((s) => s.skillName === "Python");
  const sql = skills.find((s) => s.skillName === "SQL");
  const docker = skills.find((s) => s.skillName === "Docker");
  assert.equal(python?.requirementLevel, "Required");
  assert.equal(sql?.requirementLevel, "Required");
  assert.equal(docker?.requirementLevel, "Required");
});

test("complete JD: preferred skills come from the Nice to Have section", () => {
  const skills = skillsFor(COMPLETE_JD);
  const snowflake = skills.find((s) => s.skillName === "Snowflake");
  const terraform = skills.find((s) => s.skillName === "Terraform");
  assert.equal(snowflake?.requirementLevel, "Preferred");
  assert.equal(terraform?.requirementLevel, "Preferred");
});

test('"AWS or Azure" is grouped as one alternative requirement, not two independent required skills', () => {
  const skills = skillsFor(COMPLETE_JD);
  const aws = skills.find((s) => s.skillName === "AWS");
  const azure = skills.find((s) => s.skillName === "Azure");
  assert.ok(aws && azure, "both AWS and Azure should be found");
  assert.equal(aws!.requirementLevel, "Required");
  assert.equal(azure!.requirementLevel, "Required");
  assert.ok(aws!.alternativeGroupId, "AWS should carry an alternative group id");
  assert.equal(aws!.alternativeGroupId, azure!.alternativeGroupId);
});

test("sparse JD: a bare skill mention with no cue word and no section is not classified as Required or Preferred", () => {
  const html = "<p>We use Python and Kubernetes here.</p>";
  const skills = skillsFor(html);
  assert.equal(skills.find((s) => s.skillName === "Python"), undefined);
  assert.equal(skills.find((s) => s.skillName === "Kubernetes"), undefined);
});

test("sparse JD: a cue word in plain text (no sections at all) still classifies correctly", () => {
  const html = "<p>Must have strong Python and SQL skills. Kubernetes experience is a plus.</p>";
  const skills = skillsFor(html);
  assert.equal(skills.find((s) => s.skillName === "Python")?.requirementLevel, "Required");
  assert.equal(skills.find((s) => s.skillName === "Kubernetes")?.requirementLevel, "Preferred");
});

test("malformed JD: unclosed tags and garbage markup do not crash extraction", () => {
  const html = "<div><p>Must have Python <b>SQL <i>experience<div>Docker required";
  assert.doesNotThrow(() => skillsFor(html));
  const skills = skillsFor(html);
  assert.ok(skills.length >= 0);
});

test("null/empty description: returns an empty array, never throws", () => {
  const skills = extractSkills({ descriptionHtml: null, descriptionText: null, sections: null });
  assert.deepEqual(skills, []);
});

test("evidence snippet is retained for every classified skill", () => {
  const skills = skillsFor(COMPLETE_JD);
  for (const skill of skills) {
    assert.ok(skill.evidenceSnippet, `${skill.skillName} should carry an evidence snippet`);
  }
});

test("category classification: skills are grouped into their taxonomy category", () => {
  const skills = skillsFor(COMPLETE_JD);
  assert.equal(skills.find((s) => s.skillName === "Python")?.category, "Programming Languages");
  assert.equal(skills.find((s) => s.skillName === "AWS")?.category, "Cloud Platforms");
  assert.equal(skills.find((s) => s.skillName === "Docker")?.category, "DevOps");
  assert.equal(skills.find((s) => s.skillName === "Snowflake")?.category, "Warehousing");
});
