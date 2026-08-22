import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { ResumeWriterOutput } from "../types";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";
import { generateResumeDocx } from "../../../../tools/tailoring-engine/resume-template";
import { validateDocx } from "../../../../tools/tailoring-engine/validate-docx";
import { buildJdPriorityMatrix } from "../jdPriorityMatrix";
import { evaluatePresentationStructure, renderPresentationStandardSection } from "../presentationStructure";
import { checkSummaryQuality, checkSummaryShape } from "../presentationContract";
import { evaluateBulletCaps } from "../reviewers/lengthAndTenseChecks";
import { recommendedSkillOrder } from "../skillRanking";
import { MULTI_JD_MASTER_PROFILE } from "./fixtures/multiJdCandidate";
import {
  CURRENT_ROLE_BULLET_CAP,
  OLDER_ROLE_BULLET_CAP,
  PROJECT_DESCRIPTION_MAX_SENTENCES,
  PROJECT_DESCRIPTION_MAX_TECHNOLOGIES,
  SECOND_ROLE_BULLET_CAP,
  TOTAL_EXPERIENCE_BULLET_CAP,
  normalizeResumeWriterOutput,
  renderWriterOutputQualitySection,
} from "../writerOutputQuality";

function bullets(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, index) => `Built ${prefix} capability ${index + 1} for reporting teams.`);
}

function resume(): ResumeContent {
  return {
    name: "Priya Anand",
    tagline: "Data Engineer",
    location: "Dallas,TX",
    phone: "312-555-9821",
    email: "priya@example.com",
    summary: [
      "Data Engineer building governed cloud data platforms for financial reporting. " +
        "Pipeline ownership spans ingestion, transformation, and dependable production delivery. " +
        "Platform design connects scalable processing with traceable data controls.",
    ],
    skillGroups: [{ label: "Cloud & Data", items: ["Azure Data Factory", "Python", "SQL"] }],
    experience: [
      {
        title: "Senior Data Engineer",
        company: "Northwind",
        location: "Dallas,TX",
        dates: "2022 - Present",
        projectDescription: "Built a governed Azure Data Factory platform for finance reporting.",
        bullets: bullets(3, "Northwind"),
        environment: ["Azure Data Factory", "Python", "SQL"],
      },
      { title: "Data Engineer", company: "Meridian", dates: "2019 - 2021", bullets: bullets(3, "Meridian") },
      { title: "Engineer", company: "Solstice", dates: "2016 - 2018", bullets: bullets(3, "Solstice") },
    ],
    education: ["B.S. Computer Science, Riverside State University - 2016"],
  };
}

function requirement(skill: string, criticality: RequirementUnit["criticality"]): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: [skill],
    categories: [],
    label: skill,
    requirementLevel: criticality === "CRITICAL" ? "Required" : "Preferred",
    criticality,
    evidenceSnippets: [],
    experienceDepthRequired: false,
    requestedYears: null,
    fromUnclaimedText: false,
  };
}

test("writer guidance requires varied summary construction instead of repeated capability stems", () => {
  const section = renderWriterOutputQualitySection();
  assert.match(section, /Do not stack template stems/);
  assert.match(section, /Expertise spans/);
  const formulaic = ["Data Engineer specializing in platforms. Expertise spans ingestion. Proven ability to deliver. Experienced in testing."];
  assert.ok(checkSummaryQuality(formulaic).some((issue) => issue.kind === "SUMMARY_FORMULAIC"));
});

test("writer guidance and validation keep the summary at 3-4 sentences", () => {
  assert.match(renderWriterOutputQualitySection(), /3-4 concise sentences/);
  assert.deepEqual(checkSummaryShape(resume().summary), []);
  assert.ok(checkSummaryShape(["Only one sentence."]).some((issue) => issue.kind === "SUMMARY_SENTENCE_COUNT"));
});

test("project descriptions are bounded by sentence and technology counts", () => {
  const content = resume();
  content.experience[0].projectDescription =
    "Built Azure Data Factory, Databricks, Snowflake, Python, and SQL pipelines. Added finance controls. Added reporting workflows.";
  const issue = evaluatePresentationStructure(content).find((item) => item.kind === "PROJECT_DESCRIPTION_DENSE");
  assert.ok(issue);
  assert.equal(PROJECT_DESCRIPTION_MAX_SENTENCES, 2);
  assert.equal(PROJECT_DESCRIPTION_MAX_TECHNOLOGIES, 4);
});

test("overloaded bullets may be split only when each result has distinct employer-scoped evidence", () => {
  const section = renderWriterOutputQualitySection();
  assert.match(section, /split it only when each resulting bullet has its own employer-scoped evidence/);
  assert.match(section, /Otherwise simplify the original bullet/);
});

