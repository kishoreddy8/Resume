import assert from "node:assert/strict";
import { test } from "node:test";
import type { CandidateProfile } from "@/lib/match/types";
import {
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

test("10. summary repair falls back to full master reference", () => {
  const p = plan({
    editablePaths: ["resume.summary[0]"],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p), true);

  const p2 = plan({
    editablePaths: ["resume.summary"],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p2), true);
});

test("11. tagline / positioning repair falls back to full master reference", () => {
  const p = plan({
    editablePaths: ["resume.tagline"],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p), true);
});

test("12. skillGroups repair falls back to full master reference", () => {
  const p = plan({
    editablePaths: ["resume.skillGroups"],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p), true);

  const p2 = plan({
    editablePaths: ["resume.skillGroups[0].items[1]"],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p2), true);
});

test("13. education repair falls back to full master reference", () => {
  const p = plan({
    editablePaths: ["resume.education[0]"],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p), true);
});

test("14. certifications repair falls back to full master reference", () => {
  const p = plan({
    editablePaths: ["resume.certifications[0]"],
  });
  assert.equal(shouldUseFullMasterReferenceForRepair(p), true);
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
