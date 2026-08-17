import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { JobSkill } from "@/types";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { rankForYou, type ForYouJobInput } from "@/lib/rank/forYou";
import { evaluateJobMatch, type EvaluateJobMatchInput } from "../evaluateJobMatch";
import type { JobMatchResult } from "../types";

/**
 * STAGE 24B REGRESSION MATRIX (Phase 18).
 *
 * End-to-end through the real deterministic engine — no mocks of scoring, eligibility or decisions —
 * against a temp, isolated candidate profile modelled on the real production candidate (a Data
 * Engineer with employer-attributed Azure/Databricks/PySpark/Snowflake/SQL/Python evidence and a
 * much broader inventory-only list).
 *
 * Every case below is a property the pre-Stage-24B engine either violated outright on the real
 * 19,665-job corpus or had no way to express at all.
 */

let tmpDir: string;
const HASH_R = crypto.createHash("sha256").update("resume").digest("hex");
const HASH_S = crypto.createHash("sha256").update("skills").digest("hex");

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cop-24b-"));
  process.env.CAREER_OPS_MASTER_DIR = tmpDir;
});
after(() => {
  delete process.env.CAREER_OPS_MASTER_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f));
  writeCandidate();
});

/** Employer-attributed = the Master Resume actually attributes it to a real role. Inventory-only =
 *  present in the Skills Inventory without employer attribution. Nothing here is invented for the
 *  candidate by any test: the JD side never writes into this list. */
const EMPLOYER_SKILLS = [
  "PySpark",
  "Azure Data Factory",
  "Azure Databricks",
  "Snowflake",
  "SQL",
  "Python",
  "ADLS Gen2",
  "Delta Lake",
  "Azure Synapse Analytics",
  "Azure DevOps",
  "Spark",
  "Power BI",
];
const INVENTORY_ONLY_SKILLS = ["Docker", "Kubernetes", "Airflow", "dbt", "AWS", "GCP", "Terraform", "Kafka"];

function writeCandidate(overrides: Record<string, unknown> = {}) {
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
      skills: [
        ...EMPLOYER_SKILLS.map((rawSkillName) => ({ rawSkillName, source: "employer", attributedTo: [{ employer: "Acme Bank" }] })),
        ...INVENTORY_ONLY_SKILLS.map((rawSkillName) => ({ rawSkillName, source: "inventory_only" })),
      ],
      experience: [
        { employer: "Acme Bank", title: "Data Engineer", startDate: "2019-01", endDate: null, technologies: [] },
      ],
      education: [{ level: "Master's", field: "Computer Science", institution: "Chicago State University" }],
      certifications: [{ name: "Microsoft Certified: Azure Data Engineer Associate (DP-203)" }],
      totalYearsExperience: null,
      ...overrides,
    })
  );
}

function skill(name: string, overrides: Partial<JobSkill> = {}): JobSkill {
  return {
    id: Math.floor(Math.random() * 1e9),
    job_id: 1,
    skill_name: name,
    category: "Data Engineering",
    requirement_level: "Required",
    alternative_group_id: null,
    evidence_snippet: `${name} required`,
    created_at: "",
    ...overrides,
  };
}

