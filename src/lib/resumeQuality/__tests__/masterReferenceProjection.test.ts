import assert from "node:assert/strict";
import { test } from "node:test";
import type { CandidateProfile } from "@/lib/match/types";
import {
  buildInitialGenerationMasterReference,
  buildRepairScopedMasterReference,
  shouldUseFullMasterReferenceForRepair,
} from "../handoff/masterReferenceProjection";
import { employerScopeForRepair, type RepairOperation, type RepairPlan } from "../repairScope";
import { validateRepairPreservation } from "../repairPreservation";
import type { ResumeContent } from "../types";

function fixtureProfile(): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "hash-resume-123", skills: "hash-skills-456" },
    builtAt: "2026-01-01T00:00:00Z",
    skills: [
      {
        rawSkillName: "Azure Data Factory",
        source: "employer",
        attributedTo: [{ employer: "Comerica Bank" }, { employer: "Fiserv" }],
      },
      {
        rawSkillName: "Python",
        source: "employer",
        attributedTo: [{ employer: "Microgate Technologies" }],
      },
      {
        rawSkillName: "Spark",
        source: "employer",
        attributedTo: [{ employer: "Microgate Technologies" }],
      },
      {
        rawSkillName: "Kubernetes",
        source: "inventory_only",
      },
    ],
    experience: [
      {
        employer: "Comerica Bank",
        title: "Senior Data Engineer",
        startDate: "2025-02",
        endDate: null,
        technologies: ["Azure Data Factory", "Oracle", "SQL Server"],
      },
      {
        employer: "Fiserv",
        title: "Data Engineer",
        startDate: "2023-07",
        endDate: "2025-01",
        technologies: ["Azure Data Factory", "Snowflake", "dbt"],
      },
      {
        employer: "Microgate Technologies",
        title: "Junior Data Engineer",
        startDate: "2020-01",
        endDate: "2021-11",
        technologies: ["Python", "Spark", "PostgreSQL"],
      },
    ],
    education: [
      { level: "Master's", field: "Computer Science", institution: "Tech University" },
      { level: "Bachelor's", field: "Electrical Engineering", institution: "State College" },
    ],
    certifications: [
      { name: "AWS Certified Solutions Architect", issuer: "Amazon" },
      { name: "Azure Data Engineer Associate", issuer: "Microsoft" },
    ],
    totalYearsExperience: 6,
  };
}

function op(overrides: Partial<RepairOperation>): RepairOperation {
  return {
    operation: "REPLACE_BULLET",
    artifact: "resume",
    section: "experience_bullet",
    rootFinding: "finding-key",
    evidenceSource: [],
    reason: "reason",
    candidateInputRequired: false,
    editablePath: "resume.experience[0].bullets[0]",
    ...overrides,
  };
}

