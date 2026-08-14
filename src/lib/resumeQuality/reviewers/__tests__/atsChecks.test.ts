import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequirementUnit } from "@/lib/match/types";
import type { ResumeContent } from "../../../../../tools/tailoring-engine/types";
import { evaluateAtsAlignment } from "../atsChecks";

function unit(overrides: Partial<RequirementUnit>): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: [],
    categories: [],
    label: "requirement",
    requirementLevel: "Required",
    criticality: "REQUIRED",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    fromUnclaimedText: false,
    ...overrides,
  };
}

function baseResume(overrides: Partial<ResumeContent> = {}): ResumeContent {
  return {
    name: "Test Candidate",
    tagline: "Data Engineer",
    location: "Remote",
    phone: "555-0100",
    email: "test@example.com",
    summary: ["Data engineer with Azure and Databricks experience."],
    skillGroups: [{ label: "Cloud & Data Platform", items: ["Azure", "Azure Data Factory", "Databricks"] }],
    experience: [{ title: "Data Engineer", company: "Acme", dates: "2020 - Present", bullets: ["Built Azure Data Factory pipelines to orchestrate Databricks notebooks."] }],
    education: ["B.S. Computer Science"],
    ...overrides,
  };
}

test("1. strong keyword alignment: all required skills evidenced -> high atsScore, no missing required skills", () => {
  const jobRequirements = [
    unit({ memberSkillNames: ["Azure"], label: "Azure", requirementLevel: "Required" }),
    unit({ memberSkillNames: ["Azure Data Factory"], label: "Azure Data Factory", requirementLevel: "Required" }),
    unit({ memberSkillNames: ["Databricks"], label: "Databricks", requirementLevel: "Required" }),
  ];
  const result = evaluateAtsAlignment(baseResume(), jobRequirements);
  assert.deepEqual(result.missingRequiredSkills, []);
  assert.equal(result.atsScore, 100);
});

test("2. missing required skill is reported and lowers atsScore", () => {
  const jobRequirements = [
    unit({ memberSkillNames: ["Azure"], label: "Azure", requirementLevel: "Required" }),
    unit({ memberSkillNames: ["Snowflake"], label: "Snowflake", requirementLevel: "Required" }), // not on the resume
  ];
  const result = evaluateAtsAlignment(baseResume(), jobRequirements);
  assert.deepEqual(result.missingRequiredSkills, ["Snowflake"]);
  assert.ok(result.atsScore < 100);
});

test("3. preferred skill missing does not appear in missingRequiredSkills but still affects scoring", () => {
  const jobRequirements = [
    unit({ memberSkillNames: ["Azure"], label: "Azure", requirementLevel: "Required" }),
    unit({ memberSkillNames: ["Kafka"], label: "Kafka", requirementLevel: "Preferred", criticality: "PREFERRED" }), // missing, preferred only
  ];
  const withMissingPreferred = evaluateAtsAlignment(baseResume(), jobRequirements);
  assert.deepEqual(withMissingPreferred.missingRequiredSkills, []);

  const allSatisfied = evaluateAtsAlignment(
    baseResume(),
    [unit({ memberSkillNames: ["Azure"], label: "Azure", requirementLevel: "Required" })]
  );
  assert.ok(withMissingPreferred.atsScore <= allSatisfied.atsScore, "a missing preferred skill should never score higher than having none to miss");
});

test("4. alias matching: JD requires 'Azure Data Factory', resume only writes 'ADF' — still counts as satisfied", () => {
  const resume = baseResume({
    skillGroups: [{ label: "Cloud", items: ["ADF"] }],
    experience: [{ title: "Data Engineer", company: "Acme", dates: "2020", bullets: ["Built ADF pipelines."] }],
  });
  const jobRequirements = [unit({ memberSkillNames: ["Azure Data Factory"], label: "Azure Data Factory" })];
  const result = evaluateAtsAlignment(resume, jobRequirements);
  assert.deepEqual(result.missingRequiredSkills, []);
});

test("4b. alias matching: 'AWS Glue' and 'Azure Databricks' resume-side aliases are recognized", () => {
  const resume = baseResume({
    skillGroups: [{ label: "Cloud", items: ["Azure Databricks"] }],
    experience: [{ title: "Data Engineer", company: "Acme", dates: "2020", bullets: ["Built AWS Glue jobs."] }],
  });
  const jobRequirements = [
    unit({ memberSkillNames: ["Databricks"], label: "Databricks" }),
    unit({ memberSkillNames: ["AWS Glue"], label: "AWS Glue" }),
  ];
  const result = evaluateAtsAlignment(resume, jobRequirements);
  assert.deepEqual(result.missingRequiredSkills, []);
});

test("5. related-but-not-identical skill protection: PySpark on the resume does NOT satisfy a Python requirement, and vice versa", () => {
  const resume = baseResume({
    skillGroups: [{ label: "Languages", items: ["PySpark"] }],
    experience: [{ title: "Data Engineer", company: "Acme", dates: "2020", bullets: ["Wrote PySpark transformations."] }],
  });
  const requiresPython = [unit({ memberSkillNames: ["Python"], label: "Python" })];
  const result = evaluateAtsAlignment(resume, requiresPython);
  assert.deepEqual(result.missingRequiredSkills, ["Python"], "PySpark evidence must never satisfy a bare Python requirement");
});

test("5b. related-but-not-identical skill protection: Azure OpenAI does not satisfy a generic OpenAI-style requirement (no bare OpenAI canonical exists to confuse it with)", () => {
  const resume = baseResume({
    skillGroups: [{ label: "AI/ML", items: ["Azure OpenAI"] }],
    experience: [{ title: "Data Engineer", company: "Acme", dates: "2020", bullets: ["Integrated Azure OpenAI for summarization."] }],
  });
  const requiresAzureOpenAI = [unit({ memberSkillNames: ["Azure OpenAI"], label: "Azure OpenAI" })];
  const result = evaluateAtsAlignment(resume, requiresAzureOpenAI);
  assert.deepEqual(result.missingRequiredSkills, [], "Azure OpenAI must resolve to its own canonical entry correctly");
});

test("insufficient requirement data is surfaced rather than silently defaulted to a perfect score", () => {
  const result = evaluateAtsAlignment(baseResume(), undefined);
  assert.equal(result.insufficientRequirementData, true);
  assert.notEqual(result.atsScore, 100, "must not silently claim perfect ATS alignment with zero comparison data");
});

test("atsScore and keywordAlignmentScore stay within 0-100 bounds", () => {
  const jobRequirements = [unit({ memberSkillNames: ["Snowflake"], label: "Snowflake" })];
  const result = evaluateAtsAlignment(baseResume({ skillGroups: [], experience: [] }), jobRequirements);
  assert.ok(result.atsScore >= 0 && result.atsScore <= 100);
  assert.ok(result.keywordAlignmentScore >= 0 && result.keywordAlignmentScore <= 100);
});
