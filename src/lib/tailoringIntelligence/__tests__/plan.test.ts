import test from "node:test";
import assert from "node:assert/strict";
import { buildTailoringPlan, EVIDENCE_STATE_LABEL } from "../plan";
import { renderExperienceEmphasisSection } from "../writerSection";
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

test("TI-6 employer emphasis is real overlap, ranked, with zero-overlap roles last", () => {
  const plan = buildTailoringPlan(
    result({
      employerEvidencedMatches: [
        match("Snowflake", { evidence: { source: "employer", rawSkillName: "Snowflake", canonicalSkillName: "Snowflake", employers: ["Comerica"] } }),
      ],
    }),
    profile
  );
  assert.equal(plan.employerEmphasis[0].employer, "Comerica");
  assert.ok(plan.employerEmphasis[0].overlapping.includes("Snowflake"));
  const last = plan.employerEmphasis[plan.employerEmphasis.length - 1];
  assert.equal(last.overlapping.length, 0, "a role with no overlap must not be given invented relevance");
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