function plan(overrides: Partial<RepairPlan>): RepairPlan {
  return {
    scope: "RESUME_ONLY",
    reason: "test repair",
    resumeFindings: [],
    coverLetterFindings: [],
    unattributedFindings: [],
    editablePaths: ["resume.experience[0].bullets[0]"],
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------------
// Unit tests: buildRepairScopedMasterReference
// -------------------------------------------------------------------------------------------------

test("1. compact reference omits the giant global skills array entirely", () => {
  const profile = fixtureProfile();
  const touched = new Set(["Comerica Bank"]);
  const compact = buildRepairScopedMasterReference(profile, touched);

  assert.equal("skills" in compact, false, "skills array must not exist on compact projection");
  assert.equal("sourceHashes" in compact, false, "sourceHashes must be omitted from compact projection");
  assert.equal("builtAt" in compact, false, "builtAt must be omitted from compact projection");
});

test("2. touched employer retains required full evidence and technologies", () => {
  const profile = fixtureProfile();
  const touched = new Set(["Comerica Bank"]);
  const compact = buildRepairScopedMasterReference(profile, touched);

  const comerica = compact.experience.find((e) => e.employer === "Comerica Bank");
  assert.ok(comerica);
  assert.equal(comerica.title, "Senior Data Engineer");
  assert.equal(comerica.startDate, "2025-02");
  assert.equal(comerica.endDate, null);
  assert.equal("technologies" in comerica, true);
  if ("technologies" in comerica) {
    assert.deepEqual(comerica.technologies, ["Azure Data Factory", "Oracle", "SQL Server"]);
  }
});

test("3. untouched employer keeps hard identity facts but omits technologies (stub with UNCHANGED)", () => {
  const profile = fixtureProfile();
  const touched = new Set(["Comerica Bank"]);
  const compact = buildRepairScopedMasterReference(profile, touched);

  const fiserv = compact.experience.find((e) => e.employer === "Fiserv");
  assert.ok(fiserv);
  assert.equal(fiserv.employer, "Fiserv");
  assert.equal(fiserv.title, "Data Engineer");
  assert.equal(fiserv.startDate, "2023-07");
  assert.equal(fiserv.endDate, "2025-01");
  assert.equal("technologies" in fiserv, false, "untouched employer must not carry technologies dump");
  if ("preservation" in fiserv) {
    assert.equal(fiserv.preservation, "UNCHANGED");
  } else {
    assert.fail("untouched employer must have preservation marker");
  }

  const microgate = compact.experience.find((e) => e.employer === "Microgate Technologies");
  assert.ok(microgate);
  assert.equal(microgate.employer, "Microgate Technologies");
  assert.equal(microgate.title, "Junior Data Engineer");
  assert.equal(microgate.startDate, "2020-01");
  assert.equal(microgate.endDate, "2021-11");
  assert.equal("technologies" in microgate, false);
  if ("preservation" in microgate) {
    assert.equal(microgate.preservation, "UNCHANGED");
  }
});

test("4. multi-employer repair: all touched employers retain technologies; only untouched are stubs", () => {
  const profile = fixtureProfile();
  const touched = new Set(["Comerica Bank", "Microgate Technologies"]);
  const compact = buildRepairScopedMasterReference(profile, touched);

  const comerica = compact.experience.find((e) => e.employer === "Comerica Bank");
  const fiserv = compact.experience.find((e) => e.employer === "Fiserv");
  const microgate = compact.experience.find((e) => e.employer === "Microgate Technologies");

  assert.ok(comerica && "technologies" in comerica);
  assert.ok(microgate && "technologies" in microgate);
  assert.ok(fiserv && "preservation" in fiserv && !("technologies" in fiserv));
});

test("5. education, certifications, schemaVersion, totalYearsExperience are preserved", () => {
  const profile = fixtureProfile();
  const touched = new Set(["Comerica Bank"]);
  const compact = buildRepairScopedMasterReference(profile, touched);

  assert.equal(compact.schemaVersion, 1);
  assert.equal(compact.totalYearsExperience, 6);
  assert.deepEqual(compact.education, profile.education);
  assert.deepEqual(compact.certifications, profile.certifications);
});

test("6. source CandidateProfile is never mutated (pure projection)", () => {
  const profile = fixtureProfile();
  const originalJson = JSON.stringify(profile);
  const touched = new Set(["Comerica Bank"]);

  const compact = buildRepairScopedMasterReference(profile, touched);

  // Mutate the returned object to prove deep independence
  if ("technologies" in compact.experience[0]) {
    compact.experience[0].technologies.push("HackedSkill");
  }
  compact.education.push({ level: "PhD", field: "AI", institution: "MIT" });
  compact.certifications.push({ name: "Fake Cert" });

  assert.equal(JSON.stringify(profile), originalJson, "profile must be byte-identical to original");
});

// -------------------------------------------------------------------------------------------------
// Fallback rules: shouldUseFullMasterReferenceForRepair
// -------------------------------------------------------------------------------------------------

test("7. undefined repairPlan falls back to full master reference", () => {
  assert.equal(shouldUseFullMasterReferenceForRepair(undefined), true);
});

test("8. repairPlan with missing or empty editablePaths falls back to full master reference", () => {
  assert.equal(shouldUseFullMasterReferenceForRepair(plan({ editablePaths: undefined })), true);
  assert.equal(shouldUseFullMasterReferenceForRepair(plan({ editablePaths: [] })), true);
});

test("9. repairPlan with unattributed findings falls back to full master reference", () => {
  const p = plan({
    editablePaths: ["resume.experience[0].bullets[0]"],
    unattributedFindings: ["Finding that could not be attributed to one artifact"],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p), true);
});

test("10. summary repair uses compact reference (does NOT fallback to raw profile)", () => {
  const p = plan({
    editablePaths: ["resume.summary[0]"],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p), false);

  const p2 = plan({
    editablePaths: ["resume.summary"],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p2), false);
});

test("11. tagline / positioning repair uses compact reference (does NOT fallback)", () => {
  const p = plan({
    editablePaths: ["resume.tagline"],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p), false);
});

test("12. skillGroups repair uses compact reference (does NOT fallback)", () => {
  const p = plan({
    editablePaths: ["resume.skillGroups"],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p), false);

  const p2 = plan({
    editablePaths: ["resume.skillGroups[0].items[1]"],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p2), false);
});

test("13. education repair uses compact reference (does NOT fallback)", () => {
  const p = plan({
    editablePaths: ["resume.education[0]"],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p), false);
});

test("14. certifications repair uses compact reference (does NOT fallback)", () => {
  const p = plan({
    editablePaths: ["resume.certifications[0]"],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p), false);
});

test("15. narrow employer experience bullet repair uses compact reference (does NOT fallback)", () => {
  const p = plan({
    editablePaths: ["resume.experience[0].bullets[1]", "resume.experience[0].bullets[2]"],
    unattributedFindings: [],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p), false);
});

test("16. narrow employer project description repair uses compact reference (does NOT fallback)", () => {
  const p = plan({
    editablePaths: ["resume.experience[1].projectDescription"],
    unattributedFindings: [],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p), false);
});

test("17. narrow cover letter sentence repair uses compact reference (does NOT fallback)", () => {
  const p = plan({
    scope: "COVER_LETTER_ONLY",
    editablePaths: ["coverLetter.paragraphs[1].sentences[0]"],
    unattributedFindings: [],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p), false);
});

// -------------------------------------------------------------------------------------------------
// Integration: employerScopeForRepair + buildRepairScopedMasterReference
// -------------------------------------------------------------------------------------------------

test("18. employerScopeForRepair returning null results in full profile fallback upstream", () => {
  // When operations have no employer (e.g. unattributed compliance checks)
  const p = plan({
    operations: [op({ employer: undefined, section: "summary" })],
    editablePaths: ["resume.experience[0].bullets[0]"],
  });
  const scope = employerScopeForRepair(p);
  assert.equal(scope, null, "ambiguous employer operations must yield null scope");
});

test("19. repairPreservation behavior: baseline preservation is unaffected by writer projection", () => {
  // Proves that validateRepairPreservation still strictly enforces editablePaths
  const baselineResume: ResumeContent = {
    name: "Alice Smith",
    tagline: "Senior Data Engineer",
    location: "Chicago, IL",
    phone: "312-555-0100",
    email: "alice@example.com",
    summary: ["Experienced engineer."],
    skillGroups: [{ label: "Data", items: ["SQL", "Python"] }],
    experience: [
      {
        company: "Comerica Bank",
        title: "Senior Data Engineer",
        dates: "2025-02 - Present",
        bullets: ["Built ADF pipeline.", "Optimized SQL queries."],
      },
      {
        company: "Fiserv",
        title: "Data Engineer",
        dates: "2023-07 - 2025-01",
        bullets: ["Maintained Snowflake warehouse."],
      },
    ],
    education: ["Master's in CS, Tech University"],
  };

  const allowedPlan = plan({
    editablePaths: ["resume.experience[0].bullets[0]"],
  });

  // A. Allowed edit only -> passes preservation
  const validRepaired: ResumeContent = {
    ...baselineResume,
    experience: [
      {
        ...baselineResume.experience[0],
        bullets: ["Architected enterprise ADF pipeline.", "Optimized SQL queries."],
      },
      baselineResume.experience[1],
    ],
  };
  const resultA = validateRepairPreservation({
    baselineResume,
    repairedResume: validRepaired,
    repairPlan: allowedPlan,
  });
  assert.equal(resultA.valid, true);

  // B. Writer modifies an allowed path AND an unapproved path -> caught and rejected
  const invalidRepaired: ResumeContent = {
    ...baselineResume,
    experience: [
      {
        ...baselineResume.experience[0],
        bullets: ["Architected enterprise ADF pipeline.", "Optimized SQL queries."],
      },
      {
        ...baselineResume.experience[1],
        bullets: ["Hacked untouched Fiserv bullet without permission."],
      },
    ],
  };
  const resultB = validateRepairPreservation({
    baselineResume,
    repairedResume: invalidRepaired,
    repairPlan: allowedPlan,
  });
  assert.equal(resultB.valid, false);
  assert.ok(resultB.violations.some((v) => v.includes("experience[1]")));
});

// -------------------------------------------------------------------------------------------------
// INITIAL_GENERATION TOKEN OPTIMIZATION (2026-08-23) — buildInitialGenerationMasterReference
// -------------------------------------------------------------------------------------------------

test("20. INITIAL_GENERATION reference omits skills, sourceHashes, builtAt, and every experience entry's technologies", () => {
  const profile = fixtureProfile();
  const compact = buildInitialGenerationMasterReference(profile);

  assert.equal("skills" in compact, false, "skills array must not exist");
  assert.equal("sourceHashes" in compact, false);
  assert.equal("builtAt" in compact, false);
  for (const entry of compact.experience) {
    assert.equal("technologies" in entry, false, `${entry.employer} must not carry a technologies dump`);
  }
});

test("21. INITIAL_GENERATION reference preserves employer/title/dates for EVERY employer, not just some", () => {
  const profile = fixtureProfile();
  const compact = buildInitialGenerationMasterReference(profile);

  assert.equal(compact.experience.length, profile.experience.length);
  for (const source of profile.experience) {
    const projected = compact.experience.find((e) => e.employer === source.employer);
    assert.ok(projected, `${source.employer} must be present`);
    assert.equal(projected.title, source.title);
    assert.equal(projected.startDate, source.startDate);
    assert.equal(projected.endDate, source.endDate);
    assert.ok("preservation" in projected && projected.preservation === "UNCHANGED");
  }
});

test("22. INITIAL_GENERATION reference preserves education, certifications, schemaVersion, totalYearsExperience", () => {
  const profile = fixtureProfile();
  const compact = buildInitialGenerationMasterReference(profile);

  assert.equal(compact.schemaVersion, profile.schemaVersion);
  assert.equal(compact.totalYearsExperience, profile.totalYearsExperience);
  assert.deepEqual(compact.education, profile.education);
  assert.deepEqual(compact.certifications, profile.certifications);
});

test("23. every technology omitted from the INITIAL_GENERATION reference is provably represented in the employer evidence map", async () => {
  // The safety argument for this optimization: nothing that was reachable via master_resume_reference
  // .json's skills[]/experience[].technologies before this change is now invisible to the writer —
  // buildEmployerEvidenceMap (the SAME function that renders PER-EMPLOYER EVIDENCE) is built from
  // that exact same source data, so every omitted technology string still surfaces there.
  const { buildEmployerEvidenceMap } = await import("../employerEvidence");
  const profile = fixtureProfile();
  const evidenceMap = buildEmployerEvidenceMap(profile);

  for (const entry of profile.experience) {
    const evidence = evidenceMap.employers.find((e) => e.employer === entry.employer);
    assert.ok(evidence, `${entry.employer} must have an evidence block`);
    for (const tech of entry.technologies) {
      assert.ok(
        evidence!.supported.includes(tech),
        `${entry.employer}'s own technology "${tech}" must appear in the employer evidence map's supported list`
      );
    }
  }
  // Inventory-only skills (no employer attribution) must still be reachable via availableViaMsi for
  // at least one role whose domain accepts inventory evidence — never silently dropped.
  const inventoryOnly = profile.skills.filter((s) => (s.attributedTo ?? []).length === 0);
  for (const skill of inventoryOnly) {
    const reachable = evidenceMap.employers.some((e) => e.availableViaMsi.includes(skill.rawSkillName));
    assert.ok(reachable, `inventory-only skill "${skill.rawSkillName}" must be reachable via some employer's availableViaMsi list`);
  }
});

test("24. INITIAL_GENERATION reference source profile is never mutated (pure projection)", () => {
  const profile = fixtureProfile();
  const originalJson = JSON.stringify(profile);
  const compact = buildInitialGenerationMasterReference(profile);

  compact.education.push({ level: "PhD", field: "AI", institution: "MIT" });
  compact.certifications.push({ name: "Fake Cert" });

  assert.equal(JSON.stringify(profile), originalJson, "profile must be byte-identical to original");
});

test("25. INITIAL_GENERATION reference is materially smaller than the full profile for a skills-heavy candidate", () => {
  const profile = fixtureProfile();
  const compactBytes = JSON.stringify(buildInitialGenerationMasterReference(profile)).length;
  const fullBytes = JSON.stringify(profile).length;
  assert.ok(compactBytes < fullBytes, "projection must be smaller than the full profile");
});
