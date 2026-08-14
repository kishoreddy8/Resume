import assert from "node:assert/strict";
import { test } from "node:test";
import type { CandidateProfile } from "@/lib/match/types";
import type { ResumeContent } from "../../../../../tools/tailoring-engine/types";
import { evaluateTruthfulness } from "../truthfulnessChecks";

function baseMasterProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "r", skills: "s" },
    builtAt: "2026-01-01T00:00:00Z",
    skills: [],
    experience: [{ employer: "Acme Corp", title: "Senior Data Engineer", startDate: "2020-01", endDate: "2023-06", technologies: [] }],
    education: [{ level: "Bachelor's", field: "Computer Science", institution: "State University" }],
    certifications: [{ name: "AWS Certified Solutions Architect" }],
    totalYearsExperience: 5,
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
    summary: ["Data engineer."],
    skillGroups: [{ label: "Core", items: ["Azure"] }],
    experience: [{ title: "Senior Data Engineer", company: "Acme Corp", dates: "2020 - 2023", bullets: ["Built pipelines."] }],
    education: ["B.S. Computer Science, State University"],
    certifications: ["AWS Certified Solutions Architect"],
    ...overrides,
  };
}

test("6. employer mismatch: resume claims an employer absent from the Master Resume -> blocking issue", () => {
  const resume = baseResume({ experience: [{ title: "Senior Data Engineer", company: "Fabricated Inc", dates: "2020 - 2023", bullets: ["Built pipelines."] }] });
  const result = evaluateTruthfulness(resume, baseMasterProfile());
  assert.ok(result.blockingIssues.some((i) => i.includes("Fabricated Inc")));
  assert.ok(result.truthfulnessScore < 100);
});

test("7. title mismatch: resume title shares no wording with Master Resume's title for the same employer -> flagged (not necessarily blocking)", () => {
  const resume = baseResume({ experience: [{ title: "Chief Marketing Officer", company: "Acme Corp", dates: "2020 - 2023", bullets: ["Built pipelines."] }] });
  const result = evaluateTruthfulness(resume, baseMasterProfile());
  assert.ok(result.truthfulnessIssues.some((i) => i.includes("Chief Marketing Officer")));
});

test("8. date mismatch: resume year doesn't match Master Resume's recorded years for that employer -> flagged", () => {
  const resume = baseResume({ experience: [{ title: "Senior Data Engineer", company: "Acme Corp", dates: "2015 - 2016", bullets: ["Built pipelines."] }] });
  const result = evaluateTruthfulness(resume, baseMasterProfile());
  assert.ok(result.truthfulnessIssues.some((i) => i.includes("2015")));
});

test("9. education mismatch: resume claims an institution/degree with no Master Resume evidence -> flagged", () => {
  const resume = baseResume({ education: ["PhD in Astrophysics, Nowhere University"] });
  const result = evaluateTruthfulness(resume, baseMasterProfile());
  assert.ok(result.truthfulnessIssues.some((i) => i.includes("Nowhere University") || i.includes("PhD in Astrophysics")));
});

test("10. certification mismatch: resume claims a certification absent from the Master Resume -> blocking issue", () => {
  const resume = baseResume({ certifications: ["Certified Kubernetes Administrator"] });
  const result = evaluateTruthfulness(resume, baseMasterProfile());
  assert.ok(result.blockingIssues.some((i) => i.includes("Certified Kubernetes Administrator")));
});

test("11. valid Master Resume facts are preserved — a fully consistent resume produces zero truthfulness issues and a perfect score", () => {
  const result = evaluateTruthfulness(baseResume(), baseMasterProfile());
  assert.deepEqual(result.blockingIssues, []);
  assert.deepEqual(result.truthfulnessIssues, []);
  assert.equal(result.truthfulnessScore, 100);
});

test("employer match tolerates minor naming variance (containment match, e.g. 'Acme' vs 'Acme Corp')", () => {
  const resume = baseResume({ experience: [{ title: "Senior Data Engineer", company: "Acme", dates: "2020 - 2023", bullets: ["Built pipelines."] }] });
  const result = evaluateTruthfulness(resume, baseMasterProfile());
  assert.ok(!result.blockingIssues.some((i) => i.includes("Acme")), "a shortened but clearly-matching employer name must not be flagged as fabricated");
});

test("without a Master Resume profile, truthfulness is never claimed as a perfect verified 100", () => {
  const result = evaluateTruthfulness(baseResume(), undefined);
  assert.equal(result.insufficientProfileData, true);
  assert.notEqual(result.truthfulnessScore, 100);
  assert.ok(result.truthfulnessIssues.length > 0, "the limitation itself must be surfaced, not silently ignored");
});

test("repeated exact metric across different employers is flagged as review-required, never definitively false", () => {
  const resume = baseResume({
    experience: [
      { title: "Senior Data Engineer", company: "Acme Corp", dates: "2020 - 2023", bullets: ["Improved throughput by 40%."] },
      { title: "Data Engineer", company: "Beta LLC", dates: "2018 - 2020", bullets: ["Reduced latency by 40%."] },
    ],
  });
  const master = baseMasterProfile({
    experience: [
      { employer: "Acme Corp", title: "Senior Data Engineer", startDate: "2020-01", endDate: "2023-06", technologies: [] },
      { employer: "Beta LLC", title: "Data Engineer", startDate: "2018-01", endDate: "2020-01", technologies: [] },
    ],
  });
  const result = evaluateTruthfulness(resume, master);
  assert.ok(result.truthfulnessIssues.some((i) => i.includes("40%")));
  assert.ok(!result.blockingIssues.some((i) => i.includes("40%")), "a repeated metric is a review flag, never a hard blocking fabrication claim");
});

test("missingImpactEvidence flags an outcome claim with zero supporting number", () => {
  const resume = baseResume({ experience: [{ title: "Senior Data Engineer", company: "Acme Corp", dates: "2020 - 2023", bullets: ["Improved system performance significantly."] }] });
  const result = evaluateTruthfulness(resume, baseMasterProfile());
  assert.ok(result.missingImpactEvidence.some((b) => b.includes("Improved system performance")));
});

test("truthfulnessScore stays within 0-100 bounds", () => {
  const resume = baseResume({
    experience: [{ title: "CEO", company: "Totally Fake Co", dates: "1999", bullets: ["x"] }],
    education: ["Fake Degree"],
    certifications: ["Fake Cert 1", "Fake Cert 2", "Fake Cert 3"],
  });
  const result = evaluateTruthfulness(resume, baseMasterProfile());
  assert.ok(result.truthfulnessScore >= 0 && result.truthfulnessScore <= 100);
});