function input(overrides: Partial<EvaluateJobMatchInput>): EvaluateJobMatchInput {
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

const CANDIDATE = { ...DEFAULT_SETTINGS.candidate, requiresSponsorship: true };

function evaluate(overrides: Partial<EvaluateJobMatchInput>): JobMatchResult {
  const result = evaluateJobMatch(input(overrides), CANDIDATE, 1);
  assert.equal(result.status, "ok", "engine must produce a result for a valid profile");
  if (result.status !== "ok") throw new Error("unreachable");
  return result.data;
}

// --- 1. Strong Senior Data Engineer JD + strong candidate evidence --------------------------------

test("1. a strong Senior Data Engineer JD with employer-evidenced coverage scores high and is not blocked", () => {
  const result = evaluate({
    jobTitle: "Senior Data Engineer",
    skills: [
      skill("PySpark"),
      skill("Azure Data Factory"),
      skill("Snowflake"),
      skill("SQL"),
      skill("Python"),
      skill("Airflow", { requirement_level: "Preferred" }),
    ],
  });
  assert.equal(result.insufficientJdSignal, false);
  assert.equal(result.dimensionScores.roleAlignment, 100);
  assert.ok(result.overallScore >= 80, `expected a strong score, got ${result.overallScore}`);
  assert.notEqual(result.decision, "BLOCKED");
  assert.equal(result.decision, "READY_FOR_TAILORING");
});

// --- 2/3/4. Ecosystem-specific Data Engineer variants ---------------------------------------------

test("2. an Azure Databricks Data Engineer JD is driven by the candidate's Azure/Databricks/PySpark employer evidence", () => {
  const result = evaluate({
    jobTitle: "Azure Databricks Data Engineer",
    skills: [skill("Azure Databricks"), skill("PySpark"), skill("Azure Data Factory"), skill("Delta Lake")],
  });
  assert.equal(result.dimensionScores.roleAlignment, 100);
  assert.equal(result.employerEvidencedShare, 1);
  assert.ok(result.overallScore >= 80);
});

test("3. a Snowflake-heavy Data Engineer JD ranks on real Snowflake/SQL/data-engineering evidence", () => {
  const result = evaluate({
    jobTitle: "Snowflake Data Engineer",
    skills: [skill("Snowflake"), skill("SQL"), skill("Python"), skill("dbt", { requirement_level: "Preferred" })],
  });
  assert.equal(result.dimensionScores.roleAlignment, 100);
  assert.ok(result.overallScore >= 80);
});

test("4. an AI/Data Engineer JD counts supported AI/data evidence but leaves unsupported AI requirements MISSING, never fabricated", () => {
  const result = evaluate({
    jobTitle: "AI/Data Engineer",
    skills: [
      skill("PySpark"),
      skill("Python"),
      skill("Snowflake"),
      skill("TensorFlow", { category: "AI / ML", evidence_snippet: "TensorFlow required" }),
      skill("PyTorch", { category: "AI / ML", evidence_snippet: "PyTorch required" }),
    ],
  });
  const missingLabels = result.missingRequirements.map((m) => m.requirement.label);
  assert.ok(missingLabels.includes("TensorFlow"), "an unsupported requirement must stay MISSING");
  assert.ok(missingLabels.includes("PyTorch"));
  assert.ok(
    !result.employerEvidencedMatches.some((m) => ["TensorFlow", "PyTorch"].includes(m.requirement.label)),
    "a JD requirement must never be read back as candidate evidence"
  );
});

// --- 5. Platform/infrastructure-heavy role ---------------------------------------------------------

test("5. a platform-heavy role weights the candidate's Docker/Kubernetes evidence — which is inventory-only, so it cannot manufacture readiness", () => {
  const result = evaluate({
    jobTitle: "Data Platform Engineer",
    skills: [
      skill("Docker", { category: "DevOps", evidence_snippet: "Hands-on production experience with Docker" }),
      skill("Kubernetes", { category: "DevOps", evidence_snippet: "Hands-on production experience with Kubernetes" }),
      skill("Terraform", { category: "DevOps", evidence_snippet: "Hands-on production experience with Terraform" }),
    ],
  });
  assert.equal(result.dimensionScores.roleAlignment, 100, "Data Platform Engineer IS the candidate's role, specialised");
  assert.equal(result.employerEvidencedShare, 0, "none of this platform evidence is employer-attributed");
  assert.equal(result.decision, "NEEDS_REVIEW");
  assert.ok(result.blockingReasons.some((r) => r.includes("employer-attributed")));
});

// --- 6. Generic Software Engineer must not beat an aligned Data Engineer --------------------------

test("6. a generic Software Engineer JD sharing Python/SQL/Docker does NOT outrank a highly aligned Data Engineer JD", () => {
  const genericSwe = evaluate({
    jobTitle: "Software Engineer",
    dedupeKey: "greenhouse:1:swe",
    skills: [skill("Python", { category: "Programming Languages" }), skill("SQL", { category: "Programming Languages" }), skill("Docker", { category: "DevOps" })],
  });
  const alignedDe = evaluate({
    jobTitle: "Senior Data Engineer",
    dedupeKey: "greenhouse:1:de",
    skills: [skill("PySpark"), skill("Azure Data Factory"), skill("Snowflake"), skill("Kafka"), skill("Airflow")],
  });
  assert.ok(
    alignedDe.overallScore > genericSwe.overallScore,
    `aligned Data Engineer (${alignedDe.overallScore}) must outscore generic Software Engineer (${genericSwe.overallScore}) despite the SWE's perfect Python/SQL overlap`
  );
});

// --- 7/8. Sponsorship ------------------------------------------------------------------------------

test("7. an explicit no-sponsorship JD is a hard blocker that perfect skill overlap cannot compensate for", () => {
  const result = evaluate({
    sponsorshipPolarity: "negative",
    skills: [skill("PySpark"), skill("Azure Data Factory"), skill("Snowflake"), skill("SQL")],
  });
  assert.equal(result.decision, "BLOCKED");
  assert.equal(result.eligibility.status, "BLOCKED");
  assert.equal(result.eligibility.sponsorship.signal, "explicit_negative");
});

test("8. a JD that is SILENT on sponsorship is never inferred to be a rejection, and no longer vetoes readiness", () => {
  const result = evaluate({
    sponsorshipPolarity: "none",
    companyH1bConfidence: "Unknown",
    skills: [skill("PySpark"), skill("Azure Data Factory"), skill("Snowflake"), skill("SQL"), skill("Python")],
  });
  assert.notEqual(result.decision, "BLOCKED", "silence is not a negative");
  assert.equal(result.eligibility.status, "UNKNOWN");
  assert.equal(result.eligibility.sponsorship.signal, "unknown");
  assert.equal(result.decision, "READY_FOR_TAILORING");
  assert.deepEqual(result.blockingReasons, [], "the unknown-sponsorship caveat is advisory, carried on eligibility.reasons");
  assert.ok(result.eligibility.reasons.some((r) => r.toLowerCase().includes("no sponsorship signal")));
});

// --- 9. Missing JD intelligence --------------------------------------------------------------------

test("9. a JD with no extractable requirements is an INSUFFICIENT-DATA state, not a confident 0% and not a fake 100%", () => {
  const result = evaluate({ jobTitle: "Classroom Floater", skills: [], descriptionText: null, experienceMinYears: 3 });
  assert.equal(result.insufficientJdSignal, true, "must be flagged, not silently scored");
  assert.equal(result.dimensionScores.required, null);
  assert.equal(result.dimensionScores.preferred, null);
  assert.equal(
    result.overallScore,
    0,
    "pre-Stage-24B this exact shape produced 100 — a years-of-experience minimum was the only applicable dimension"
  );
  assert.notEqual(result.decision, "READY_FOR_TAILORING");
});

test("9b. the same empty-requirement JD with an ALIGNED title is still flagged insufficient rather than presented as a confident match", () => {
  const result = evaluate({ jobTitle: "Senior Data Engineer", skills: [], experienceMinYears: 3 });
  assert.equal(result.insufficientJdSignal, true);
  assert.notEqual(result.decision, "READY_FOR_TAILORING", "an unparsed JD can never be tailoring-ready");
});

// --- 10. Built In-shaped posting (HTML-derived description, real extracted intelligence) -----------

test("10. a Built In-shaped posting whose description was sanitized into clean text and real skills evaluates normally", () => {
  const result = evaluate({
    jobTitle: "Senior Cloud Data Engineer - Remote",
    descriptionText: "We are looking for a Senior Data Engineer to build pipelines. Requirements: PySpark, Snowflake, SQL.",
    skills: [skill("PySpark"), skill("Snowflake"), skill("SQL"), skill("Python")],
  });
  assert.equal(result.insufficientJdSignal, false, "real extracted intelligence clears the requirement floor");
  assert.ok(result.overallScore > 0);
  assert.ok(!/[<>]/.test(String(result.employerEvidencedMatches.map((m) => m.requirement.label).join(""))), "no raw markup leaks into requirement labels");
});

// --- 11/12. Truthfulness across different JDs -------------------------------------------------------

test("11. the same candidate produces different, truthful scores across different JDs", () => {
  const strong = evaluate({ dedupeKey: "k1", jobTitle: "Senior Data Engineer", skills: [skill("PySpark"), skill("Snowflake"), skill("SQL"), skill("Python")] });
  const partial = evaluate({ dedupeKey: "k2", jobTitle: "Senior Data Engineer", skills: [skill("PySpark"), skill("Kafka"), skill("Scala", { category: "Programming Languages" }), skill("Flink")] });
  const unrelated = evaluate({ dedupeKey: "k3", jobTitle: "Mammography Technologist", skills: [skill("Radiology"), skill("Patient Care"), skill("Mammography")] });
  assert.ok(strong.overallScore > partial.overallScore, `${strong.overallScore} > ${partial.overallScore}`);
  assert.ok(partial.overallScore > unrelated.overallScore, `${partial.overallScore} > ${unrelated.overallScore}`);
  assert.equal(unrelated.dimensionScores.roleAlignment, 0);
});

test("12. an unsupported JD skill counts as a gap and is NEVER injected into the candidate's evidence", () => {
  const result = evaluate({ skills: [skill("PySpark"), skill("Snowflake"), skill("Kafka"), skill("Flink"), skill("Scala", { category: "Programming Languages" })] });
  const missing = result.missingRequirements.map((m) => m.requirement.label);
  assert.ok(missing.includes("Flink"));
  assert.ok(missing.includes("Scala"));
  const evidenced = result.employerEvidencedMatches.concat(result.inventoryOnlyMatches).map((m) => m.evidence?.rawSkillName);
  assert.ok(!evidenced.includes("Flink"), "a JD requirement must never become candidate evidence");
  assert.ok(result.dimensionScores.required !== null && result.dimensionScores.required < 100, "unmet requirements must lower the required dimension");
});

// --- 13/14. Ranking -------------------------------------------------------------------------------

const NOW = new Date("2026-08-17T00:00:00Z");
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}
function rankJob(jobId: number, overallScore: number | null, postedAt: string): ForYouJobInput {
  return {
    jobId,
    dedupeKey: `k-${jobId}`,
    title: "Data Engineer",
    postedAt,
    h1bCombinedConfidence: "Unknown",
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    notInterested: false,
    roleFamilyTier: "PRIMARY",
    match:
      overallScore === null
        ? undefined
        : { decision: "NEEDS_REVIEW", overallScore, employerEvidencedShare: 0.8, requirementCoverage: 0.9, insufficientJdSignal: false },
  };
}

