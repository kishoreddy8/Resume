import test from "node:test";
import assert from "node:assert/strict";
import { buildTailoringPlan, EVIDENCE_STATE_LABEL } from "../plan";
import { renderExperienceEmphasisSection, renderDistributedEvidenceSection } from "../writerSection";
import type { CandidateProfile, JobMatchResult, RequirementMatch, RequirementUnit } from "@/lib/match/types";

function unit(label: string, level: "Required" | "Preferred" = "Required"): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: [label],
    categories: [],
    label,
    requirementLevel: level,
    criticality: level === "Required" ? "REQUIRED" : "PREFERRED",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    requestedYears: null,
    fromUnclaimedText: false,
  } as RequirementUnit;
}

function match(label: string, opts: Partial<RequirementMatch> = {}, level: "Required" | "Preferred" = "Required"): RequirementMatch {
  return { requirement: unit(label, level), matchType: "MATCHED", credit: 1, ...opts } as RequirementMatch;
}

function result(over: Partial<JobMatchResult> = {}): JobMatchResult {
  return {
    candidateId: 1,
    jobId: 2,
    decision: "NEEDS_REVIEW",
    insufficientJdSignal: false,
    employerEvidencedMatches: [],
    inventoryOnlyMatches: [],
    transferableMatches: [],
    missingRequirements: [],
    unresolvedRequirements: [],
    criticalGaps: [],
    ...over,
  } as unknown as JobMatchResult;
}

const profile: CandidateProfile = {
  schemaVersion: 1,
  sourceHashes: { resume: "r", skills: "s" },
  builtAt: "2026-01-01T00:00:00Z",
  skills: [
    { rawSkillName: "Snowflake", source: "employer", attributedTo: [{ employer: "Comerica" }] },
    { rawSkillName: "PySpark", source: "employer", attributedTo: [{ employer: "IntlMotors" }] },
    { rawSkillName: "Terraform", source: "inventory_only" },
  ],
  experience: [
    { employer: "Comerica", title: "Data Engineer", startDate: null, endDate: null, technologies: ["Snowflake"] },
    { employer: "IntlMotors", title: "Data Engineer", startDate: null, endDate: null, technologies: ["PySpark"] },
  ],
  education: [],
  certifications: [],
  totalYearsExperience: null,
} as CandidateProfile;

test("TI-1 every requirement bucket maps to its own honest state", () => {
  const plan = buildTailoringPlan(
    result({
      employerEvidencedMatches: [match("Snowflake", { evidence: { source: "employer", rawSkillName: "Snowflake", canonicalSkillName: "Snowflake", employers: ["Comerica"] } })],
      inventoryOnlyMatches: [match("Terraform", { evidence: { source: "inventory_only", rawSkillName: "Terraform", canonicalSkillName: "Terraform" } })],
      transferableMatches: [match("Databricks", { transferable: { fromRawSkillName: "PySpark", toCanonicalSkillName: "Databricks", strength: "moderate", reason: "Spark experience transfers" } })],
      missingRequirements: [match("Scala")],
      unresolvedRequirements: [match("FooBarDB")],
    }),
    profile
  );
  const by = Object.fromEntries(plan.requirements.map((r) => [r.label, r.state]));
  assert.equal(by.Snowflake, "STRONG");
  assert.equal(by.Terraform, "MENTIONED");
  assert.equal(by.Databricks, "PARTIAL");
  assert.equal(by.Scala, "NONE");
  assert.equal(by.FooBarDB, "UNKNOWN");
});

test("TI-2 the vocabulary never contains a judgement about the candidate", () => {
  const banned = /missing skill|weak candidate|low probability|not qualified|unqualified/i;
  for (const label of Object.values(EVIDENCE_STATE_LABEL)) {
    assert.doesNotMatch(label, banned, `"${label}" states a verdict the engine never published`);
  }
});

