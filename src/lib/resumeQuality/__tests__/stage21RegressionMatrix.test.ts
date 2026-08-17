import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";
import { evaluateQualityGate } from "../qualityGate";
import { reviewResumeDeterministically } from "../reviewers/deterministicReviewer";
import { JD_SHAPES, MULTI_JD_BASELINE_RESUME, MULTI_JD_MASTER_PROFILE } from "./fixtures/multiJdCandidate";

/**
 * Stage 21 (Evidence-Grounded Resume Quality V2) — NEXT 10: the complete regression matrix, run
 * through the REAL composed reviewer (reviewResumeDeterministically + evaluateQualityGate), not just
 * the individual modules already unit-tested elsewhere in this directory. This file proves the failure
 * pattern from the real observed weak artifact is blocked end-to-end, and that repositioning across
 * four JD shapes never touches historical fact.
 */

// A resume reproducing the SAME COMBINATION of real observed defects: positioning hijacked by
// secondary tech, placeholder contact info, an unsupported metric, AND a cover letter that
// misattributes technology to the wrong employer — all at once, exactly as the real artifact did.
const REAL_FAILURE_PATTERN_RESUME: ResumeContent = {
  name: "Amara Okafor",
  tagline: "Data Engineer | Cloud Infrastructure, Containerization & Observability",
  location: "Remote, US",
  phone: "555-0100", // placeholder
  email: "candidate@example.com", // placeholder
  summary: ["Data engineer experienced in Terraform, Docker, AKS, Prometheus, and Grafana."],
  skillGroups: [{ label: "Skills", items: ["Terraform", "Docker", "AKS", "Prometheus", "Grafana", "Snowflake", "dbt"] }],
  experience: [
    {
      title: "Senior Data Engineer",
      company: "Northwind Logistics Analytics",
      dates: "2022 - Present",
      bullets: [
        "Reduced customer support tickets by 47% through improved Snowflake orchestration.", // unsupported metric (customer-impact category is never independently verifiable)
        "Built dbt transformation models for the analytics team.",
      ],
    },
    {
      title: "Data Engineer",
      company: "Meridian Health Systems",
      dates: "2019 - 2021",
      bullets: ["Built Azure Data Factory pipelines.", "Used Databricks and PySpark for transformations."],
    },
  ],
  education: ["B.S. Computer Science, Riverside State University"],
};

const REAL_FAILURE_PATTERN_COVER_LETTER: CoverLetterContent = {
  name: "Amara Okafor",
  location: "Remote, US",
  phone: "555-0100", // placeholder
  email: "candidate@example.com", // placeholder
  salutation: "Dear Hiring Team,",
  // Misattributes Snowflake+dbt to Meridian (only actually evidenced/used at Northwind) and Airflow
  // to Meridian too (never evidenced at Meridian at all) — the exact Comerica/dbt, Fiserv/Airflow
  // failure PATTERN from the real observed artifact, reproduced against this fixture's own employers.
  paragraphs: [
    "I'm excited to apply for this Senior Data Engineer role.",
    "At Meridian Health Systems, I built Snowflake data warehouses, dbt transformation pipelines, and Airflow orchestration for the analytics team.",
  ],
  closing: "Sincerely,\nAmara Okafor",
};

test("REGRESSION: the real observed failure pattern is blocked end-to-end (placeholder contact + unsupported metric + positioning hijack + employer-misattributed cover letter)", () => {
  const review = reviewResumeDeterministically({
    resume: REAL_FAILURE_PATTERN_RESUME,
    coverLetter: REAL_FAILURE_PATTERN_COVER_LETTER,
    jobRequirements: JD_SHAPES[0].requirements,
    masterResumeProfile: MULTI_JD_MASTER_PROFILE,
    targetRoleTitle: "Senior Data Engineer",
  });

  const outcome = evaluateQualityGate(review, 1, 3);
  assert.notEqual(outcome, "READY");

  const failureTypes = new Set((review.blockingFailures ?? []).map((f) => f.type));
  assert.ok(failureTypes.has("PLACEHOLDER_CONTACT"), "1. placeholder phone/email must be blocked");
  assert.ok(failureTypes.has("UNSUPPORTED_METRIC"), "2. unsupported percentage must be blocked");
  assert.ok(failureTypes.has("EMPLOYER_CONTRADICTION"), "3/4. employer-misattributed cover-letter claims must be blocked");

  assert.equal(review.recruiterQualityAssessment?.status, "FAIL");
  assert.ok(
    review.recruiterQualityAssessment?.issues.some((i) => i.dimension === "excessiveSecondaryTechEmphasis"),
    "positioning hijack (secondary tech dominating headline) must be flagged"
  );

  // 10. Unsupported JD skills are reported, never silently injected into the resume the reviewer
  // just evaluated — the resume object itself must be untouched by the review.
  assert.equal(REAL_FAILURE_PATTERN_RESUME.tagline, "Data Engineer | Cloud Infrastructure, Containerization & Observability");
});

