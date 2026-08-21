import assert from "node:assert/strict";
import test from "node:test";
import type { CoverLetterContent, ResumeContent } from "../../../../../tools/tailoring-engine/types";
import { evaluateCrossDocumentConsistency } from "../crossDocumentChecks";

function resume(): ResumeContent {
  return {
    name: "Candidate",
    tagline: "Data Engineer",
    location: "Chicago, IL",
    phone: "555-0100",
    email: "candidate@example.com",
    summary: ["Data engineer building production data platforms."],
    skillGroups: [{ label: "Core", items: ["Python", "SQL"] }],
    experience: [
      {
        title: "Data Engineer",
        company: "Fiserv",
        dates: "2021 – 2023",
        bullets: [
          "Published curated datasets through Azure Synapse Analytics.",
          "Used Azure DevOps for release automation.",
          "Built Azure Data Factory pipelines and stored curated data in ADLS Gen2.",
        ],
      },
      {
        title: "Data Engineer",
        company: "Microgate Technologies",
        dates: "2018 – 2021",
        bullets: ["Loaded transformed data into Snowflake with Python and Spark.", "Automated deployment with Jenkins."],
      },
    ],
    education: ["M.S., Example University — 2018"],
  };
}

function cover(paragraph: string): CoverLetterContent {
  return {
    name: "Candidate",
    location: "Chicago, IL",
    phone: "555-0100",
    email: "candidate@example.com",
    salutation: "Dear Hiring Manager,",
    paragraphs: [paragraph],
    closing: "Sincerely,",
  };
}

function review(paragraph: string) {
  return evaluateCrossDocumentConsistency(resume(), cover(paragraph));
}

test("binds Synapse and Snowflake to their own employer clauses", () => {
  assert.equal(
    review("At Fiserv, he delivered curated datasets through Azure Synapse Analytics, while earlier at Microgate Technologies he loaded batch data into Snowflake.").status,
    "PASS"
  );
});

test("binds Azure DevOps and Jenkins to their own employer clauses", () => {
  assert.equal(review("At Fiserv he used Azure DevOps, whereas at Microgate Technologies he used Jenkins.").status, "PASS");
});

test("keeps two employer clauses separate within one sentence", () => {
  const result = review("At Fiserv he served data from Azure Synapse Analytics and at Microgate Technologies he loaded Snowflake.");
  assert.deepEqual(result.employerScopedContradictions, []);
});

test("does not turn contrast-only AWS into a candidate or employer claim", () => {
  const result = review("At Fiserv, his cloud work was on Azure rather than AWS.");
  assert.equal(result.status, "PASS");
  assert.ok(!result.contradictions.some((item) => item.includes("AWS")));
});

test("accepts generic Azure when the employer has named Azure-service evidence", () => {
  assert.equal(review("At Fiserv, he worked across Azure data platforms.").status, "PASS");
});

test("does not treat target team or role-title technology text as a candidate claim", () => {
  const result = review("I would welcome the chance to contribute to the Identity and Access Management Data team. I am applying for the AWS Engineer role.");
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.generalContradictions, []);
});

test("fails Snowflake explicitly attributed to unsupported Fiserv", () => {
  const result = review("At Fiserv, he built Snowflake pipelines.");
  assert.equal(result.status, "FAIL");
  assert.ok(result.employerScopedContradictions.some((item) => item.includes('"Snowflake" to Fiserv')));
});

test("fails Synapse explicitly attributed to unsupported Microgate", () => {
  const result = review("At Microgate Technologies, he used Azure Synapse Analytics.");
  assert.equal(result.status, "FAIL");
  assert.ok(result.employerScopedContradictions.some((item) => item.includes('"Azure Synapse Analytics" to Microgate Technologies')));
});

test("fails an unsupported technology in a single-employer clause", () => {
  assert.equal(review("At Fiserv, he deployed workloads with Kubernetes.").status, "FAIL");
});

test("preserves strict employer evidence despite resume-wide evidence elsewhere", () => {
  const result = review("At Fiserv, he automated deployment with Jenkins.");
  assert.equal(result.status, "FAIL");
  assert.ok(result.employerScopedContradictions.some((item) => item.includes('"Jenkins" to Fiserv')));
});

test("supports semicolon-separated employer clauses", () => {
  assert.equal(review("At Fiserv he used Azure Synapse Analytics; at Microgate Technologies he used Snowflake.").status, "PASS");
});

test("supports an Earlier at employer switch", () => {
  assert.equal(review("At Fiserv he used Azure DevOps; Earlier at Microgate Technologies he used Jenkins.").status, "PASS");
});

test("accepts multiple technologies evidenced at the same employer", () => {
  assert.equal(review("At Fiserv he built Azure Data Factory pipelines into ADLS Gen2 and served data through Azure Synapse Analytics.").status, "PASS");
});

test("preserves fail-closed general checking when no employer is named", () => {
  const result = review("He built production workloads on Kubernetes.");
  assert.equal(result.status, "FAIL");
  assert.ok(result.generalContradictions.some((item) => item.includes('claims "Kubernetes"')));
});

test("handles the supported not, instead of, and without negation forms", () => {
  const result = review("At Fiserv he used Azure, not AWS, instead of GCP, and without Kubernetes.");
  assert.equal(result.status, "PASS");
});