test("13. a fresh 90% job ranks above a fresh 50% job", () => {
  const ranked = rankForYou([rankJob(2, 50, daysAgo(0)), rankJob(1, 90, daysAgo(0))], { now: NOW });
  assert.deepEqual(ranked.map((j) => j.jobId), [1, 2]);
});

test("14. a 5-day-old 95% job ranks above a same-day 50% job — freshness never overwhelms fit", () => {
  const ranked = rankForYou([rankJob(2, 50, daysAgo(0)), rankJob(1, 95, daysAgo(5))], { now: NOW });
  assert.deepEqual(ranked.map((j) => j.jobId), [1, 2]);
});

test("14b. an unevaluated or insufficient-signal posting never appears above a strong evaluated one", () => {
  const insufficient: ForYouJobInput = {
    ...rankJob(3, 100, daysAgo(0)),
    match: { decision: "NEEDS_REVIEW", overallScore: 100, employerEvidencedShare: 0, requirementCoverage: 0, insufficientJdSignal: true },
  };
  const ranked = rankForYou([insufficient, rankJob(2, null, daysAgo(0)), rankJob(1, 88, daysAgo(3))], { now: NOW });
  assert.equal(ranked[0].jobId, 1, "the fully-evidenced 88 leads");
  assert.equal(ranked[1].jobId, 3, "insufficient-signal next");
  assert.equal(ranked[2].jobId, 2, "never-evaluated last");
});