test("TI-3 no requirement is invented — the plan holds exactly what the engine produced", () => {
  const r = result({
    employerEvidencedMatches: [match("Snowflake")],
    missingRequirements: [match("Scala")],
  });
  const plan = buildTailoringPlan(r, profile);
  assert.equal(plan.requirements.length, 2);
  assert.deepEqual(plan.requirements.map((x) => x.label).sort(), ["Scala", "Snowflake"]);
});

test("TI-4 an unevidenced requirement can never reach the emphasis list", () => {
  const plan = buildTailoringPlan(
    result({ missingRequirements: [match("Scala")], unresolvedRequirements: [match("FooBarDB")] }),
    profile
  );
  assert.equal(plan.emphasize.length, 0, "emphasizing something with no evidence is how a resume becomes a lie");
  assert.deepEqual(plan.doNotClaim.map((r) => r.label).sort(), ["FooBarDB", "Scala"]);
});

test("TI-5 Required outranks Preferred even when the Preferred one has stronger evidence", () => {
  const plan = buildTailoringPlan(
    result({
      employerEvidencedMatches: [match("NiceToHave", {}, "Preferred")],
      inventoryOnlyMatches: [match("MustHave", { evidence: { source: "inventory_only", rawSkillName: "MustHave", canonicalSkillName: "MustHave" } }, "Required")],
    }),
    profile
  );
  assert.equal(plan.emphasize[0].label, "MustHave");
});

/* ── The MSI evidence contract, end to end through the plan ─────────────────────────────────── */

test("EAT-1 a skill declared ONLY in the Master Skills Inventory is usable at a listed client", () => {
  // Terraform is declared in the inventory with NO employer attribution, and appears in neither
  // role's technologies — exactly the case the old rule refused to use anywhere.
  const plan = buildTailoringPlan(
    result({
      inventoryOnlyMatches: [
        match("Terraform", { evidence: { source: "inventory_only", rawSkillName: "Terraform", canonicalSkillName: "Terraform" } }),
      ],
    }),
    profile
  );
  for (const e of plan.employerEmphasis) {
    assert.ok(e.viaMsi.includes("Terraform"), `${e.employer}: MSI evidence must be usable where the resume does not show it`);
    assert.ok(e.overlapping.includes("Terraform"), `${e.employer}: and must count toward that role's emphasis`);
    assert.ok(!e.alreadyWritten.includes("Terraform"), `${e.employer}: while staying separated from what IS written`);
  }
});

test("EAT-2 the Master Skills Inventory is named as a source, not footnoted as weaker evidence", () => {
  const plan = buildTailoringPlan(
    result({
      inventoryOnlyMatches: [
        match("PySpark", { evidence: { source: "inventory_only", rawSkillName: "PySpark", canonicalSkillName: "PySpark" } }),
      ],
      employerEvidencedMatches: [
        match("Snowflake", { evidence: { source: "employer", rawSkillName: "Snowflake", canonicalSkillName: "Snowflake", employers: ["Comerica"] } }),
      ],
    }),
    profile
  );
  const pyspark = plan.requirements.find((r) => r.label === "PySpark")!;
  const snowflake = plan.requirements.find((r) => r.label === "Snowflake")!;
  assert.ok(pyspark.sources.includes("Master Skills Inventory"));
  assert.ok(snowflake.sources.some((x) => x.startsWith("Master Resume — Comerica")));
});

test("EAT-3 a skill in neither document is never made available at any client", () => {
  // Kafka appears in no skill entry and no role's technologies.
  const plan = buildTailoringPlan(result({ missingRequirements: [match("Kafka")] }), profile);
  for (const e of plan.employerEmphasis) {
    assert.ok(!e.viaMsi.includes("Kafka"), "MSI availability can never manufacture undeclared evidence");
    assert.ok(!e.alreadyWritten.includes("Kafka"));
    assert.ok(!e.overlapping.includes("Kafka"));
  }
  assert.ok(plan.doNotClaim.some((r) => r.label === "Kafka"));
});

