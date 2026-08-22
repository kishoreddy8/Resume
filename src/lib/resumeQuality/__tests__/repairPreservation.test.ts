import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRepairPreservation } from "../repairPreservation";
import type { RepairPlan } from "../repairScope";
import type { CoverLetterContent, ResumeContent } from "../types";

function resume(): ResumeContent {
  return {
    name: "Sai Reddy",
    tagline: "Data Engineer",
    location: "Dallas, TX",
    phone: "5551112222",
    email: "sai@example.com",
    summary: ["Data Engineer building cloud pipelines for banking teams. Delivery emphasizes reliable data."],
    skillGroups: [
      { label: "Cloud", items: ["Azure", "Databricks"] },
      { label: "Languages", items: ["Python", "SQL"] },
    ],
    experience: [
      {
        title: "Data Engineer",
        company: "Fiserv",
        dates: "2022 - Present",
        projectDescription: "Built Azure data pipelines for payments reporting.",
        bullets: ["Engineered Azure pipelines for payments reporting.", "Automated tests with Pytest."],
      },
      {
        title: "Data Engineer",
        company: "Microgate Technologies",
        dates: "2020 - 2021",
        projectDescription: "Built supported batch ingestion workflows.",
        bullets: ["Developed Python ETL pipelines."],
      },
    ],
    education: ["MS, Example University - 2022"],
    certifications: ["Azure Fundamentals"],
  };
}

function coverLetter(): CoverLetterContent {
  return {
    name: "Sai Reddy",
    location: "Dallas, TX",
    phone: "5551112222",
    email: "sai@example.com",
    salutation: "Dear Hiring Team,",
    paragraphs: [
      "I am applying for the Data Engineer role.",
      "At Fiserv, I built Snowflake pipelines. I also supported payments reporting.",
      "Thank you for your consideration.",
    ],
    closing: "Sincerely,\nSai Reddy",
  };
}

