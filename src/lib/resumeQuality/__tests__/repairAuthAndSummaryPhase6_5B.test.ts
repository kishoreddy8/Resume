import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ResumeContent } from "../types";
import type { RepairPlan } from "../repairScope";
import { evaluateSummaryPolicy } from "../reviewers/summaryChecks";
import { validateRepairPreservation } from "../repairPreservation";
import { evaluateCanonicalCoverage, type CanonicalJdRequirement } from "../jdRequirementReconciler";
import { checkSummaryOpening } from "../professionalIdentity";

/**
 * PHASE 6.5B — CONTROLLED FOUR-PATH LIVE RESUME REPAIR (SUMMARY-REPAIR-01..05, REPAIR-AUTH-01..03,
 * COVERAGE-OBS-01, COVERAGE-VAULT-01, COVERAGE-SUB-01, COVERAGE-ARCH-01)
 */

const skillGroups = [
  { label: "Data Architecture & Modeling", items: ["Medallion Architecture", "Data Vault"] },
  { label: "Cloud Data Platforms", items: ["Snowflake", "Azure Data Factory"] },
];

describe("Phase 6.5B: Summary Repair Acceptance (SUMMARY-REPAIR-01..05)", () => {
  it("SUMMARY-REPAIR-01: natural 'Data Engineer with 6+ years...' style opening passes", () => {
    const result = evaluateSummaryPolicy({
      summary: [
        "Data Engineer with 6+ years of experience building and modernizing enterprise data platforms across banking and payments.",
        "Delivers governed Snowflake and lakehouse ingestion, dimensional modeling, and reliability controls at scale.",
        "Brings that platform-modernization depth to Snowflake-centered data engineering for this role.",
      ],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Senior Data Engineer",
    });
    assert.equal(result.identityOpening.pass, true);
    assert.equal(result.targetAlignment.pass, true);
  });

  it("SUMMARY-REPAIR-02: a summary within the dynamic technology ceiling passes", () => {
    // 23 significant supported requirements => ceiling 6; this summary names 4.
    const result = evaluateSummaryPolicy({
      summary: [
        "Data Engineer with 6+ years of experience building governed Snowflake data platforms across banking and payments.",
        "Delivers Azure Data Factory ingestion, Databricks processing, and dimensional modeling at scale with strong data quality controls.",
        "Focused on Snowflake-centered platform modernization for this role.",
      ],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Senior Data Engineer",
    });
    assert.equal(result.technologyBudget.pass, true);
    assert.equal(result.technologyBudget.ceiling, 6);
    assert.ok(result.technologyBudget.namedCount <= 6);
  });

  it("SUMMARY-REPAIR-03: a summary AT the ceiling is allowed, but the ceiling is never treated as a target", () => {
    const atCeiling = evaluateSummaryPolicy({
      summary: [
        "Data Engineer with 6+ years of experience building Snowflake, Azure Data Factory, Databricks, Delta Lake, Python, and SQL data platforms.",
      ],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(atCeiling.technologyBudget.namedCount, 6);
    assert.equal(atCeiling.technologyBudget.pass, true, "exactly at the ceiling must still pass");

    // A summary naming ZERO technologies must ALSO pass technologyBudget — the ceiling never becomes
    // a required minimum.
    const zeroNamed = evaluateSummaryPolicy({
      summary: ["Data Engineer with 6+ years of experience building enterprise data platforms."],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(zeroNamed.technologyBudget.pass, true);
    assert.equal(zeroNamed.technologyBudget.namedCount, 0);
  });

  it("SUMMARY-REPAIR-04: a keyword-inventory summary fails recruiterNaturalness and keywordInventoryRisk", () => {
    const result = evaluateSummaryPolicy({
      summary: ["Data Engineer skilled in Snowflake, Databricks, Azure Data Factory, Delta Lake, PySpark, Python, SQL, and dbt."],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(result.keywordInventoryRisk.pass, false);
    assert.equal(result.recruiterNaturalness.pass, false);
  });

  it("SUMMARY-REPAIR-05: a missing supported JD technology does not itself fail summary policy", () => {
    // Data Vault, Medallion Architecture, Access Control, etc. are all absent from this summary —
    // summary policy must not require them; that's evaluateCanonicalCoverage's job, not this one's.
    const result = evaluateSummaryPolicy({
      summary: [
        "Data Engineer with 6+ years of experience building Snowflake-centered data platforms.",
        "Delivers governed ingestion and dimensional modeling for analytics at scale.",
        "Aligns directly with this role's platform priorities.",
      ],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(result.technologyBudget.pass, true);
    assert.equal(result.identityOpening.pass, true);
    assert.equal(result.recruiterNaturalness.pass, true);
  });
});

function fourPathRepairPlan(): RepairPlan {
  return {
    scope: "RESUME_ONLY",
    reason: "Phase 6.5B four-path controlled repair",
    resumeFindings: ["summary technology dump", "long Comerica bullet", "Fiserv laundry-list bullet", "Observability incorporation"],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: [
      "resume.summary[0]",
      "resume.experience[0].bullets[0]",
      "resume.experience[1].bullets[4]",
      "resume.experience[1].bullets[3]",
    ],
  };
}

function baselineResume(): ResumeContent {
  return {
    name: "Saikishore Reddy",
    tagline: "Data Engineer",
    location: "Dallas, TX",
    phone: "9452370560",
    email: "saireddy2898@gmail.com",
    summary: ["Old technology-dense summary."],
    skillGroups: [{ label: "Skills", items: ["Snowflake"] }],
    experience: [
      { company: "Comerica Bank", title: "Data Engineer", dates: "2025-02 - Present", bullets: ["Old long Comerica bullet.", "Unaffected bullet."] },
      {
        company: "Fiserv",
        title: "Data Engineer",
        dates: "2023-07 - 2025-01",
        bullets: ["Bullet 0.", "Bullet 1.", "Bullet 2.", "Old data-quality bullet.", "Old laundry-list CI/CD bullet."],
      },
    ],
    education: [],
    certifications: [],
  };
}

describe("Phase 6.5B: Repair Authorization (REPAIR-AUTH-01..03)", () => {
  it("REPAIR-AUTH-01: exactly four authorized paths are accepted", () => {
    const baseline = baselineResume();
    const repaired = baselineResume();
    repaired.summary = ["New natural summary."];
    repaired.experience[0].bullets[0] = "New shorter Comerica bullet.";
    repaired.experience[1].bullets[4] = "New single-responsibility Fiserv bullet.";
    repaired.experience[1].bullets[3] = "New data-quality bullet naturally incorporating observability.";

    const result = validateRepairPreservation({ baselineResume: baseline, repairedResume: repaired, repairPlan: fourPathRepairPlan() });
    assert.equal(result.valid, true, `expected valid, got: ${result.violations.join("; ")}`);
  });

  it("REPAIR-AUTH-02: a fifth unauthorized path causes the ENTIRE patch to be rejected", () => {
    const baseline = baselineResume();
    const repaired = baselineResume();
    repaired.summary = ["New natural summary."];
    repaired.experience[0].bullets[0] = "New shorter Comerica bullet.";
    repaired.experience[1].bullets[4] = "New single-responsibility Fiserv bullet.";
    repaired.experience[1].bullets[3] = "New data-quality bullet naturally incorporating observability.";
    // The exact real-world failure mode: an unauthorized 5th operation alongside four good ones.
    repaired.skillGroups[0].items[0] = "Microsoft Purview";

    const result = validateRepairPreservation({ baselineResume: baseline, repairedResume: repaired, repairPlan: fourPathRepairPlan() });
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((v) => v.includes("skillGroups")));
  });

  it("REPAIR-AUTH-03: no partial application after an unauthorized path — none of the four authorized edits are silently kept either", () => {
    const baseline = baselineResume();
    const repaired = baselineResume();
    repaired.summary = ["New natural summary."]; // one legitimate, authorized edit
    repaired.skillGroups[0].items[0] = "Microsoft Purview"; // one unauthorized edit

    const result = validateRepairPreservation({ baselineResume: baseline, repairedResume: repaired, repairPlan: fourPathRepairPlan() });
    assert.equal(result.valid, false);
    // validateRepairPreservation's own contract is "reject the whole patch" — callers (orchestrator.ts's
    // REPAIR_SCOPE_VIOLATION handling) never persist ANY part of repaired when this is invalid; the
    // authorized summary[0] edit is not itself a violation, but the patch as a whole must still fail.
    assert.ok(result.violations.some((v) => v.includes("skillGroups")));
  });
});

function makeReq(overrides: Partial<CanonicalJdRequirement>): CanonicalJdRequirement {
  return {
    id: "REQ-X",
    canonicalName: "X",
    kind: "TECHNOLOGY",
    rawText: "x",
    priority: "P2",
    criticality: "REQUIRED",
    source: "STRUCTURED",
    evidenceSpans: [],
    aliasesMatched: [],
    supportedByCandidate: true,
    candidateEvidenceSources: ["MSI (x)"],
    writerAction: "PASS_TO_WRITER",
    coverageExpectation: "SHOULD_SURFACE",
    ...overrides,
  };
}

describe("Phase 6.5B: spelled-out years figure in the verified-years opening carve-out (live finding)", () => {
  it("SUMMARY-OPENING-WORDFORM-01: 'Data Engineer with six years...' is accepted exactly like 'with 6 years' when the figure is verified", () => {
    const digits = checkSummaryOpening("Data Engineer with 6 years of hands-on experience building data platforms.", 6);
    const words = checkSummaryOpening("Data Engineer with six years building governed cloud data platforms.", 6);
    assert.deepEqual(digits, [], "digit form must already be accepted");
    assert.deepEqual(words, [], "word form of the SAME verified figure must be accepted too — this is the live Phase 6.5B repair finding");
  });

  it("SUMMARY-OPENING-WORDFORM-02: an unverified spelled-out years claim is still rejected (the carve-out never widens beyond a verified figure)", () => {
    const issues = checkSummaryOpening("Data Engineer with six years building governed cloud data platforms.", null);
    assert.ok(issues.length > 0, "with no statedYearsOfExperience, the word-form figure must still be treated as unverified and flagged");
  });
});

describe("Phase 6.5B: Canonical Coverage After Repair", () => {
  it("COVERAGE-OBS-01: Observability in bullet/project evidence => EVIDENCED", () => {
    const resume: ResumeContent = {
      ...baselineResume(),
      experience: [
        { company: "Comerica Bank", title: "Data Engineer", dates: "2025-02 - Present", bullets: ["Unrelated bullet."] },
        {
          company: "Fiserv",
          title: "Data Engineer",
          dates: "2023-07 - 2025-01",
          bullets: ["Established data quality controls and observability dashboards to catch schema drift and pipeline failures early."],
        },
      ],
    };
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "Observability", kind: "CAPABILITY", priority: "P2" })]);
    assert.equal(result[0].status, "EVIDENCED");
  });

  it("COVERAGE-VAULT-01: Data Vault in Skills only => LISTED_ONLY", () => {
    const resume: ResumeContent = { ...baselineResume(), skillGroups: [{ label: "Skills", items: ["Data Vault"] }] };
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "Data Vault", kind: "ARCHITECTURE", priority: "P1", coverageExpectation: "MUST_SURFACE" })]);
    assert.equal(result[0].status, "LISTED_ONLY");
  });

  it("COVERAGE-SUB-01: GitHub Actions can remain SUBSTITUTED by an approved equivalent (Azure DevOps)", () => {
    const resume: ResumeContent = {
      ...baselineResume(),
      skillGroups: [{ label: "DevOps", items: ["Azure DevOps"] }],
      experience: [
        { company: "Comerica Bank", title: "Data Engineer", dates: "2025-02 - Present", bullets: ["Automated CI/CD release pipelines through Azure DevOps."] },
      ],
    };
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "GitHub Actions", kind: "DEVOPS" })]);
    assert.equal(result[0].status, "SUBSTITUTED");
    assert.equal(result[0].substitutedBy, "Azure DevOps");
  });

  it("COVERAGE-ARCH-01: Airflow's absence is not automatically a failure when Azure Data Factory is the selected architecture", () => {
    const resume: ResumeContent = {
      ...baselineResume(),
      experience: [
        { company: "Comerica Bank", title: "Data Engineer", dates: "2025-02 - Present", bullets: ["Built Azure Data Factory pipelines for ingestion."] },
      ],
    };
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "Airflow", priority: "P2" })]);
    // KNOWN_ARCHITECTURAL_SUBSTITUTIONS maps Airflow -> Azure Data Factory (among others), so the
    // literal absence of "Airflow" resolves to SUBSTITUTED rather than a bare MISSING gap — this is
    // the intended behavior: the resume's actual orchestrator choice satisfies the same underlying
    // need without contradiction. Either way, neither status is a blocking/truthfulness finding —
    // evaluateCanonicalCoverage never elevates a competing-orchestrator absence to a gate condition.
    assert.equal(result[0].status, "SUBSTITUTED");
    assert.equal(result[0].substitutedBy, "Azure Data Factory");
  });
});
