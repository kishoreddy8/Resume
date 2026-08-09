import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { JobSkill } from "@/types";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { evaluateJobMatch, type EvaluateJobMatchInput } from "../evaluateJobMatch";

/**
 * Full-pipeline integration tests, replicating the four worked examples from Phase 2's approved
 * plan (Revision 4): A = READY_FOR_TAILORING, B = technically strong but BLOCKED, C = score >= 80
 * but NEEDS_REVIEW on an unresolved critical requirement, D = broad inventory-only match that the
 * employer-evidenced-share gate stops from becoming READY on score/coverage alone.
 *
 * Uses a real (temp, isolated) candidate-profile.json via CAREER_OPS_MASTER_DIR — no mocking of the
 * matching engine itself.
 */

let tmpDir: string;
const HASH_R = crypto.createHash("sha256").update("resume").digest("hex");
const HASH_S = crypto.createHash("sha256").update("skills").digest("hex");

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cop-evaluate-"));
  process.env.CAREER_OPS_MASTER_DIR = tmpDir;
});
after(() => {
  delete process.env.CAREER_OPS_MASTER_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f));
});

function writeManifestAndProfile(profileOverrides: Record<string, unknown> = {}) {
  fs.writeFileSync(
    path.join(tmpDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: HASH_R },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: HASH_S },
    })
  );
  fs.writeFileSync(
    path.join(tmpDir, "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: HASH_R, skills: HASH_S },
      builtAt: "2026-01-01T00:00:00Z",
      skills: [],
      experience: [],
      education: [],
      certifications: [],
      totalYearsExperience: null,
      ...profileOverrides,
    })
  );
}