function plan(editablePaths: string[]): RepairPlan {
  return {
    scope: "FULL",
    reason: "fixture",
    resumeFindings: [],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("one cover-letter correction permits only the named sentence", () => {
  const baselineResume = resume();
  const baselineCoverLetter = coverLetter();
  const repairedCoverLetter = clone(baselineCoverLetter);
  repairedCoverLetter.paragraphs[1] = "At Fiserv, I built Azure pipelines. I also supported payments reporting.";
  const valid = validateRepairPreservation({
    baselineResume,
    baselineCoverLetter,
    repairedResume: clone(baselineResume),
    repairedCoverLetter,
    repairPlan: plan(["coverLetter.paragraphs[1].sentences[0]"]),
  });
  assert.equal(valid.valid, true, valid.violations.join(", "));

  repairedCoverLetter.paragraphs[1] = "At Fiserv, I built Azure pipelines. I led unrelated platform work.";
  const invalid = validateRepairPreservation({
    baselineResume,
    baselineCoverLetter,
    repairedResume: clone(baselineResume),
    repairedCoverLetter,
    repairPlan: plan(["coverLetter.paragraphs[1].sentences[0]"]),
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.violations.includes("coverLetter.paragraphs[1].sentences[1]"));
});
// --- Phase G: sentence-level cover-letter repair precision, using the shared splitSentences ---------

function threeSentenceCoverLetter(): CoverLetterContent {
  const cl = coverLetter();
  cl.paragraphs[1] = "At Fiserv, I built Snowflake pipelines. I also supported payments reporting. The team shipped on schedule.";
  return cl;
}

test("Phase G: editing only the middle sentence of three leaves the other two byte-identical", () => {
  const baselineResume = resume();
  const baselineCoverLetter = threeSentenceCoverLetter();
  const repaired = clone(baselineCoverLetter);
  repaired.paragraphs[1] = "At Fiserv, I built Snowflake pipelines. I also supported Azure payments reporting. The team shipped on schedule.";
  const result = validateRepairPreservation({
    baselineResume,
    baselineCoverLetter,
    repairedResume: clone(baselineResume),
    repairedCoverLetter: repaired,
    repairPlan: plan(["coverLetter.paragraphs[1].sentences[1]"]),
  });
  assert.equal(result.valid, true, result.violations.join(", "));
});

test("Phase G: editing only the final sentence of three leaves the other two byte-identical", () => {
  const baselineResume = resume();
  const baselineCoverLetter = threeSentenceCoverLetter();
  const repaired = clone(baselineCoverLetter);
  repaired.paragraphs[1] = "At Fiserv, I built Snowflake pipelines. I also supported payments reporting. The team shipped ahead of schedule.";
  const result = validateRepairPreservation({
    baselineResume,
    baselineCoverLetter,
    repairedResume: clone(baselineResume),
    repairedCoverLetter: repaired,
    repairPlan: plan(["coverLetter.paragraphs[1].sentences[2]"]),
  });
  assert.equal(result.valid, true, result.violations.join(", "));
});

test("Phase G: editing an unauthorized neighboring sentence is a violation even when the authorized one is also correctly edited", () => {
  const baselineResume = resume();
  const baselineCoverLetter = threeSentenceCoverLetter();
  const repaired = clone(baselineCoverLetter);
  repaired.paragraphs[1] = "At Fiserv, I built Azure pipelines. I also supported payments reporting differently. The team shipped on schedule.";
  const result = validateRepairPreservation({
    baselineResume,
    baselineCoverLetter,
    repairedResume: clone(baselineResume),
    repairedCoverLetter: repaired,
    repairPlan: plan(["coverLetter.paragraphs[1].sentences[0]"]),
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.includes("coverLetter.paragraphs[1].sentences[1]"));
});

test("Phase G: merging two sentences into one is a scope violation via the sentence-count check", () => {
  const baselineResume = resume();
  const baselineCoverLetter = threeSentenceCoverLetter();
  const repaired = clone(baselineCoverLetter);
  repaired.paragraphs[1] = "At Fiserv, I built Snowflake pipelines and also supported payments reporting. The team shipped on schedule.";
  const result = validateRepairPreservation({
    baselineResume,
    baselineCoverLetter,
    repairedResume: clone(baselineResume),
    repairedCoverLetter: repaired,
    repairPlan: plan(["coverLetter.paragraphs[1].sentences[0]", "coverLetter.paragraphs[1].sentences[1]"]),
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.includes("coverLetter.paragraphs[1].sentenceCount"));
});

test("Phase G: splitting one sentence into two is a scope violation via the sentence-count check", () => {
  const baselineResume = resume();
  const baselineCoverLetter = threeSentenceCoverLetter();
  const repaired = clone(baselineCoverLetter);
  repaired.paragraphs[1] = "At Fiserv, I built Snowflake pipelines. I also supported payments reporting. We shipped early. The team celebrated.";
  const result = validateRepairPreservation({
    baselineResume,
    baselineCoverLetter,
    repairedResume: clone(baselineResume),
    repairedCoverLetter: repaired,
    repairPlan: plan(["coverLetter.paragraphs[1].sentences[2]"]),
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.includes("coverLetter.paragraphs[1].sentenceCount"));
});

test("Phase G: adding or removing an entire paragraph is a scope violation even when no sentence path names that paragraph", () => {
  const baselineResume = resume();
  const baselineCoverLetter = threeSentenceCoverLetter();
  const repaired = clone(baselineCoverLetter);
  repaired.paragraphs.push("An entirely new closing paragraph nobody authorized.");
  const result = validateRepairPreservation({
    baselineResume,
    baselineCoverLetter,
    repairedResume: clone(baselineResume),
    repairedCoverLetter: repaired,
    repairPlan: plan(["coverLetter.paragraphs[1].sentences[1]"]),
  });
  assert.equal(result.valid, false);
});

test("Phase G: two authorized sentences in the same paragraph may both change; the third must not", () => {
  const baselineResume = resume();
  const baselineCoverLetter = threeSentenceCoverLetter();
  const repaired = clone(baselineCoverLetter);
  repaired.paragraphs[1] = "At Fiserv, I built Azure pipelines. I also supported healthcare payments reporting. The team shipped on schedule.";
  const result = validateRepairPreservation({
    baselineResume,
    baselineCoverLetter,
    repairedResume: clone(baselineResume),
    repairedCoverLetter: repaired,
    repairPlan: plan(["coverLetter.paragraphs[1].sentences[0]", "coverLetter.paragraphs[1].sentences[1]"]),
  });
  assert.equal(result.valid, true, result.violations.join(", "));
});

test("Phase G: authorized sentences in two different paragraphs may each change independently", () => {
  const baselineResume = resume();
  const baselineCoverLetter = threeSentenceCoverLetter();
  const repaired = clone(baselineCoverLetter);
  repaired.paragraphs[0] = "I am excited to apply for the Data Engineer role.";
  repaired.paragraphs[1] = "At Fiserv, I built Azure pipelines. I also supported payments reporting. The team shipped on schedule.";
  const result = validateRepairPreservation({
    baselineResume,
    baselineCoverLetter,
    repairedResume: clone(baselineResume),
    repairedCoverLetter: repaired,
    repairPlan: plan(["coverLetter.paragraphs[0].sentences[0]", "coverLetter.paragraphs[1].sentences[0]"]),
  });
  assert.equal(result.valid, true, result.violations.join(", "));
});

test("one bullet correction freezes every other bullet, summary, skill, project and metric", () => {
  const baseline = resume();
  const repaired = clone(baseline);
  repaired.experience[0]!.bullets[0] = "Engineered supported Azure pipelines for payments reporting.";
  assert.equal(
    validateRepairPreservation({ baselineResume: baseline, repairedResume: repaired, repairPlan: plan(["resume.experience[0].bullets[0]"]) }).valid,
    true
  );
  repaired.summary[0] = "Collateral summary rewrite.";
  const result = validateRepairPreservation({ baselineResume: baseline, repairedResume: repaired, repairPlan: plan(["resume.experience[0].bullets[0]"]) });
  assert.equal(result.valid, false);
  assert.ok(result.violations.includes("resume.summary[0]"));
});

test("summary repair permits summary only and freezes experience", () => {
  const baseline = resume();
  const repaired = clone(baseline);
  repaired.summary = ["Data Engineer delivering supported Azure pipelines for banking reporting."];
  assert.equal(validateRepairPreservation({ baselineResume: baseline, repairedResume: repaired, repairPlan: plan(["resume.summary"]) }).valid, true);
  repaired.experience[0]!.bullets[0] = "Rewritten experience.";
  assert.equal(validateRepairPreservation({ baselineResume: baseline, repairedResume: repaired, repairPlan: plan(["resume.summary"]) }).valid, false);
});

test("skills repair permits skills only and freezes experience", () => {
  const baseline = resume();
  const repaired = clone(baseline);
  repaired.skillGroups = [baseline.skillGroups[1]!, baseline.skillGroups[0]!];
  assert.equal(validateRepairPreservation({ baselineResume: baseline, repairedResume: repaired, repairPlan: plan(["resume.skillGroups"]) }).valid, true);
  repaired.experience[1]!.projectDescription = "Collateral project rewrite.";
  assert.equal(validateRepairPreservation({ baselineResume: baseline, repairedResume: repaired, repairPlan: plan(["resume.skillGroups"]) }).valid, false);
});

test("formatting-only repair changes only the named presentation field", () => {
  const baseline = resume();
  baseline.location = "Dallas,TX";
  const repaired = clone(baseline);
  repaired.location = "Dallas, TX";
  assert.equal(validateRepairPreservation({ baselineResume: baseline, repairedResume: repaired, repairPlan: plan(["resume.location"]) }).valid, true);
  repaired.tagline = "Cloud Engineer";
  assert.equal(validateRepairPreservation({ baselineResume: baseline, repairedResume: repaired, repairPlan: plan(["resume.location"]) }).valid, false);
});

test("multiple findings permit exactly their independent paths", () => {
  const baselineResume = resume();
  const baselineCoverLetter = coverLetter();
  const repairedResume = clone(baselineResume);
  const repairedCoverLetter = clone(baselineCoverLetter);
  repairedResume.experience[0]!.projectDescription = "Built concise Azure payments pipelines.";
  repairedCoverLetter.paragraphs[1] = "At Fiserv, I built Azure pipelines. I also supported payments reporting.";
  const result = validateRepairPreservation({
    baselineResume,
    baselineCoverLetter,
    repairedResume,
    repairedCoverLetter,
    repairPlan: plan(["resume.experience[0].projectDescription", "coverLetter.paragraphs[1].sentences[0]"]),
  });
  assert.equal(result.valid, true, result.violations.join(", "));
});
