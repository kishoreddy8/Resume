import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDescriptionSections, isLabelCased, isListIntroducer, closesSection } from "../parseSections";
import { extractSkills } from "../jobIntel/skills";
import { detectUnclaimedRequirements } from "../match/unclaimedRequirementDetector";

/**
 * Stage 25B — Blocker 1. Context-aware section termination.
 *
 * The reproduction case is job 33046 in the real database (ServiceNow/Moveworks "Staff Software
 * Engineer - Data Platform - Kubernetes"): an explicit "Qualifications" heading followed by the
 * sub-heading "To be successful in this role you have:", which used to reset the section to null
 * and discard every requirement under it. The fixture below is that posting's real structure.
 *
 * These tests pin BOTH directions at once, which is the whole difficulty of this defect:
 *   - genuine requirements after a sub-heading or a heading-shaped bullet must be CAPTURED;
 *   - About / EEO / benefits / compensation / drug-testing / agency prose must NOT become
 *     requirements.
 */

const JOB_33046 = `
<p>Company Description</p>
<p>It all started when engineer Fred Luddy wrote code that automated a tedious task.</p>
<p>Qualifications</p>
<p>To be successful in this role you have:</p>
<ul>
  <li>8+ years of software development experience with a Bachelor's degree.</li>
  <li>5+ years of hands-on experience building, deploying and operating workloads on Kubernetes.</li>
  <li>Working experience with at least one major hyperscaler (AWS, Azure, or GCP).</li>
  <li>Strong programming skills in Go, or another systems language.</li>
</ul>
<p>Additional Information</p>
<p>Equal Opportunity Employer</p>
<p>ServiceNow is an equal opportunity employer. All qualified applicants will receive consideration.</p>
`;

test("Blocker 1: a sub-heading no longer discards the requirements beneath it (job 33046)", () => {
  const sections = parseDescriptionSections(JOB_33046);
  assert.ok(sections, "the posting must produce sections at all — it produced none before the fix");
  const qualifications = sections!.qualifications ?? "";
  assert.ok(qualifications.includes("Kubernetes"), "Kubernetes requirement must be captured");
  assert.ok(qualifications.includes("AWS, Azure, or GCP"), "the AWS/Azure/GCP OR-list must be captured");
  assert.ok(qualifications.includes("Go"), "Go requirement must be captured");
  assert.ok(qualifications.includes("Bachelor's degree"), "the degree requirement must be captured");
});

test("Blocker 1: the same posting's EEO/legal trailer never becomes requirement text", () => {
  const sections = parseDescriptionSections(JOB_33046);
  const qualifications = sections!.qualifications ?? "";
  assert.ok(!qualifications.includes("equal opportunity employer"), "EEO prose must not leak");
  assert.ok(!qualifications.includes("Fred Luddy"), "company prose must not leak");
});

test("Blocker 1: the captured requirements produce real skill units at the right level", () => {
  const sections = parseDescriptionSections(JOB_33046);
  const skills = extractSkills({ descriptionText: null, descriptionHtml: JOB_33046, sections });
  const names = skills.map((s) => s.skillName.toLowerCase());
  assert.ok(names.includes("kubernetes"), `expected Kubernetes, got: ${names.join(", ")}`);
  for (const skill of skills) {
    assert.equal(skill.requirementLevel, "Required", `${skill.skillName} came from the Qualifications section`);
  }
  // "AWS, Azure, or GCP" must stay ONE alternative group, not three independent Required skills.
  const cloud = skills.filter((s) => ["aws", "azure", "gcp"].includes(s.skillName.toLowerCase()));
  assert.equal(cloud.length, 3, "all three cloud alternatives should be present");
  const groups = new Set(cloud.map((s) => s.alternativeGroupId));
  assert.equal(groups.size, 1, "they must share one alternative group");
  assert.notEqual([...groups][0], null, "and that group must not be null");
});

// --- heading-shaped requirement BULLETS ---------------------------------------------------------

test("Blocker 1: heading-shaped requirement bullets do not terminate the section", () => {
  // Real shapes measured on the corpus following a Qualifications heading: "Bachelor's degree" (98),
  // "High school diploma or GED" (61), "Travel required" (52), "Doctorate degree" (30).
  const html = `
    <p>Required Qualifications</p>
    <ul>
      <li>Bachelor's degree</li>
      <li>High school diploma or GED</li>
      <li>Travel required</li>
      <li>Five years of hands-on experience administering PostgreSQL in production.</li>
    </ul>`;
  const sections = parseDescriptionSections(html);
  const qualifications = sections!.qualifications ?? "";
  for (const bullet of ["Bachelor's degree", "High school diploma or GED", "Travel required", "PostgreSQL"]) {
    assert.ok(qualifications.includes(bullet), `${bullet} must survive`);
  }
});

// --- the no-bleed guarantee (the variant Stage 25B measured and rejected) -----------------------

