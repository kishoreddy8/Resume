import assert from "node:assert/strict";
import { test } from "node:test";
import { EXTRACTION_VERSION } from "@/lib/jobIntel/extractJobIntel";
import { extractSkills } from "@/lib/jobIntel/skills";
import type { DescriptionSections } from "@/types";
import { computeMatchKnowledgeHash, matchKnowledgeFingerprint } from "../matchKnowledgeHash";
import { collapseSkillUnits } from "../requirementUnits";
import { matchRequirementUnit } from "../skillMatching";
import { JOB_LEVEL_INCOMPATIBILITY, seniorityAlignmentScore } from "../seniority";
import type { CandidateProfile, NormalizedCandidateSkill } from "../types";

/**
 * Stage 24C — regression tests for the three defects the independent second audit pass found in the
 * Stage 24B checkpoint (d038d8c). Each test states the concrete wrong behaviour it locks out.
 */

// --- Defect 1: 3+ item OR lists were split into independent Required skills --------------------

function requiredSkillsFromLine(line: string) {
  const sections = {
    summary: null,
    responsibilities: null,
    qualifications: line,
    niceToHave: null,
    benefits: null,
    skills: null,
  } as unknown as DescriptionSections;
  return extractSkills({ descriptionText: null, descriptionHtml: null, sections });
}

/** Groups the extracted skills the way collapseSkillUnits will: one entry per requirement unit. */
function unitLabels(line: string): string[] {
  const skills = requiredSkillsFromLine(line).map((s, i) => ({
    id: i,
    job_id: 1,
    skill_name: s.skillName,
    category: s.category,
    requirement_level: s.requirementLevel,
    alternative_group_id: s.alternativeGroupId,
    evidence_snippet: s.evidenceSnippet,
  }));
  return collapseSkillUnits(skills as never, "Data Engineer").map((u) => u.label).sort();
}

test("Stage 24C: a three-item OR list is ONE alternative unit, not one required skill plus a pair", () => {
  // Before the fix this produced two units: "Databricks" (independent, Required) and
  // "Snowflake OR Redshift" — i.e. the candidate had to possess Databricks AND one of the others.
  assert.deepEqual(unitLabels("Experience with Databricks, Snowflake, or Redshift"), [
    "Databricks OR Snowflake OR Redshift",
  ]);
});

test("Stage 24C: a three-item OR list without an Oxford comma also collapses to one unit", () => {
  assert.deepEqual(unitLabels("Experience with Databricks, Snowflake or Redshift"), [
    "Databricks OR Snowflake OR Redshift",
  ]);
});

test("Stage 24C: a four-item OR list collapses to one unit", () => {
  assert.deepEqual(unitLabels("Experience with Airflow, Databricks, Snowflake, or Redshift"), [
    "Airflow OR Databricks OR Snowflake OR Redshift",
  ]);
});

test("Stage 24C: the previously-documented AWS/Azure/GCP example now behaves as documented", () => {
  assert.deepEqual(unitLabels("Experience with AWS, Azure, or GCP"), ["AWS OR Azure OR GCP"]);
});

test("Stage 24C: a plain AND list stays INDEPENDENT requirements — no alternation is invented", () => {
  const labels = unitLabels("Experience with Python, SQL, and Spark");
  assert.deepEqual(labels, ["Python", "SQL", "Spark"]);
  assert.ok(!labels.some((l) => l.includes(" OR ")), "a comma/and list must never become an OR group");
});

test("Stage 24C: a comma-only list stays independent (no explicit or/slash means no alternation)", () => {
  assert.ok(!unitLabels("Experience with Python, SQL, Spark").some((l) => l.includes(" OR ")));
});

test("Stage 24C: an AND list and an OR pair on one line keep their own semantics", () => {
  assert.deepEqual(unitLabels("Experience with Python, SQL, and AWS or Azure"), [
    "AWS OR Azure",
    "Python",
    "SQL",
  ]);
});

// --- Defect 1, consequence: possessing ONE alternative satisfies the whole unit ----------------

function profileWithSkills(): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "r", skills: "s" },
    builtAt: "2026-01-01T00:00:00Z",
    skills: [],
    experience: [],
    education: [],
    certifications: [],
    totalYearsExperience: null,
  };
}