test("EAT-4 ranking counts written AND MSI-available evidence, so no role is understated", () => {
  const plan = buildTailoringPlan(
    result({
      employerEvidencedMatches: [
        match("Snowflake", { evidence: { source: "employer", rawSkillName: "Snowflake", canonicalSkillName: "Snowflake", employers: ["Comerica"] } }),
      ],
      inventoryOnlyMatches: [
        match("PySpark", { evidence: { source: "inventory_only", rawSkillName: "PySpark", canonicalSkillName: "PySpark" } }),
      ],
    }),
    profile
  );
  for (const e of plan.employerEmphasis) {
    assert.equal(
      e.overlapping.length,
      new Set([...e.alreadyWritten, ...e.viaMsi]).size,
      `${e.employer}: the count must be the union, not just what is written`
    );
  }
});

test("EAT-5 a role with no written evidence never outranks one that has some", () => {
  /* The inventory is global, so MSI availability alone says nothing about whether a role is the
   * right one to emphasise. Ranking must lead with evidence the resume actually carries. */
  const plan = buildTailoringPlan(
    result({
      employerEvidencedMatches: [
        match("Snowflake", { evidence: { source: "employer", rawSkillName: "Snowflake", canonicalSkillName: "Snowflake", employers: ["Comerica"] } }),
      ],
      inventoryOnlyMatches: [
        match("Terraform", { evidence: { source: "inventory_only", rawSkillName: "Terraform", canonicalSkillName: "Terraform" } }),
      ],
    }),
    profile
  );
  const written = plan.employerEmphasis.map((e) => e.alreadyWritten.length);
  assert.deepEqual(
    [...written].sort((a, b) => b - a),
    written,
    "roles must be ordered by written evidence first, not by globally-available inventory skills"
  );
});

test("RS-1 eligibility never presents MSI availability as written evidence", () => {
  const plan = buildTailoringPlan(
    result({
      employerEvidencedMatches: [
        match("Snowflake", { evidence: { source: "employer", rawSkillName: "Snowflake", canonicalSkillName: "Snowflake", employers: ["Comerica"] } }),
      ],
    }),
    profile
  );
  const snow = plan.msiEligibility.find((m) => m.technology === "Snowflake")!;
  assert.deepEqual(snow.writtenAt, ["Comerica"], "only the client it is actually written under");
  assert.ok(!snow.writtenAt.includes("IntlMotors"), "MSI availability must never be reported as written");
  assert.ok(snow.eligibleViaMsi.includes("IntlMotors"), "and must be reported as available instead");
});

test("RS-2 every excluded employer carries a deterministic reason", () => {
  const plan = buildTailoringPlan(
    result({
      employerEvidencedMatches: [
        match("Kubernetes", { evidence: { source: "employer", rawSkillName: "Kubernetes", canonicalSkillName: "Kubernetes", employers: ["Client A"] } }),
      ],
    }),
    profile
  );
  for (const m of plan.msiEligibility) {
    for (const e of m.excluded) {
      assert.ok(e.reason.length > 0, `${m.technology} at ${e.employer} was excluded with no reason given`);
    }
  }
});

test("RS-3 an unsupported technology has no eligibility entry at all", () => {
  const plan = buildTailoringPlan(result({ missingRequirements: [match("Kafka")] }), profile);
  assert.ok(
    !plan.msiEligibility.some((m) => m.technology === "Kafka"),
    "listing it would suggest it were a candidate for use somewhere"
  );
});

test("RS-4 eligibility is omitted entirely when no validated profile is loaded", () => {
  const plan = buildTailoringPlan(result({ employerEvidencedMatches: [match("Snowflake")] }), null);
  assert.deepEqual(plan.msiEligibility, [], "eligibility has no honest basis without a profile");
});

