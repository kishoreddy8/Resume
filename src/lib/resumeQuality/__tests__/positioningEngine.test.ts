import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";
import { buildJdPriorityMatrix } from "../jdPriorityMatrix";
import { evaluatePositioning, recommendedPositioningSummary } from "../positioningEngine";
import { JD_SHAPES, MULTI_JD_MASTER_PROFILE } from "./fixtures/multiJdCandidate";

test("reproduces and blocks the real observed failure: secondary-tech headline hijack on a Senior Data Engineer JD", () => {
  const badResume: ResumeContent = {
    name: "Test Candidate",
    tagline: "Data Engineer | Cloud Infrastructure, Containerization & Observability",
    location: "Remote",
    phone: "312-555-9821",
    email: "test@gmail.com",
    summary: ["Data engineer experienced in Terraform, Docker, AKS, Prometheus, and Grafana."],
    skillGroups: [{ label: "Skills", items: ["Terraform", "Docker", "AKS", "Prometheus", "Grafana", "Snowflake"] }],
    experience: [{ title: "Data Engineer", company: "Acme", dates: "2020 - Present", bullets: ["Built Snowflake pipelines."] }],
    education: ["B.S. Computer Science"],
  };
  const requirements = JD_SHAPES[0].requirements; // Snowflake-heavy Senior Data Engineer
  const matrix = buildJdPriorityMatrix(requirements, "Senior Data Engineer", MULTI_JD_MASTER_PROFILE);
  const evaluation = evaluatePositioning(badResume, matrix);
  assert.equal(evaluation.status, "FAIL");
  assert.ok(evaluation.issues.some((i) => i.includes("secondary technology")), `expected a secondary-tech-hijack issue: ${JSON.stringify(evaluation.issues)}`);
});

test("a headline with a genuinely unrelated title (no role-word overlap at all) is flagged for that specifically", () => {
  const unrelatedResume: ResumeContent = {
    name: "Test Candidate",
    tagline: "Product Marketing Manager",
    location: "Remote",
    phone: "312-555-9821",
    email: "test@gmail.com",
    summary: ["Marketing professional with campaign experience."],
    skillGroups: [{ label: "Skills", items: ["Snowflake"] }],
    experience: [{ title: "Data Engineer", company: "Acme", dates: "2020 - Present", bullets: ["Built Snowflake pipelines."] }],
    education: ["B.S. Computer Science"],
  };
  const matrix = buildJdPriorityMatrix(JD_SHAPES[0].requirements, "Senior Data Engineer", MULTI_JD_MASTER_PROFILE);
  const evaluation = evaluatePositioning(unrelatedResume, matrix);
  assert.equal(evaluation.status, "FAIL");
  assert.ok(evaluation.issues.some((i) => i.includes("shares no wording with the target role")));
});

test("a correctly positioned resume (role-matching headline, core JD requirement in summary) passes", () => {
  const goodResume: ResumeContent = {
    name: "Test Candidate",
    tagline: "Senior Data Engineer | Snowflake & dbt",
    location: "Remote",
    phone: "312-555-9821",
    email: "test@gmail.com",
    summary: ["Senior Data Engineer specializing in Snowflake data warehousing and dbt transformation pipelines."],
    skillGroups: [{ label: "Skills", items: ["Snowflake", "dbt", "Airflow"] }],
    experience: [{ title: "Senior Data Engineer", company: "Acme", dates: "2020 - Present", bullets: ["Built Snowflake pipelines."] }],
    education: ["B.S. Computer Science"],
  };
  const matrix = buildJdPriorityMatrix(JD_SHAPES[0].requirements, "Senior Data Engineer", MULTI_JD_MASTER_PROFILE);
  const evaluation = evaluatePositioning(goodResume, matrix);
  assert.equal(evaluation.status, "PASS");
});

test("no target role title -> REVIEW, never silently PASS", () => {
  const resume: ResumeContent = {
    name: "X", tagline: "Data Engineer", location: "Remote", phone: "312-555-9821", email: "x@gmail.com",
    summary: ["Data engineer."], skillGroups: [], experience: [], education: [],
  };
  const matrix = buildJdPriorityMatrix([], null, MULTI_JD_MASTER_PROFILE);
  const evaluation = evaluatePositioning(resume, matrix);
  assert.equal(evaluation.status, "REVIEW");
});

test("recommendedPositioningSummary only ever names evidenced P1 requirements, never a fabricated one", () => {
  const matrix = buildJdPriorityMatrix(JD_SHAPES[2].requirements, "AI Data Engineer", MULTI_JD_MASTER_PROFILE); // shape C - unsupported AI reqs
  const summary = recommendedPositioningSummary(matrix);
  // Azure OpenAI/RAG are P1 in shape C's requirements but the candidate has zero evidence for them.
  assert.ok(!summary.includes("Azure OpenAI"));
  assert.ok(!summary.includes("RAG"));
});

test("multi-JD: the SAME candidate evidence produces materially different, but each individually truthful, positioning recommendations per JD shape", () => {
  const summaries = JD_SHAPES.map((shape) => {
    const matrix = buildJdPriorityMatrix(shape.requirements, shape.targetRoleTitle, MULTI_JD_MASTER_PROFILE);
    return { shape: shape.name, summary: recommendedPositioningSummary(matrix) };
  });

  // Every recommendation differs from every other — real repositioning, not a static template.
  const uniqueSummaries = new Set(summaries.map((s) => s.summary));
  assert.equal(uniqueSummaries.size, summaries.length, `expected all ${summaries.length} positioning summaries to differ:\n${JSON.stringify(summaries, null, 2)}`);

  // Shape A (Snowflake-heavy) should foreground Snowflake/dbt, not Terraform/Prometheus.
  const shapeA = summaries.find((s) => s.shape.startsWith("A."))!;
  assert.ok(shapeA.summary.includes("Snowflake"));
  assert.ok(!shapeA.summary.includes("Terraform"));

  // Shape D (platform-heavy) should foreground Terraform/Docker, not Snowflake/dbt.
  const shapeD = summaries.find((s) => s.shape.startsWith("D."))!;
  assert.ok(shapeD.summary.includes("Terraform"));
  assert.ok(!shapeD.summary.includes("Snowflake"));
});