test("Stage 24C: a candidate holding only Snowflake fully satisfies 'Databricks, Snowflake, or Redshift'", () => {
  const skills = requiredSkillsFromLine("Experience with Databricks, Snowflake, or Redshift").map((s, i) => ({
    id: i,
    job_id: 1,
    skill_name: s.skillName,
    category: s.category,
    requirement_level: s.requirementLevel,
    alternative_group_id: s.alternativeGroupId,
    evidence_snippet: s.evidenceSnippet,
  }));
  const units = collapseSkillUnits(skills as never, "Data Engineer");
  assert.equal(units.length, 1, "the whole list must be a single requirement unit");

  const normalized: NormalizedCandidateSkill[] = [
    {
      rawSkillName: "Snowflake",
      source: "employer",
      canonicalSkillName: "Snowflake",
      category: "Warehousing",
      attributedTo: [{ employer: "Acme" }],
    },
  ];
  const match = matchRequirementUnit(units[0], profileWithSkills(), normalized);
  assert.equal(match.matchType, "MATCHED");
  assert.equal(match.credit, 1, "an OR unit satisfied by one alternative earns full credit");
  assert.equal(match.evidence?.source, "employer");
});

// --- Defect 3: explicit Intern/Entry JD level was inapplicable, not a mismatch -----------------

test("Stage 24C: an Intern posting is a mismatch when tenure evidences the candidate is past it", () => {
  // Candidate seniority stays "Unknown" — the rule never claims a candidate level.
  assert.equal(seniorityAlignmentScore("Intern", "Unknown", 8.5), 0);
});

test("Stage 24C: an Entry posting is a weak match against multi-year evidenced tenure", () => {
  assert.equal(seniorityAlignmentScore("Entry", "Unknown", 8.5), 0.2);
});

test("Stage 24C: with NO tenure evidence the dimension stays inapplicable — no invented penalty", () => {
  assert.equal(seniorityAlignmentScore("Intern", "Unknown", null), null);
  assert.equal(seniorityAlignmentScore("Entry", "Unknown", null), null);
});

test("Stage 24C: tenure below the evidence threshold does NOT trigger the mismatch", () => {
  assert.equal(seniorityAlignmentScore("Intern", "Unknown", 0.5), null);
  assert.equal(seniorityAlignmentScore("Entry", "Unknown", 2), null);
});

test("Stage 24C: an explicit candidate level above Intern evidences the mismatch without tenure", () => {
  assert.equal(seniorityAlignmentScore("Intern", "Senior", null), 0);
  assert.equal(seniorityAlignmentScore("Entry", "Senior", null), 0.2);
});

test("Stage 24C: non-Intern/Entry job levels are completely unchanged by the new rule", () => {
  assert.equal(seniorityAlignmentScore("Senior", "Unknown", 8.5), null);
  assert.equal(seniorityAlignmentScore("Junior", "Unknown", 8.5), null);
  assert.equal(seniorityAlignmentScore("Unknown", "Senior", 8.5), null);
  assert.equal(seniorityAlignmentScore("Senior", "Senior", 8.5), 1);
  assert.equal(seniorityAlignmentScore("Senior", "Mid", 8.5), 0.6);
  assert.equal(seniorityAlignmentScore("Principal", "Mid", 8.5), 0.2);
});

test("Stage 24C: the incompatibility table stays a small, explicit, JD-level-only rule", () => {
  assert.deepEqual(
    JOB_LEVEL_INCOMPATIBILITY.map((r) => r.level),
    ["Intern", "Entry"],
    "only explicitly-stated junior JD levels participate — never an inferred candidate level"
  );
});

// --- Defect 2: a re-extraction that changed the requirement units never invalidated the cache ---

test("Stage 24C: the match cache identity includes the structured-extraction version", () => {
  // jdContentHash covers only title + description_text, and upsertJobIntel does not touch
  // jobs.updated_at, so without this an extractor fix (like Defect 1's) would leave every cached
  // job_match_results row reusable and never reach a single score.
  const fingerprint = matchKnowledgeFingerprint();
  assert.equal(
    fingerprint.extractionVersion,
    EXTRACTION_VERSION,
    "bumping EXTRACTION_VERSION must invalidate every cached match result"
  );
});

test("Stage 24C: the knowledge hash is deterministic across calls", () => {
  assert.equal(computeMatchKnowledgeHash(), computeMatchKnowledgeHash());
});

test("Stage 24C: role-alignment and seniority tunables remain inside the cache identity", () => {
  const fingerprint = matchKnowledgeFingerprint();
  assert.ok(fingerprint.roleAlignment, "role-alignment constants must stay in the fingerprint");
  assert.ok(fingerprint.jobLevelIncompatibility, "seniority incompatibility thresholds must stay in the fingerprint");
});