test("TI-6 employer emphasis is real overlap, ranked, and never invented", () => {
  const plan = buildTailoringPlan(
    result({
      employerEvidencedMatches: [
        match("Snowflake", { evidence: { source: "employer", rawSkillName: "Snowflake", canonicalSkillName: "Snowflake", employers: ["Comerica"] } }),
      ],
    }),
    profile
  );
  // Comerica has it WRITTEN, so it ranks on the strongest evidence and reports it as already-written.
  assert.equal(plan.employerEmphasis[0].employer, "Comerica");
  assert.ok(plan.employerEmphasis[0].alreadyWritten.includes("Snowflake"));

  /* Under the MSI contract the other role can also support Snowflake — the inventory declares it
   * without restriction — but it must be reported as MSI-available, never as already written. */
  const intl = plan.employerEmphasis.find((e) => e.employer === "IntlMotors")!;
  assert.ok(!intl.alreadyWritten.includes("Snowflake"), "it is not written under this client and must not claim to be");

  // Nothing outside the candidate's documents ever enters any bucket.
  for (const e of plan.employerEmphasis) {
    for (const label of e.overlapping) {
      assert.ok(
        plan.requirements.some((r) => r.label === label),
        `${label} was not a requirement of this job — emphasis must never invent one`
      );
    }
  }
});

test("TI-7 with no candidate profile, employer emphasis is omitted rather than approximated", () => {
  const plan = buildTailoringPlan(result({ employerEvidencedMatches: [match("Snowflake")] }), null);
  assert.deepEqual(plan.employerEmphasis, []);
  assert.deepEqual(plan.sectionsAffected, ["Professional Summary", "Technical Skills"]);
});

test("TI-8 an insufficient-signal posting yields no emphasis at all", () => {
  const plan = buildTailoringPlan(result({ insufficientJdSignal: true }), profile);
  assert.equal(plan.insufficientJdSignal, true);
  assert.equal(plan.requirements.length, 0);
  assert.equal(plan.emphasize.length, 0);
});

test("TI-9 the writer section is ADDITIVE — empty when there is no ranking to state", () => {
  const empty = renderExperienceEmphasisSection(buildTailoringPlan(result(), null));
  assert.equal(empty, "", "an empty string leaves the writer prompt byte-for-byte unchanged");
});

test("TI-10 the writer section names only established evidence, and forbids the rest", () => {
  const plan = buildTailoringPlan(
    result({
      employerEvidencedMatches: [
        match("Snowflake", { evidence: { source: "employer", rawSkillName: "Snowflake", canonicalSkillName: "Snowflake", employers: ["Comerica"] } }),
      ],
      missingRequirements: [match("Scala")],
    }),
    profile
  );
  const text = renderExperienceEmphasisSection(plan);
  assert.match(text, /Comerica/);
  assert.match(text, /never claim these/i, "the do-not-claim list must reach the writer");
  assert.match(text, /Scala/);
  assert.match(text, /not a licence to expand one/i, "the section must not read as permission to embellish");
  // It must never invent an employer that is not in the profile.
  assert.doesNotMatch(text, /Google|Amazon|Microsoft/);
});

// --- Phase C: distributed technology evidence for high-depth JD requirements -----------------------
// Built entirely from `requirements` + the SAME `msiEligibility` this plan already computes (see
// plan.ts's buildDistributedEvidence) — no new evidence source, no second policy engine.

function depthUnit(label: string, requestedYears: number | null = null): RequirementUnit {
  return { ...unit(label, "Required"), experienceDepthRequired: true, requestedYears } as RequirementUnit;
}

function depthMatch(label: string, opts: Partial<RequirementMatch> = {}, requestedYears: number | null = null): RequirementMatch {
  return { requirement: depthUnit(label, requestedYears), matchType: "MATCHED", credit: 1, ...opts } as RequirementMatch;
}

