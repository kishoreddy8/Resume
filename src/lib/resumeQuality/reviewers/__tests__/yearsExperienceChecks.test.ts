import assert from "node:assert/strict";
import { test } from "node:test";
import type { CandidateProfile } from "@/lib/match/types";
import type { ResumeContent } from "../../../../../tools/tailoring-engine/types";
import { evaluateYearsExperienceAndEducationHonesty } from "../yearsExperienceChecks";

const PINNED_NOW = new Date("2026-08-21T00:00:00Z");

function profile(totalYearsExperience: number | null): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "resume", skills: "skills" },
    builtAt: PINNED_NOW.toISOString(),
    skills: [],
    experience: [
      { employer: "Comerica Bank", title: "Data Engineer", startDate: "2025-02", endDate: null, technologies: [] },
      { employer: "Fiserv", title: "Data Engineer", startDate: "2023-07", endDate: "2025-01", technologies: [] },
      { employer: "Microgate Technologies", title: "Data Engineer", startDate: "2020-01", endDate: "2021-11", technologies: [] },
    ],
    education: [],
    certifications: [],
    totalYearsExperience,
  };
}

function resumeWithClaim(years: number): ResumeContent {
  return {
    name: "Candidate",
    tagline: "Data Engineer",
    location: "Dallas, TX",
    phone: "312-555-9821",
    email: "candidate@gmail.com",
    summary: [`Data Engineer with ${years} years of experience building production data platforms.`],
    skillGroups: [],
    experience: [],
    education: [],
  };
}

test("authoritative total 6 controls over derived 4.9 and permits a 6-year claim", () => {
  const result = evaluateYearsExperienceAndEducationHonesty(resumeWithClaim(6), profile(6), PINNED_NOW);
  assert.deepEqual(result.inflationIssues, []);
});

test("authoritative total 6 is a hard ceiling and rejects a 7-year claim", () => {
  const result = evaluateYearsExperienceAndEducationHonesty(resumeWithClaim(7), profile(6), PINNED_NOW);
  assert.equal(result.inflationIssues.length, 1);
  assert.match(result.inflationIssues[0], /explicitly supports 6 years/);
});

test("without an authoritative total, pinned chronology derives 4.9 and rejects 6", () => {
  const result = evaluateYearsExperienceAndEducationHonesty(resumeWithClaim(6), profile(null), PINNED_NOW);
  assert.equal(result.inflationIssues.length, 1);
  assert.match(result.inflationIssues[0], /~4\.9 years/);
  assert.doesNotMatch(result.inflationIssues[0], /~4 years/);
});

test("derived chronology retains the existing rounding tolerance for a 5-year claim", () => {
  const result = evaluateYearsExperienceAndEducationHonesty(resumeWithClaim(5), profile(null), PINNED_NOW);
  assert.deepEqual(result.inflationIssues, []);
});

test("derived fallback keeps gap and overlap union behavior with Present pinned", () => {
  const overlapping = profile(null);
  overlapping.experience.push({
    employer: "Concurrent Client",
    title: "Consultant",
    startDate: "2024-01",
    endDate: "2024-12",
    technologies: [],
  });
  const result = evaluateYearsExperienceAndEducationHonesty(resumeWithClaim(6), overlapping, PINNED_NOW);
  assert.equal(result.inflationIssues.length, 1);
  assert.match(result.inflationIssues[0], /~4\.9 years/);
});