// --- 15/16. Idempotency and invalidation ------------------------------------------------------------

test("15. re-evaluating an unchanged job with an unchanged profile reproduces a byte-identical cache identity", () => {
  const args: Partial<EvaluateJobMatchInput> = { skills: [skill("PySpark"), skill("Snowflake"), skill("SQL")] };
  const first = evaluate(args);
  const second = evaluate(args);
  assert.equal(first.jdContentHash, second.jdContentHash);
  assert.equal(first.matchKnowledgeHash, second.matchKnowledgeHash);
  assert.equal(first.candidateProfileHash, second.candidateProfileHash);
  assert.equal(first.candidateSettingsHash, second.candidateSettingsHash);
  assert.equal(first.matchEngineVersion, second.matchEngineVersion);
  assert.equal(first.overallScore, second.overallScore);
  assert.equal(first.decision, second.decision);
});

test("16. changed job intelligence changes the evaluation AND its cache identity, so a stale result cannot survive", () => {
  const before = evaluate({ skills: [skill("PySpark"), skill("Snowflake"), skill("SQL")], descriptionText: "original text" });
  const after = evaluate({ skills: [skill("PySpark"), skill("Snowflake"), skill("SQL"), skill("Flink"), skill("Scala", { category: "Programming Languages" })], descriptionText: "revised text with more requirements" });
  assert.notEqual(before.jdContentHash, after.jdContentHash, "changed JD content changes the cache key");
  assert.notEqual(before.overallScore, after.overallScore, "newly-added unmet requirements must move the score");
});