test("Blocker 1: recognized non-requirement section labels still close the section", () => {
  const closers = [
    "About Boise Cascade",
    "Additional Information",
    "Equal Opportunity Employer",
    "Work Personas",
    "Accommodations",
    "Export Control Regulations",
    "Compensation",
    "Salary Range",
    "Physical Demands",
    "Background Check",
    "How To Apply",
    "Our Core Values",
    "Recruitment Fraud",
  ];
  for (const label of closers) {
    assert.equal(closesSection(label), true, `${label} must close an open section`);
    const sections = parseDescriptionSections(
      `<p>Required Qualifications</p><ul><li>Five years of Python engineering experience.</li></ul>` +
        `<p>${label}</p><p>This trailing paragraph is boilerplate and must not become a requirement.</p>`
    );
    const qualifications = sections!.qualifications ?? "";
    assert.ok(qualifications.includes("Python"), `${label}: the real requirement must survive`);
    assert.ok(!qualifications.includes("trailing paragraph"), `${label}: boilerplate must not bleed in`);
  }
});

test("Blocker 1: benefits / compensation / drug-testing prose does not become requirements", () => {
  const html = `
    <p>Qualifications</p>
    <ul><li>Three years of experience building data pipelines with Airflow.</li></ul>
    <p>Compensation</p>
    <p>The base salary range for this role is USD $131,000 per year - USD $145,000 per year.</p>
    <p>Benefits</p>
    <p>401(k) with Company Match, Dental Insurance, Flexible Time Off.</p>
    <p>Background Check</p>
    <p>Must pass a pre-employment drug screen and criminal history background check.</p>`;
  const sections = parseDescriptionSections(html);
  const qualifications = sections!.qualifications ?? "";
  assert.ok(qualifications.includes("Airflow"));
  assert.ok(!qualifications.includes("131,000"), "compensation must not leak into requirements");
  assert.ok(!qualifications.includes("401(k)"), "benefits must not leak into requirements");
  assert.ok(!qualifications.includes("drug screen"), "screening prose must not leak into requirements");
});

test("Blocker 1: leaked boilerplate is still filtered before it can become a requirement unit", () => {
  // Defence in depth — even if a section boundary cannot be resolved, these lines must never be
  // promoted into UNRESOLVED requirement units by the unclaimed-requirement detector.
  const units = detectUnclaimedRequirements({
    jobTitle: "Data Engineer",
    requiredQualificationsText: [
      "The base salary range for this role is USD $131,000 per year - USD $145,000 per year.",
      "Competitive base salary and meaningful equity award for every team member.",
      "Dental Insurance and Flexible Spending Accounts are provided.",
      "All qualified applicants will receive consideration without regard to race, color or religion.",
      "Positions posted are not open to third party recruiters / agencies.",
      "The application deadline for this role is the same as the posting end date.",
      "Five years of hands-on experience designing dimensional data models.",
    ].join("\n"),
    preferredQualificationsText: null,
    alreadyClaimedEvidence: [],
  });
  const labels = units.map((u) => u.label.toLowerCase());
  assert.ok(
    labels.some((l) => l.includes("dimensional data models")),
    "the one genuine requirement must still be detected"
  );
  for (const banned of ["salary range", "equity award", "dental insurance", "without regard to race", "third party recruiters", "application deadline"]) {
    assert.ok(!labels.some((l) => l.includes(banned)), `"${banned}" must never become a requirement unit`);
  }
});

// --- the discriminators themselves ---------------------------------------------------------------

test("Blocker 1: isLabelCased separates section labels from requirement bullets", () => {
  for (const label of ["Work Personas", "Additional Information", "ADDITIONAL INFORMATION", "Our Core Values", "Preferred Qualifications"]) {
    assert.equal(isLabelCased(label), true, label);
  }
  for (const bullet of ["Bachelor's degree", "High school diploma or GED", "Travel required", "Experience supporting Dell PowerEdge servers"]) {
    assert.equal(isLabelCased(bullet), false, bullet);
  }
});

test("Blocker 1: isListIntroducer recognizes second-person list introducers", () => {
  for (const intro of [
    "To be successful in this role you have:",
    "It also helps if you have:",
    "You should have:",
    "What You've Done:",
    "You Might Be a Great Fit If:",
    "Your background",
  ]) {
    assert.equal(isListIntroducer(intro), true, intro);
    assert.equal(closesSection(intro), false, `${intro} must not close a section`);
  }
  // "About You" is an About-prefixed label and stays a terminator despite the pronoun.
  assert.equal(closesSection("About Boise Cascade"), true);
});

test("Blocker 1: responsibilities / preferred headings still switch sections normally", () => {
  const sections = parseDescriptionSections(
    `<p>Responsibilities</p><ul><li>Build and operate streaming ingestion services.</li></ul>` +
      `<p>Required Qualifications</p><ul><li>Five years of Python engineering experience.</li></ul>` +
      `<p>Preferred Qualifications</p><ul><li>Experience with Snowflake in production is a plus.</li></ul>`
  );
  assert.ok(sections!.responsibilities?.includes("streaming ingestion"));
  assert.ok(sections!.qualifications?.includes("Python"));
  assert.ok(sections!.niceToHave?.includes("Snowflake"));
  assert.ok(!sections!.qualifications?.includes("Snowflake"), "preferred must not land in required");
  assert.ok(!sections!.qualifications?.includes("streaming ingestion"), "responsibilities must not land in required");
});

