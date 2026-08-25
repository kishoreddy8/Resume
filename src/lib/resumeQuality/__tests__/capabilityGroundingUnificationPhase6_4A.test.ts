import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { ResumeContent } from "../types";
import {
  isCapabilityGroundedForCandidate,
  checkTaxonomyEntrySupport,
  reconcileJdRequirements,
} from "../jdRequirementReconciler";
import { evaluateMsiCompliance } from "../reviewers/msiComplianceChecks";
import { evaluateTechnologyCompatibility } from "../technologyCompatibility";

/**
 * PHASE 6.4A — SHARED CANONICAL CAPABILITY-GROUNDING CONTRACT (GROUND-01..09)
 *
 * Proves the required invariant: for the same candidate evidence and the same canonical capability,
 * RECONCILER SUPPORTED = JD COVERAGE SUPPORTED = WRITER ALLOWED = DETERMINISTIC REVIEWER GROUNDED.
 * Found live against Job 7362, workflow 33: reconcileJdRequirements correctly considered "Data
 * Governance" supported (via Microsoft Purview/RBAC evidence), but the deterministic reviewer's own
 * masterSkillsInventoryCompliance check flagged it as an unsupported claim — a genuine cross-module
 * disagreement about the SAME candidate evidence.
 */

// A profile with Microsoft Purview / RBAC / Databricks-lakehouse evidence, but WITHOUT the literal
// capability umbrella names ("Data Governance", "Access Control & Security", "Lakehouse Architecture")
// ever appearing as raw skills — exactly the shape that produced the live false positive.
const groundedProfile: CandidateProfile = {
  schemaVersion: 1,
  sourceHashes: { resume: "sha_resume", skills: "sha_skills" },
  builtAt: "2026-08-24T00:00:00Z",
  totalYearsExperience: 6,
  skills: [
    { rawSkillName: "Microsoft Purview", source: "employer" },
    { rawSkillName: "RBAC", source: "employer" },
    { rawSkillName: "Databricks", source: "employer" },
    { rawSkillName: "Delta Lake", source: "employer" },
    { rawSkillName: "Python", source: "employer" },
    { rawSkillName: "SQL", source: "employer" },
  ],
  experience: [
    {
      employer: "Comerica Bank",
      title: "Data Engineer",
      startDate: "2025-02",
      endDate: null,
      technologies: ["Microsoft Purview", "RBAC", "Databricks", "Delta Lake", "Python", "SQL"],
    },
  ],
  education: [{ institution: "Chicago State University", field: "Computer Science", level: "Master's" }],
  certifications: [],
};

function makeResume(skillItems: string[]): ResumeContent {
  return {
    name: "Saikishore Reddy",
    tagline: "Senior Data Engineer",
    location: "Dallas, TX",
    phone: "9452370560",
    email: "saireddy2898@gmail.com",
    summary: ["Data Engineer building governed Snowflake and lakehouse platforms."],
    skillGroups: [{ label: "Skills", items: skillItems }],
    experience: [
      {
        company: "Comerica Bank",
        title: "Data Engineer",
        dates: "2025-02 - Present",
        bullets: ["Configured Microsoft Purview cataloging and RBAC access controls across the Databricks Delta Lake platform."],
      },
    ],
    education: [],
    certifications: [],
  };
}