test("role bullet caps are enforced at 8, 7, and 6", () => {
  const content = resume();
  content.experience[0].bullets = bullets(CURRENT_ROLE_BULLET_CAP, "current");
  content.experience[1].bullets = bullets(SECOND_ROLE_BULLET_CAP, "second");
  content.experience[2].bullets = bullets(OLDER_ROLE_BULLET_CAP, "older");
  assert.equal(evaluateBulletCaps(content.experience).compliant, true);
  content.experience[0].bullets.push("Built one excess current-role bullet.");
  assert.ok(evaluateBulletCaps(content.experience).corrections.some((item) => new RegExp(`${CURRENT_ROLE_BULLET_CAP}-bullet cap`).test(item.description)));
});

test("the total Professional Experience bullet cap is enforced", () => {
  const content = resume();
  content.experience[0].bullets = bullets(8, "current");
  content.experience[1].bullets = bullets(7, "second");
  content.experience[2].bullets = bullets(7, "older"); // one over the per-role cap too, to push the total past 21
  const result = evaluateBulletCaps(content.experience);
  assert.equal(TOTAL_EXPERIENCE_BULLET_CAP, 21);
  assert.ok(result.corrections.some((item) => /21-bullet total cap/.test(item.description)));
});

test("bullet caps are ceilings and never padding targets", () => {
  const section = renderWriterOutputQualitySection();
  assert.match(section, /ceilings, not targets: never pad to a cap/);
  assert.equal(resume().experience.reduce((sum, role) => sum + role.bullets.length, 0), 9);
});

test("supported AWS rises for an AWS-heavy JD without removing evidence controls", () => {
  const profile: CandidateProfile = {
    ...MULTI_JD_MASTER_PROFILE,
    skills: [...MULTI_JD_MASTER_PROFILE.skills, { rawSkillName: "AWS", source: "inventory_only" }],
  };
  const matrix = buildJdPriorityMatrix(
    [requirement("AWS", "CRITICAL"), requirement("Azure Data Factory", "OPTIONAL")],
    "Data Engineer",
    profile
  );
  const order = recommendedSkillOrder(profile, matrix);
  assert.ok(order.indexOf("AWS") < order.indexOf("Azure Data Factory"));
});

test("an unsupported AWS requirement never enters recommended skill order", () => {
  const matrix = buildJdPriorityMatrix([requirement("AWS Glue", "CRITICAL")], "Data Engineer", MULTI_JD_MASTER_PROFILE);
  assert.ok(!recommendedSkillOrder(MULTI_JD_MASTER_PROFILE, matrix).includes("AWS Glue"));
});

test("writer guidance forbids blind Azure-to-AWS employer rewrites", () => {
  const section = renderWriterOutputQualitySection();
  assert.match(section, /Never rewrite an Azure employer\s+claim as AWS/);
  assert.match(section, /same employer's evidence permits it/);
});

test("every added bullet requires employer attribution and an evidence source", () => {
  const section = renderWriterOutputQualitySection();
  assert.match(section, /record the employer and exact evidence source in/);
  assert.match(section, /If evidence cannot support an employer attribution, do not create the bullet/);
});

test("duplicate bullet ideas and synonymous repeats are rejected", () => {
  const section = renderWriterOutputQualitySection();
  assert.match(section, /Reject duplicate ideas, synonymous repeats/);
});

test("location formatting normalizes comma spacing", () => {
  const normalized = normalizeResumeWriterOutput({ resume: resume() });
  assert.equal(normalized.resume.location, "Dallas, TX");
  assert.equal(normalized.resume.experience[0].location, "Dallas, TX");
});

test("malformed Unicode separators and hyphens are cleaned without changing hard facts", () => {
  const content = resume();
  content.summary = ["Built\u00a0governed\u200bdata platforms with cloud‑native controls."];
  content.experience[0].bullets = ["Engineered end‑to‑end pipelines,cutting retries."];
  const normalized = normalizeResumeWriterOutput({ resume: content });
  assert.equal(normalized.resume.summary[0], "Built governed data platforms with cloud-native controls.");
  assert.equal(normalized.resume.experience[0].bullets[0], "Engineered end-to-end pipelines, cutting retries.");
  assert.equal(normalized.resume.experience[0].company, "Northwind");
  assert.equal(normalized.resume.experience[0].dates, "2022 - Present");
});

test("normalized output remains ATS-safe when rendered", async () => {
  const output: ResumeWriterOutput = { resume: resume() };
  output.resume.experience[0].bullets[0] = "Built cloud‑native pipelines for finance reporting.";
  const normalized = normalizeResumeWriterOutput(output);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "writer-quality-"));
  const file = path.join(directory, "Resume.docx");
  await generateResumeDocx(normalized.resume, file);
  const validation = await validateDocx(file, "resume");
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.violations, []);
});

test("the presentation prompt includes the writer-quality policy exactly once", () => {
  const section = renderPresentationStandardSection(undefined);
  assert.equal(section.match(/WRITER OUTPUT QUALITY/g)?.length, 1);
  assert.match(section, /JD-driven skill order/);
});