test("Blocker 1: a PREFERRED sub-list is not absorbed as Required (job 33046's second list)", () => {
  // Job 33046's real structure: a Required list under "To be successful in this role you have:",
  // then an OPTIONAL list under "It also helps if you have:". Absorbing the second into the first
  // would mark optional asks Required — the exact fabrication Stage 25A fixed for
  // "Preferred Qualifications" headings.
  const html = `
    <p>Qualifications</p>
    <p>To be successful in this role you have:</p>
    <ul><li>5+ years of hands-on experience operating workloads on Kubernetes.</li></ul>
    <p>It also helps if you have:</p>
    <ul><li>Familiarity with Terraform and service mesh tooling in production.</li></ul>`;
  const sections = parseDescriptionSections(html);
  assert.ok(sections!.qualifications?.includes("Kubernetes"), "required list stays required");
  assert.ok(sections!.niceToHave?.includes("Terraform"), "optional list becomes niceToHave");
  assert.ok(!sections!.qualifications?.includes("Terraform"), "optional list must NOT be Required");

  const skills = extractSkills({ descriptionText: null, descriptionHtml: html, sections });
  const terraform = skills.find((s) => s.skillName.toLowerCase() === "terraform");
  assert.ok(terraform, "Terraform must be extracted");
  assert.equal(terraform!.requirementLevel, "Preferred");
});

test("Blocker 1: preference cues on ordinary CONTENT bullets never open a section", () => {
  // "bilingual is a plus" (7 occurrences), "bachelor's degree a plus" (4) are bullets, not headings.
  const html = `
    <p>Required Qualifications</p>
    <ul>
      <li>Bilingual is a plus</li>
      <li>Bachelor's degree a plus</li>
      <li>Five years of experience administering Kafka clusters in production.</li>
    </ul>`;
  const sections = parseDescriptionSections(html);
  assert.ok(sections!.qualifications?.includes("Kafka"));
  assert.ok(sections!.qualifications?.includes("Bilingual is a plus"), "the bullet stays in place");
  assert.equal(sections!.niceToHave, undefined, "a content bullet must not open an optional section");
});

// --- Blocker 1 follow-on: the inflation the extra extraction re-opened -----------------------------

test("Stage 25B: an EDUCATION-only requirement pool does not anchor the score", async () => {
  const { computeOverallScore } = await import("../match/scoring");
  // Real shape from the corpus: "Pharmaceutical Sales Representative" whose only requirement unit is
  // "BA/BS required" -> Bachelor's, which the candidate holds. roleAlignment 0, required 100,
  // experience 100 used to weight-average to 61.1 and outrank real engineering postings.
  const dims = { roleAlignment: 0, required: 100, preferred: 0, experience: 100, seniority: null };
  const withSkill = computeOverallScore(dims, true);
  const educationOnly = computeOverallScore(dims, false);
  assert.equal(withSkill, 61.1, "a genuine SKILL requirement still anchors experience/seniority normally");
  assert.equal(educationOnly, 53.3, "with no skill unit, experience/seniority drop out of the average");
  assert.ok(educationOnly < withSkill, "an education-only pool must never score as high as a skill-evidenced one");
  // The `required`/`preferred` coverage dimensions themselves are deliberately UNCHANGED: a stated
  // "MS in Computer Science required" is a real requirement on a real engineering posting and still
  // counts toward coverage. Only the experience/seniority anchor is withheld.
  assert.equal(computeOverallScore({ ...dims, experience: null, seniority: null }, false), 53.3);
});

test("Stage 25B: the ambiguous bare 'scd' alias no longer matches a ScD degree", async () => {
  const { extractSkills } = await import("../jobIntel/skills");
  // Verbatim from job 7567, a Senior Clinical Research Scientist posting.
  const html =
    "<p>Required Qualifications</p><ul><li>Experience with a PhD, DrPH, PharmD, MD, ScD, or equivalent advanced training in health sciences.</li></ul>";
  const sections = parseDescriptionSections(html);
  const skills = extractSkills({ descriptionText: null, descriptionHtml: html, sections });
  assert.ok(!skills.some((s) => s.skillName === "SCD"), `a doctoral degree is not a data-engineering skill: ${JSON.stringify(skills)}`);
});

test("Stage 25B: genuine slowly-changing-dimension phrasing still matches", async () => {
  const { extractSkills } = await import("../jobIntel/skills");
  const html = "<p>Required Qualifications</p><ul><li>Hands-on experience implementing SCD Type 2 slowly changing dimension logic.</li></ul>";
  const sections = parseDescriptionSections(html);
  const skills = extractSkills({ descriptionText: null, descriptionHtml: html, sections });
  assert.ok(skills.some((s) => s.skillName === "SCD"), "the unambiguous expansions must still match");
});
