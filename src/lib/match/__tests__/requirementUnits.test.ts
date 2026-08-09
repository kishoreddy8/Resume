import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobCertification, JobSkill } from "@/types";
import { buildCertificationUnits, buildEducationUnit, collapseSkillUnits } from "../requirementUnits";

function skill(overrides: Partial<JobSkill>): JobSkill {
  return {
    id: 1,
    job_id: 1,
    skill_name: "Python",
    category: "Programming Languages",
    requirement_level: "Required",
    alternative_group_id: null,
    evidence_snippet: "Python required",
    created_at: "",
    ...overrides,
  };
}

test("ungrouped skills each become their own unit", () => {
  const units = collapseSkillUnits([skill({ skill_name: "Python" }), skill({ skill_name: "SQL", id: 2 })], "Data Engineer");
  assert.equal(units.length, 2);
  assert.deepEqual(
    units.map((u) => u.memberSkillNames),
    [["Python"], ["SQL"]]
  );
});

test("OR-alternative group collapses into ONE unit, satisfied by any member", () => {
  const units = collapseSkillUnits(
    [
      skill({ id: 1, skill_name: "AWS", alternative_group_id: "alt-1", evidence_snippet: "AWS or Azure required" }),
      skill({ id: 2, skill_name: "Azure", alternative_group_id: "alt-1", evidence_snippet: "AWS or Azure required" }),
    ],
    "Cloud Engineer"
  );
  assert.equal(units.length, 1, "an alternation group must never be split back into per-member units");
  assert.equal(units[0].kind, "skill_group");
  assert.deepEqual(units[0].memberSkillNames.sort(), ["AWS", "Azure"]);
  assert.equal(units[0].label, "AWS OR Azure");
});

test("criticality: title mention promotes a Required skill to CRITICAL", () => {
  const units = collapseSkillUnits([skill({ skill_name: "Kubernetes", evidence_snippet: "Kubernetes experience needed" })], "Senior Kubernetes Engineer");
  assert.equal(units[0].criticality, "CRITICAL");
});

test("criticality: an explicit non-negotiable cue promotes to CRITICAL", () => {
  const units = collapseSkillUnits([skill({ skill_name: "Terraform", evidence_snippet: "Must have Terraform experience — non-negotiable" })], "Platform Engineer");
  assert.equal(units[0].criticality, "CRITICAL");
});

test("criticality: an ordinary Required skill with no promotion cue stays REQUIRED", () => {
  const units = collapseSkillUnits([skill({ skill_name: "SQL", evidence_snippet: "SQL required" })], "Data Engineer");
  assert.equal(units[0].criticality, "REQUIRED");
});

test("criticality: Preferred is never promoted to CRITICAL even with a non-negotiable cue", () => {
  const units = collapseSkillUnits(
    [skill({ skill_name: "Kafka", requirement_level: "Preferred", evidence_snippet: "Must have Kafka — non-negotiable" })],
    "Kafka Engineer"
  );
  assert.equal(units[0].criticality, "PREFERRED");
});

test("hands-on cue flags experienceDepthRequired", () => {
  const units = collapseSkillUnits([skill({ skill_name: "Airflow", evidence_snippet: "Hands-on production experience with Airflow" })], "Data Engineer");
  assert.equal(units[0].experienceDepthRequired, true);
});

function cert(overrides: Partial<JobCertification>): JobCertification {
  return { id: 1, job_id: 1, name: "AWS Certified Solutions Architect", requirement_level: "Required", evidence_snippet: "must hold AWS Certified Solutions Architect", created_at: "", ...overrides };
}

test("certification units are built from job_certifications rows", () => {
  const units = buildCertificationUnits([cert({})], "Cloud Architect");
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, "certification");
  assert.equal(units[0].label, "AWS Certified Solutions Architect");
});

test("education unit is null when no degree was extracted (never fabricated)", () => {
  assert.equal(buildEducationUnit({ level: null, field: null, requirement: "Unknown", equivalentExperienceAllowed: false, evidence: null }), null);
});

test("education unit is null when requirement level is Unknown even if a degree level was named", () => {
  assert.equal(
    buildEducationUnit({ level: "Bachelor's", field: "Computer Science", requirement: "Unknown", equivalentExperienceAllowed: false, evidence: "Bachelor's in CS" }),
    null
  );
});

test("education unit criticality is capped at REQUIRED when equivalent experience is allowed, never CRITICAL", () => {
  const unit = buildEducationUnit({
    level: "Bachelor's",
    field: "Computer Science",
    requirement: "Required",
    equivalentExperienceAllowed: true,
    evidence: "Bachelor's degree in Computer Science or equivalent experience required — must have",
  });
  assert.ok(unit);
  assert.equal(unit?.criticality, "REQUIRED", "equivalent-experience-allowed must never gate as hard as CRITICAL");
});

test("education unit can still be promoted to CRITICAL when no equivalent-experience flexibility exists", () => {
  const unit = buildEducationUnit({
    level: "Master's",
    field: null,
    requirement: "Required",
    equivalentExperienceAllowed: false,
    evidence: "Master's degree is a mandatory requirement for this role",
  });
  assert.ok(unit);
  assert.equal(unit?.criticality, "CRITICAL");
});