function skill(overrides: Partial<JobSkill>): JobSkill {
  return {
    id: Math.random(),
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

function baseInput(overrides: Partial<EvaluateJobMatchInput>): EvaluateJobMatchInput {
  return {
    jobId: 1,
    dedupeKey: "greenhouse:1:ext-1",
    jobTitle: "Senior Data Engineer",
    descriptionText: "Full job description text goes here.",
    descriptionSections: null,
    skills: [],
    certifications: [],
    education: { level: null, field: null, requirement: "Unknown", equivalentExperienceAllowed: false, evidence: null },
    sponsorshipPolarity: "none",
    companyH1bConfidence: "Unknown",
    clearanceRequired: "Not Required",
    clearanceLevel: null,
    citizenshipRequired: "Not Required",
    workAuthorizationRequired: "Not Required",
    jobSeniority: "Senior",
    experienceMinYears: 5,
    ...overrides,
  };
}

const requiresSponsorship = { ...DEFAULT_SETTINGS.candidate, requiresSponsorship: true };

test("missing candidate profile -> 'unavailable', never a decision, never READY_FOR_TAILORING", () => {
  // no manifest/profile written
  const result = evaluateJobMatch(baseInput({}), requiresSponsorship);
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.equal(result.reason, "missing_candidate_profile");
});

test("stale candidate profile (master files re-uploaded since) -> 'unavailable', never a decision", () => {
  writeManifestAndProfile({ sourceHashes: { resume: "old-hash", skills: HASH_S } });
  const result = evaluateJobMatch(baseInput({}), requiresSponsorship);
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.equal(result.reason, "stale_candidate_profile");
});

test("Example A — strong employer-evidenced match -> READY_FOR_TAILORING", () => {
  writeManifestAndProfile({
    skills: [
      { rawSkillName: "Azure Data Factory", source: "employer", attributedTo: [{ employer: "Acme" }] },
      { rawSkillName: "Databricks", source: "employer", attributedTo: [{ employer: "Acme" }] },
      { rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme" }] },
      { rawSkillName: "SQL", source: "employer", attributedTo: [{ employer: "Acme" }] },
      { rawSkillName: "Kubernetes", source: "inventory_only" },
      { rawSkillName: "Azure", source: "employer", attributedTo: [{ employer: "Acme" }] },
      { rawSkillName: "Power BI", source: "inventory_only" },
      { rawSkillName: "dbt", source: "inventory_only" },
    ],
    experience: [{ employer: "Acme", title: "Senior Data Engineer", startDate: "2019-01", endDate: null, technologies: [] }],
  });

  const input = baseInput({
    skills: [
      skill({ id: 1, skill_name: "Azure Data Factory", evidence_snippet: "Must have Azure Data Factory experience" }),
      skill({ id: 2, skill_name: "Databricks", evidence_snippet: "Must have Databricks experience" }),
      skill({ id: 3, skill_name: "Python", evidence_snippet: "Python required" }),
      skill({ id: 4, skill_name: "SQL", evidence_snippet: "SQL required" }),
      skill({ id: 5, skill_name: "Kubernetes", evidence_snippet: "Kubernetes required" }),
      skill({ id: 6, skill_name: "AWS", alternative_group_id: "alt-1", evidence_snippet: "AWS or Azure required" }),
      skill({ id: 7, skill_name: "Azure", alternative_group_id: "alt-1", evidence_snippet: "AWS or Azure required" }),
      skill({ id: 8, skill_name: "Terraform", requirement_level: "Preferred", evidence_snippet: "Terraform preferred" }),
      skill({ id: 9, skill_name: "Power BI", requirement_level: "Preferred", evidence_snippet: "Power BI preferred" }),
      skill({ id: 10, skill_name: "dbt", requirement_level: "Preferred", evidence_snippet: "dbt preferred" }),
    ],
    sponsorshipPolarity: "positive",
  });

  const result = evaluateJobMatch(input, requiresSponsorship);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.data.eligibility.status, "PASS");
  assert.equal(result.data.criticalGaps.length, 0);
  assert.ok(result.data.overallScore >= 80, `expected score >= 80, got ${result.data.overallScore}`);
  assert.equal(result.data.decision, "READY_FOR_TAILORING");
  assert.deepEqual(result.data.blockingReasons, []);
});

test("Example B — technically excellent but BLOCKED on explicit no-sponsorship", () => {
  writeManifestAndProfile({
    skills: [
      { rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme" }] },
      { rawSkillName: "SQL", source: "employer", attributedTo: [{ employer: "Acme" }] },
    ],
    experience: [{ employer: "Acme", title: "Senior Data Engineer", startDate: "2018-01", endDate: null, technologies: [] }],
  });
  const input = baseInput({
    skills: [skill({ id: 1, skill_name: "Python" }), skill({ id: 2, skill_name: "SQL" })],
    sponsorshipPolarity: "negative",
  });
  const result = evaluateJobMatch(input, requiresSponsorship);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.data.eligibility.status, "BLOCKED");
  assert.equal(result.data.decision, "BLOCKED");
  assert.ok(result.data.overallScore > 0, "score is still computed/displayed for transparency even though the decision is BLOCKED");
});

test("Example C — score >= 80 but NEEDS_REVIEW due to an unresolved critical requirement", () => {
  writeManifestAndProfile({
    skills: [
      { rawSkillName: "Azure Data Factory", source: "employer", attributedTo: [{ employer: "Acme" }] },
      { rawSkillName: "Databricks", source: "employer", attributedTo: [{ employer: "Acme" }] },
      { rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme" }] },
      { rawSkillName: "SQL", source: "inventory_only" },
      { rawSkillName: "Power BI", source: "inventory_only" },
      { rawSkillName: "Terraform", source: "inventory_only" },
      { rawSkillName: "dbt", source: "employer", attributedTo: [{ employer: "Acme" }] },
    ],
    experience: [{ employer: "Acme", title: "Senior Data Engineer", startDate: "2019-01", endDate: null, technologies: [] }],
  });
  const input = baseInput({
    skills: [
      skill({ id: 1, skill_name: "Azure Data Factory", evidence_snippet: "Must have Azure Data Factory experience" }),
      skill({ id: 2, skill_name: "Databricks", evidence_snippet: "Must have Databricks experience" }),
      skill({ id: 3, skill_name: "Python", evidence_snippet: "Python required" }),
      skill({ id: 4, skill_name: "SQL", evidence_snippet: "SQL required" }),
      skill({ id: 5, skill_name: "Power BI", requirement_level: "Preferred", evidence_snippet: "Power BI preferred" }),
      skill({ id: 6, skill_name: "Terraform", requirement_level: "Preferred", evidence_snippet: "Terraform preferred" }),
      skill({ id: 7, skill_name: "dbt", requirement_level: "Preferred", evidence_snippet: "dbt preferred" }),
    ],
    descriptionSections: {
      qualifications: "Experience with modern data mesh architecture practices across teams is a must have",
      niceToHave: undefined,
    } as unknown as EvaluateJobMatchInput["descriptionSections"],
  });
  const result = evaluateJobMatch(input, requiresSponsorship);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.data.unresolvedRequirements.length, 1, "the data-mesh line must surface as a genuine UNRESOLVED unit, not be hand-waved");
  assert.equal(result.data.criticalGaps.length, 1, "the unresolved line must be CRITICAL (it carries a 'must have' cue)");
  assert.equal(result.data.decision, "NEEDS_REVIEW");
  assert.ok(result.data.blockingReasons.some((r) => r.includes("critical requirement")));
});

test("Example D — broad inventory-only required-skill match cannot manufacture READY_FOR_TAILORING", () => {
  writeManifestAndProfile({
    skills: [
      { rawSkillName: "Azure Data Factory", source: "inventory_only" },
      { rawSkillName: "Databricks", source: "inventory_only" },
      { rawSkillName: "Python", source: "inventory_only" },
      { rawSkillName: "SQL", source: "inventory_only" },
      { rawSkillName: "Kubernetes", source: "inventory_only" },
      { rawSkillName: "Azure", source: "inventory_only" },
      { rawSkillName: "Power BI", source: "employer", attributedTo: [{ employer: "Acme" }] },
      { rawSkillName: "dbt", source: "employer", attributedTo: [{ employer: "Acme" }] },
    ],
    experience: [{ employer: "Acme", title: "Senior Data Engineer", startDate: "2016-01", endDate: null, technologies: [] }],
  });
  const input = baseInput({
    skills: [
      skill({ id: 1, skill_name: "Azure Data Factory", evidence_snippet: "Azure Data Factory required" }),
      skill({ id: 2, skill_name: "Databricks", evidence_snippet: "Databricks required" }),
      skill({ id: 3, skill_name: "Python", evidence_snippet: "Python required" }),
      skill({ id: 4, skill_name: "SQL", evidence_snippet: "SQL required" }),
      skill({ id: 5, skill_name: "Kubernetes", evidence_snippet: "Kubernetes required" }),
      skill({ id: 6, skill_name: "AWS", alternative_group_id: "alt-1", evidence_snippet: "AWS or Azure required" }),
      skill({ id: 7, skill_name: "Azure", alternative_group_id: "alt-1", evidence_snippet: "AWS or Azure required" }),
      skill({ id: 8, skill_name: "Power BI", requirement_level: "Preferred", evidence_snippet: "Power BI preferred" }),
      skill({ id: 9, skill_name: "dbt", requirement_level: "Preferred", evidence_snippet: "dbt preferred" }),
    ],
  });
  const result = evaluateJobMatch(input, requiresSponsorship);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.data.employerEvidencedShare, 0, "every required-skill match came from inventory-only evidence");
  assert.equal(result.data.decision, "NEEDS_REVIEW", "the employer-evidenced-share gate must withhold readiness even if score/coverage alone would pass");
  assert.ok(result.data.blockingReasons.some((r) => r.includes("employer-attributed")));
});

test("cache-key stability: identical input twice produces identical hashes/keys", () => {
  writeManifestAndProfile({ skills: [{ rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme" }] }] });
  const input = baseInput({ skills: [skill({ id: 1, skill_name: "Python" })] });
  const r1 = evaluateJobMatch(input, requiresSponsorship);
  const r2 = evaluateJobMatch(input, requiresSponsorship);
  assert.equal(r1.status, "ok");
  assert.equal(r2.status, "ok");
  if (r1.status === "ok" && r2.status === "ok") {
    assert.equal(r1.data.jdContentHash, r2.data.jdContentHash);
    assert.equal(r1.data.matchKnowledgeHash, r2.data.matchKnowledgeHash);
    assert.equal(r1.data.candidateProfileHash, r2.data.candidateProfileHash);
    assert.equal(r1.data.candidateSettingsHash, r2.data.candidateSettingsHash);
  }
});

test("cache-key sensitivity: a JD text change produces a different jdContentHash", () => {
  writeManifestAndProfile({ skills: [{ rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme" }] }] });
  const r1 = evaluateJobMatch(baseInput({ descriptionText: "Version one of the JD" }), requiresSponsorship);
  const r2 = evaluateJobMatch(baseInput({ descriptionText: "Version two of the JD, edited" }), requiresSponsorship);
  assert.equal(r1.status, "ok");
  assert.equal(r2.status, "ok");
  if (r1.status === "ok" && r2.status === "ok") assert.notEqual(r1.data.jdContentHash, r2.data.jdContentHash);
});

test("cache-key sensitivity: a candidate settings change (e.g. requiresSponsorship) produces a different candidateSettingsHash", () => {
  writeManifestAndProfile({});
  const r1 = evaluateJobMatch(baseInput({}), requiresSponsorship);
  const r2 = evaluateJobMatch(baseInput({}), { ...requiresSponsorship, requiresSponsorship: false });
  assert.equal(r1.status, "ok");
  assert.equal(r2.status, "ok");
  if (r1.status === "ok" && r2.status === "ok") assert.notEqual(r1.data.candidateSettingsHash, r2.data.candidateSettingsHash);
});

test("cache-key sensitivity: a candidate profile change (different resume/skills upload) produces a different candidateProfileHash", () => {
  writeManifestAndProfile({});
  const r1 = evaluateJobMatch(baseInput({}), requiresSponsorship);

  fs.writeFileSync(
    path.join(tmpDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-02-01T00:00:00Z", sizeBytes: 20, sha256: "new-resume-hash" },
      skills: { filename: "skills.docx", uploadedAt: "2026-02-01T00:00:00Z", sizeBytes: 20, sha256: HASH_S },
    })
  );
  fs.writeFileSync(
    path.join(tmpDir, "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: "new-resume-hash", skills: HASH_S },
      builtAt: "2026-02-01T00:00:00Z",
      skills: [],
      experience: [],
      education: [],
      certifications: [],
      totalYearsExperience: null,
    })
  );
  const r2 = evaluateJobMatch(baseInput({}), requiresSponsorship);
  assert.equal(r1.status, "ok");
  assert.equal(r2.status, "ok");
  if (r1.status === "ok" && r2.status === "ok") assert.notEqual(r1.data.candidateProfileHash, r2.data.candidateProfileHash);
});

test("only JD-side requirements ever appear in the score: a large unrelated Master Skills Inventory never inflates required/preferred coverage", () => {
  writeManifestAndProfile({
    skills: [
      { rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme" }] },
      { rawSkillName: "COBOL", source: "inventory_only" },
      { rawSkillName: "Photoshop", source: "inventory_only" },
      { rawSkillName: "Excel", source: "inventory_only" },
      { rawSkillName: "PHP", source: "inventory_only" },
    ],
  });
  const input = baseInput({ skills: [skill({ id: 1, skill_name: "Python" })], experienceMinYears: null, jobSeniority: "Unknown" });
  const result = evaluateJobMatch(input, requiresSponsorship);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.data.dimensionScores.required, 100, "only the one JD-required Python unit contributes — the unrelated inventory skills are invisible to scoring");
});
