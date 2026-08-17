import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";
import { buildJdPriorityMatrix } from "../jdPriorityMatrix";
import { evaluateRecruiterQuality } from "../recruiterQualityGate";
import { JD_SHAPES, MULTI_JD_MASTER_PROFILE } from "./fixtures/multiJdCandidate";

function baseInput(resume: ResumeContent, matrix: ReturnType<typeof buildJdPriorityMatrix>) {
  return {
    resume,
    matrix,
    candidateProfile: MULTI_JD_MASTER_PROFILE,
    genericBulletsCount: 0,
    bannedLanguageCount: 0,
    duplicateBulletCount: 0,
    recruiterReadabilityScore: 95,
  };
}

test("the real observed positioning-hijack failure is BLOCKING at the recruiter-quality-gate level too", () => {
  const badResume: ResumeContent = {
    name: "Test", tagline: "Data Engineer | Cloud Infrastructure, Containerization & Observability",
    location: "Remote", phone: "312-555-9821", email: "test@gmail.com",
    summary: ["Data engineer experienced in Terraform, Docker, AKS, Prometheus, and Grafana."],
    skillGroups: [{ label: "Skills", items: ["Terraform", "Docker", "Snowflake"] }],
    experience: [{ title: "Data Engineer", company: "Acme", dates: "2020 - Present", bullets: ["Built Snowflake pipelines."] }],
    education: [],
  };
  const matrix = buildJdPriorityMatrix(JD_SHAPES[0].requirements, "Senior Data Engineer", MULTI_JD_MASTER_PROFILE);
  const assessment = evaluateRecruiterQuality(baseInput(badResume, matrix));
  assert.equal(assessment.status, "FAIL");
  assert.ok(assessment.issues.some((i) => i.dimension === "excessiveSecondaryTechEmphasis" && i.severity === "BLOCKING"));
});

test("advisory-only issues (readability, generic bullets) never flip status to FAIL on their own", () => {
  const okResume: ResumeContent = {
    name: "Test", tagline: "Senior Data Engineer | Snowflake & dbt",
    location: "Remote", phone: "312-555-9821", email: "test@gmail.com",
    summary: ["Senior Data Engineer specializing in Snowflake and dbt."],
    skillGroups: [{ label: "Skills", items: ["Snowflake", "dbt", "Airflow"] }],
    experience: [{ title: "Senior Data Engineer", company: "Northwind Logistics Analytics", dates: "2022 - Present", bullets: ["Architected a Snowflake data warehouse."] }],
    education: [],
  };
  const matrix = buildJdPriorityMatrix(JD_SHAPES[0].requirements, "Senior Data Engineer", MULTI_JD_MASTER_PROFILE);
  const input = { ...baseInput(okResume, matrix), genericBulletsCount: 1, recruiterReadabilityScore: 60 };
  const assessment = evaluateRecruiterQuality(input);
  assert.notEqual(assessment.status, "FAIL");
  assert.ok(assessment.issues.every((i) => i.severity === "ADVISORY"));
  assert.ok(assessment.score < 100, "advisory issues should still lower the diagnostic score");
});

test("underselling: a STRONG P1-evidenced requirement absent from the resume entirely is flagged (advisory, never fabricated in)", () => {
  const underclaimedResume: ResumeContent = {
    name: "Test", tagline: "Senior Data Engineer", location: "Remote", phone: "312-555-9821", email: "test@gmail.com",
    summary: ["Senior Data Engineer."],
    skillGroups: [{ label: "Skills", items: ["Python"] }], // Snowflake omitted entirely despite STRONG evidence
    experience: [{ title: "Senior Data Engineer", company: "Northwind Logistics Analytics", dates: "2022 - Present", bullets: ["Wrote Python scripts."] }],
    education: [],
  };
  const matrix = buildJdPriorityMatrix(JD_SHAPES[0].requirements, "Senior Data Engineer", MULTI_JD_MASTER_PROFILE);
  const assessment = evaluateRecruiterQuality(baseInput(underclaimedResume, matrix));
  assert.ok(assessment.issues.some((i) => i.dimension === "underselling" && i.description.includes("Snowflake")));
});

test("a fully clean, well-positioned, JD-aligned resume produces zero issues and a perfect score", () => {
  const cleanResume: ResumeContent = {
    name: "Test", tagline: "Senior Data Engineer | Snowflake & dbt",
    location: "Remote", phone: "312-555-9821", email: "test@gmail.com",
    summary: ["Senior Data Engineer specializing in Snowflake data warehousing and dbt transformation pipelines orchestrated with Airflow."],
    skillGroups: [{ label: "Skills", items: ["Snowflake", "dbt", "Airflow"] }],
    experience: [
      { title: "Senior Data Engineer", company: "Northwind Logistics Analytics", dates: "2022 - Present", bullets: ["Architected a Snowflake data warehouse and built dbt transformation pipelines consolidating regional systems.", "Orchestrated pipeline scheduling with Airflow."] },
    ],
    education: [],
  };
  const matrix = buildJdPriorityMatrix(JD_SHAPES[0].requirements, "Senior Data Engineer", MULTI_JD_MASTER_PROFILE);
  const assessment = evaluateRecruiterQuality(baseInput(cleanResume, matrix));
  assert.deepEqual(assessment.issues, []);
  assert.equal(assessment.score, 100);
  assert.equal(assessment.status, "PASS");
});