/** Two compatible (technical, taxonomy-resolving) employers, one technology written at both. */
const multiEmployerProfile: CandidateProfile = {
  schemaVersion: 1,
  sourceHashes: { resume: "r", skills: "s" },
  builtAt: "2026-01-01T00:00:00Z",
  skills: [{ rawSkillName: "Databricks", source: "employer", attributedTo: [{ employer: "Comerica" }, { employer: "IntlMotors" }] }],
  experience: [
    { employer: "Comerica", title: "Data Engineer", startDate: null, endDate: null, technologies: ["Databricks", "SQL"] },
    { employer: "IntlMotors", title: "Data Engineer", startDate: null, endDate: null, technologies: ["Databricks", "Python"] },
  ],
  education: [],
  certifications: [],
  totalYearsExperience: null,
} as CandidateProfile;

test("DE-A: a depth-requested technology evidenced at 2+ compatible employers is distributed", () => {
  const plan = buildTailoringPlan(
    result({ employerEvidencedMatches: [depthMatch("Databricks", { evidence: { source: "employer", rawSkillName: "Databricks", canonicalSkillName: "Databricks", employers: ["Comerica", "IntlMotors"] } })] }),
    multiEmployerProfile
  );
  assert.equal(plan.distributedEvidence.length, 1);
  assert.equal(plan.distributedEvidence[0].technology, "Databricks");
  assert.deepEqual([...plan.distributedEvidence[0].compatibleEmployers].sort(), ["Comerica", "IntlMotors"]);
  assert.deepEqual([...plan.distributedEvidence[0].suggestedEmployers].sort(), ["Comerica", "IntlMotors"]);
});

test("DE-C: the same depth-requested technology at only ONE compatible employer is never listed for distribution", () => {
  const singleEmployerProfile: CandidateProfile = {
    ...multiEmployerProfile,
    skills: [{ rawSkillName: "Databricks", source: "employer", attributedTo: [{ employer: "Comerica" }] }],
    experience: [multiEmployerProfile.experience[0]],
  } as CandidateProfile;
  const plan = buildTailoringPlan(
    result({ employerEvidencedMatches: [depthMatch("Databricks", { evidence: { source: "employer", rawSkillName: "Databricks", canonicalSkillName: "Databricks", employers: ["Comerica"] } })] }),
    singleEmployerProfile
  );
  assert.equal(plan.distributedEvidence.length, 0, "nothing to distribute with only one home — a single-employer technology stays a normal emphasis item, not a distribution suggestion");
});

test("DE-D: an MSI-only (no employer attribution) technology can still be distributed across compatible employers", () => {
  const msiOnlyProfile: CandidateProfile = {
    ...multiEmployerProfile,
    skills: [{ rawSkillName: "Databricks", source: "inventory_only" }],
  } as CandidateProfile;
  const plan = buildTailoringPlan(
    result({ inventoryOnlyMatches: [depthMatch("Databricks")] }),
    msiOnlyProfile
  );
  assert.equal(plan.distributedEvidence.length, 1);
  assert.deepEqual([...plan.distributedEvidence[0].compatibleEmployers].sort(), ["Comerica", "IntlMotors"]);
});

test("DE-E: an unsupported technology never appears in distributed evidence, even if flagged depth-requested", () => {
  const plan = buildTailoringPlan(result({ missingRequirements: [depthMatch("Kubernetes")] }), multiEmployerProfile);
  assert.equal(plan.distributedEvidence.length, 0);
});

test("DE-F: an out-of-domain (incompatible) employer never receives distribution guidance", () => {
  const withOutOfDomainRole: CandidateProfile = {
    ...multiEmployerProfile,
    experience: [
      ...multiEmployerProfile.experience,
      { employer: "Acme Manufacturing", title: "Electrical Trainee", startDate: null, endDate: null, technologies: ["Heavy machinery testing"] },
    ],
  } as CandidateProfile;
  const plan = buildTailoringPlan(
    result({ employerEvidencedMatches: [depthMatch("Databricks", { evidence: { source: "employer", rawSkillName: "Databricks", canonicalSkillName: "Databricks", employers: ["Comerica", "IntlMotors"] } })] }),
    withOutOfDomainRole
  );
  assert.equal(plan.distributedEvidence.length, 1);
  assert.ok(!plan.distributedEvidence[0].compatibleEmployers.includes("Acme Manufacturing"), "an out-of-domain role must never be suggested for distribution even though it exists in the profile");
});