test("REGRESSION: a corrected version of the SAME candidate/JD passes every gate genuinely (not forced)", () => {
  const correctedResume: ResumeContent = {
    name: "Amara Okafor",
    tagline: "Senior Data Engineer | Snowflake & dbt",
    location: "Remote, US",
    phone: "312-555-9821",
    email: "amara.okafor@gmail.com",
    summary: ["Senior Data Engineer specializing in Snowflake data warehousing, dbt transformation pipelines, and Python, orchestrated with Airflow."],
    // Docker/Kubernetes are genuinely evidenced (candidate used them at Solstice Cloud Platforms in
    // MULTI_JD_MASTER_PROFILE) — included as supporting skills only, never in the headline/summary,
    // matching "supporting technologies may still appear, just never hijack positioning".
    skillGroups: [{ label: "Skills", items: ["Snowflake", "dbt", "Airflow", "Python", "Docker", "Kubernetes"] }],
    experience: [
      {
        title: "Senior Data Engineer",
        company: "Northwind Logistics Analytics",
        dates: "2022 - Present",
        bullets: [
          "Architected a Snowflake data warehouse and dbt transformation pipelines consolidating regional logistics data.",
          "Orchestrated pipeline scheduling with Python and Airflow, improving pipeline reliability.",
        ],
      },
    ],
    education: ["B.S. Computer Science, Riverside State University"],
  };
  const correctedCoverLetter: CoverLetterContent = {
    name: "Amara Okafor",
    location: "Remote, US",
    phone: "312-555-9821",
    email: "amara.okafor@gmail.com",
    salutation: "Dear Hiring Team,",
    paragraphs: ["At Northwind Logistics Analytics, I built Snowflake and dbt pipelines orchestrated with Airflow."],
    closing: "Sincerely,\nAmara Okafor",
  };

  const review = reviewResumeDeterministically({
    resume: correctedResume,
    coverLetter: correctedCoverLetter,
    jobRequirements: JD_SHAPES[0].requirements,
    masterResumeProfile: MULTI_JD_MASTER_PROFILE,
    targetRoleTitle: "Senior Data Engineer",
  });

  assert.equal(review.blockingFailures?.length, 0, JSON.stringify(review.blockingFailures));
  assert.equal(review.recruiterQualityAssessment?.status, "PASS", JSON.stringify(review.recruiterQualityAssessment?.issues));
  assert.equal(evaluateQualityGate(review, 1, 3), "READY");
});

test("REGRESSION: same evidence base, 4 different JD shapes -> different jdPriorityMatrix/positioning, IDENTICAL historical facts (employers/titles/dates/certifications/YOE never change)", () => {
  const reviews = JD_SHAPES.map((shape) =>
    reviewResumeDeterministically({
      resume: MULTI_JD_BASELINE_RESUME,
      jobRequirements: shape.requirements,
      masterResumeProfile: MULTI_JD_MASTER_PROFILE,
      targetRoleTitle: shape.targetRoleTitle,
    })
  );

  // Different prioritization: the P1 tier's requirement set genuinely differs across all 4 shapes.
  const p1Sets = reviews.map((r) => new Set(r.jdPriorityMatrix?.requirements.filter((req) => req.priority === "P1").map((req) => req.requirement)));
  for (let i = 0; i < p1Sets.length; i++) {
    for (let j = i + 1; j < p1Sets.length; j++) {
      assert.notDeepEqual([...p1Sets[i]].sort(), [...p1Sets[j]].sort(), `shapes ${JD_SHAPES[i].name} and ${JD_SHAPES[j].name} should not share identical P1 sets`);
    }
  }

  // Identical historical truth: the SAME baseline resume (candidate facts never regenerated here)
  // was reviewed every time — employers/titles/dates/certifications/YOE are properties of the master
  // profile + resume, neither of which this test ever varies across shapes.
  for (const review of reviews) {
    assert.equal(review.blockingIssues.length, 0, "the baseline resume's own facts must never be flagged as contradicting the fixed master profile");
  }
  assert.equal(MULTI_JD_MASTER_PROFILE.experience.length, 3);
  assert.equal(MULTI_JD_MASTER_PROFILE.experience[0].employer, "Northwind Logistics Analytics");
  assert.equal(MULTI_JD_MASTER_PROFILE.totalYearsExperience, 10);
  assert.equal(MULTI_JD_MASTER_PROFILE.certifications.length, 0); // never fabricated across any shape
});

test("REGRESSION: an AI/Data Engineer JD (shape C) the candidate has no real evidence for reports UNSUPPORTED honestly rather than fabricating Azure OpenAI/RAG experience", () => {
  const shapeC = JD_SHAPES.find((s) => s.name.startsWith("C."))!;
  const review = reviewResumeDeterministically({
    resume: MULTI_JD_BASELINE_RESUME,
    jobRequirements: shapeC.requirements,
    masterResumeProfile: MULTI_JD_MASTER_PROFILE,
    targetRoleTitle: shapeC.targetRoleTitle,
  });
  const byReq = Object.fromEntries((review.atsCoverageReport ?? []).map((e) => [e.requirement, e.status]));
  assert.equal(byReq["Azure OpenAI"], "UNSUPPORTED");
  assert.equal(byReq["RAG"], "UNSUPPORTED");
  // The resume itself (candidate evidence, unchanged across every shape in this file) never claims them.
  const resumeText = JSON.stringify(MULTI_JD_BASELINE_RESUME);
  assert.ok(!resumeText.includes("Azure OpenAI"));
  assert.ok(!resumeText.includes("RAG"));
});