describe("Phase 6.4A: Shared Canonical Capability-Grounding Contract (GROUND-01..09)", () => {
  it("GROUND-01 (A): Data Governance is grounded by the candidate's approved Purview/governance evidence", () => {
    const result = isCapabilityGroundedForCandidate("Data Governance", groundedProfile);
    assert.equal(result.supported, true);
    assert.ok(result.sources.some((s) => s.toLowerCase().includes("purview") || s.toLowerCase().includes("rbac")));
  });

  it("GROUND-02 (B): Access Control & Security is grounded through approved RBAC / identity-security evidence", () => {
    const result = isCapabilityGroundedForCandidate("Access Control & Security", groundedProfile);
    assert.equal(result.supported, true);
    assert.ok(result.sources.some((s) => s.toLowerCase().includes("rbac")));
  });

  it("GROUND-03 (C): Lakehouse Architecture is grounded through the approved Databricks/Delta Lake mapping", () => {
    const result = isCapabilityGroundedForCandidate("Lakehouse Architecture", groundedProfile);
    assert.equal(result.supported, true);
    assert.ok(result.sources.some((s) => s.toLowerCase().includes("databricks") || s.toLowerCase().includes("delta lake")));
  });

  it("GROUND-04 (D): a truly unsupported capability remains rejected", () => {
    const result = isCapabilityGroundedForCandidate("Master Data Management", groundedProfile);
    assert.equal(result.supported, false);
    assert.equal(result.sources.length, 0);
  });

  it("GROUND-05 (D): a plain technology absent from both taxonomies still fails MSI compliance", () => {
    const resume = makeResume(["Kubernetes"]);
    const result = evaluateMsiCompliance(resume, groundedProfile);
    assert.ok(result.ungroundedTechnologies.includes("Kubernetes"), "Kubernetes has zero evidence and must still be flagged");
  });

  it("GROUND-06 (E): reconciler and deterministic reviewer return the same support decision for Data Governance", () => {
    const reqs: RequirementUnit[] = [
      {
        kind: "skill",
        memberSkillNames: ["Data Governance"],
        categories: [],
        label: "Data Governance",
        requirementLevel: "Required",
        criticality: "CRITICAL",
        evidenceSnippets: ["Contribute to data governance practices."],
        experienceDepthRequired: false,
        requestedYears: null,
        fromUnclaimedText: false,
      },
    ];
    const reconciliation = reconcileJdRequirements({
      rawJd: "Contribute to data governance practices.",
      structuredRequirements: reqs,
      candidateProfile: groundedProfile,
      roleTitle: "Senior Data Engineer",
    });
    const dgCanonical = reconciliation.canonicalRequirements.find((r) => r.canonicalName === "Data Governance");
    assert.equal(dgCanonical?.supportedByCandidate, true, "reconciler says supported");

    const resumeWithDataGovernance = makeResume(["Data Governance"]);
    const msi = evaluateMsiCompliance(resumeWithDataGovernance, groundedProfile);
    assert.ok(!msi.ungroundedTechnologies.includes("Data Governance"), "reviewer must agree Data Governance is grounded");

    const compat = evaluateTechnologyCompatibility(resumeWithDataGovernance, groundedProfile);
    assert.ok(
      !compat.findings.some((f) => f.code === "UNSUPPORTED_CAPABILITY" && f.technologies.includes("Data Governance")),
      "technology-compatibility check must also agree Data Governance is grounded"
    );
  });

  it("GROUND-07 (F): literal alias differences cannot create contradictory support decisions across the three modules", () => {
    const names = ["Data Governance", "Access Control & Security", "Lakehouse Architecture"];
    for (const name of names) {
      const direct = isCapabilityGroundedForCandidate(name, groundedProfile);
      const resume = makeResume([name]);
      const msi = evaluateMsiCompliance(resume, groundedProfile);
      const compat = evaluateTechnologyCompatibility(resume, groundedProfile);
      const msiFlags = msi.ungroundedTechnologies.includes(name);
      const compatFlags = compat.findings.some((f) => f.code === "UNSUPPORTED_CAPABILITY" && f.technologies.includes(name));
      assert.equal(direct.supported, true, `${name}: shared grounding must say supported`);
      assert.equal(msiFlags, false, `${name}: reviewer must not contradict shared grounding`);
      assert.equal(compatFlags, false, `${name}: compatibility check must not contradict shared grounding`);
    }
  });

  it("GROUND-08: checkTaxonomyEntrySupport (the extracted shared primitive) matches isCapabilityGroundedForCandidate for a taxonomy entry", () => {
    const entry = { canonicalName: "Data Governance", msiMatchKeys: ["data governance", "microsoft purview", "access control", "rbac"] };
    const canonicalSet = new Set(["microsoft purview", "rbac", "databricks", "delta lake", "python", "sql"]);
    const experienceSkills = new Set(["microsoft purview", "rbac", "databricks", "delta lake", "python", "sql"]);
    const direct = checkTaxonomyEntrySupport(entry, canonicalSet, experienceSkills);
    const viaWrapper = isCapabilityGroundedForCandidate("Data Governance", groundedProfile);
    assert.equal(direct.supported, viaWrapper.supported);
  });

  it("GROUND-09: an unsupported capability is still rejected end to end by every module (no weakening)", () => {
    // "Master Data Management" is absent from BOTH taxonomies — the shared function must reject it
    // regardless of whether Phase 2's own taxonomy even recognizes it as a literal claim.
    const direct = isCapabilityGroundedForCandidate("Master Data Management", groundedProfile);
    assert.equal(direct.supported, false);
    assert.equal(direct.sources.length, 0);
  });
});