test("DE-H: a requirement with no depth signal at all is never suggested for distribution, even with 2+ compatible employers", () => {
  const plan = buildTailoringPlan(
    result({ employerEvidencedMatches: [match("Databricks", { evidence: { source: "employer", rawSkillName: "Databricks", canonicalSkillName: "Databricks", employers: ["Comerica", "IntlMotors"] } })] }),
    multiEmployerProfile
  );
  assert.equal(plan.distributedEvidence.length, 0, "distribution guidance is only for JD requirements the JD's own evidence text actually asked real depth for");
});

test("DE-I: multiple depth-requested technologies are ranked by criticality and capped, never unbounded", () => {
  const wideProfile: CandidateProfile = {
    ...multiEmployerProfile,
    skills: [
      { rawSkillName: "Databricks", source: "employer", attributedTo: [{ employer: "Comerica" }, { employer: "IntlMotors" }] },
      { rawSkillName: "SQL", source: "employer", attributedTo: [{ employer: "Comerica" }, { employer: "IntlMotors" }] },
    ],
  } as CandidateProfile;
  const plan = buildTailoringPlan(
    result({
      employerEvidencedMatches: [
        depthMatch("Databricks", { evidence: { source: "employer", rawSkillName: "Databricks", canonicalSkillName: "Databricks", employers: ["Comerica", "IntlMotors"] } }),
        depthMatch("SQL", { evidence: { source: "employer", rawSkillName: "SQL", canonicalSkillName: "SQL", employers: ["Comerica", "IntlMotors"] } }),
      ],
    }),
    wideProfile
  );
  assert.ok(plan.distributedEvidence.length <= 4, "distribution guidance must stay capped so it can never claim the entire bullet budget");
});

test("Phase C: with a purely qualitative depth signal (no JD years figure), the writer section states no years figure at all", () => {
  const plan = buildTailoringPlan(
    result({ employerEvidencedMatches: [depthMatch("Databricks", { evidence: { source: "employer", rawSkillName: "Databricks", canonicalSkillName: "Databricks", employers: ["Comerica", "IntlMotors"] } })] }),
    multiEmployerProfile
  );
  assert.equal(plan.distributedEvidence[0].requestedYears, null);
  const text = renderDistributedEvidenceSection(plan);
  assert.match(text, /Databricks/);
  assert.match(text, /Comerica/);
  assert.match(text, /IntlMotors/);
  assert.doesNotMatch(text, /\d+\+? years?/i, "with no JD-stated figure, the guidance section must not invent one");

  const empty = renderDistributedEvidenceSection(buildTailoringPlan(result(), null));
  assert.equal(empty, "", "empty when there is nothing to suggest, leaving the prompt byte-for-byte unchanged");
});

test("Phase C: with a JD-stated technology-specific years figure, the writer section states it as the JD's ask, never a candidate claim", () => {
  const plan = buildTailoringPlan(
    result({
      employerEvidencedMatches: [
        depthMatch(
          "Databricks",
          { evidence: { source: "employer", rawSkillName: "Databricks", canonicalSkillName: "Databricks", employers: ["Comerica", "IntlMotors"] } },
          4
        ),
      ],
    }),
    multiEmployerProfile
  );
  assert.equal(plan.distributedEvidence[0].requestedYears, 4);
  const text = renderDistributedEvidenceSection(plan);
  assert.match(text, /JD asks for 4\+ years/, "the JD's own figure must be shown, clearly attributed to the JD");
  assert.match(text, /never a statement about how many years the candidate has/i, "the section must explicitly disclaim any candidate-years implication");
  assert.doesNotMatch(text, /candidate has \d/i, "must never phrase the JD's figure as a candidate fact");
});