test("16b. a changed candidate profile changes the cache identity even for an identical JD", () => {
  const args: Partial<EvaluateJobMatchInput> = { skills: [skill("PySpark"), skill("Snowflake"), skill("SQL")] };
  const before = evaluate(args);
  const NEW_HASH = crypto.createHash("sha256").update("resume-v2").digest("hex");
  fs.writeFileSync(
    path.join(tmpDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-02-01T00:00:00Z", sizeBytes: 11, sha256: NEW_HASH },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: HASH_S },
    })
  );
  const profilePath = path.join(tmpDir, "candidate-profile.json");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf-8"));
  profile.sourceHashes.resume = NEW_HASH;
  fs.writeFileSync(profilePath, JSON.stringify(profile));

  const after = evaluate(args);
  assert.notEqual(before.candidateProfileHash, after.candidateProfileHash);
});

// --- Score semantics -------------------------------------------------------------------------------

test("score semantics: ~90 means very strong, ~70 credible-but-imperfect, ~30 genuinely weak", () => {
  const veryStrong = evaluate({ dedupeKey: "s1", jobTitle: "Senior Data Engineer", skills: [skill("PySpark"), skill("Snowflake"), skill("SQL"), skill("Python"), skill("Azure Data Factory")] });
  const credible = evaluate({ dedupeKey: "s2", jobTitle: "Senior Data Engineer", skills: [skill("PySpark"), skill("Snowflake"), skill("Kafka"), skill("Flink"), skill("Scala", { category: "Programming Languages" })] });
  const weak = evaluate({ dedupeKey: "s3", jobTitle: "Actuarial Analyst", skills: [skill("SAS"), skill("Excel"), skill("Actuarial Modeling"), skill("SQL", { category: "Programming Languages" })] });

  assert.ok(veryStrong.overallScore >= 85, `very strong fit should be >= 85, got ${veryStrong.overallScore}`);
  assert.ok(credible.overallScore > weak.overallScore, `credible (${credible.overallScore}) must beat weak (${weak.overallScore})`);
  assert.ok(weak.overallScore < 40, `an unrelated profession with one shared skill should be genuinely weak, got ${weak.overallScore}`);
});
