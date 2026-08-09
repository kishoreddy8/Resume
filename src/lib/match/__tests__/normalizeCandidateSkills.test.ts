import assert from "node:assert/strict";
import { test } from "node:test";
import type { CandidateProfile } from "../types";
import { normalizeCandidateSkills, resolveCanonicalSkill, unrecognizedCandidateSkillNames } from "../normalizeCandidateSkills";

function profile(skills: CandidateProfile["skills"]): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "a", skills: "b" },
    builtAt: "2026-01-01T00:00:00Z",
    skills,
    experience: [],
    education: [],
    certifications: [],
    totalYearsExperience: null,
  };
}

test("an exact taxonomy alias resolves to its canonical name and category", () => {
  const resolved = resolveCanonicalSkill("python");
  assert.equal(resolved?.canonical, "Python");
  assert.equal(resolved?.category, "Programming Languages");
});

test("a raw name containing a known alias as a whole phrase resolves", () => {
  const resolved = resolveCanonicalSkill("Azure Data Factory (ADF)");
  assert.equal(resolved?.canonical, "Azure Data Factory");
});

test("an unrecognized skill resolves to null, never dropped or guessed", () => {
  assert.equal(resolveCanonicalSkill("SomeBrandNewToolNotInTaxonomy"), null);
});

test("normalizeCandidateSkills preserves every entry, including unresolved ones, and never mutates rawSkillName", () => {
  const p = profile([
    { rawSkillName: "Python", source: "employer" },
    { rawSkillName: "SomeBrandNewToolNotInTaxonomy", source: "inventory_only" },
  ]);
  const normalized = normalizeCandidateSkills(p);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].canonicalSkillName, "Python");
  assert.equal(normalized[1].canonicalSkillName, null);
  assert.equal(normalized[1].rawSkillName, "SomeBrandNewToolNotInTaxonomy", "raw truth must survive unnormalized");
});

// --- Taxonomy coverage pass regression tests (distinct Azure services must never cross-satisfy
// each other merely because they share the word "Azure") --------------------------------------

test("distinct Azure services each resolve to their OWN distinct canonical name, never the generic 'Azure' bucket", () => {
  const services = [
    "Azure Key Vault",
    "Azure DevOps",
    "Azure OpenAI",
    "Azure AI Search",
    "Azure AI Document Intelligence",
    "Azure Synapse Analytics",
    "Azure Data Factory",
    "ADLS Gen2",
    "Azure SQL",
    "Microsoft Fabric",
  ];
  const canonicals = services.map((s) => resolveCanonicalSkill(s)?.canonical);
  assert.ok(canonicals.every((c) => c !== "Azure"), "no distinct Azure service should collapse into the generic Azure canonical");
  assert.equal(new Set(canonicals).size, services.length, "every distinct service must resolve to its OWN distinct canonical — none may cross-satisfy another");
});

test("Snowflake (the data warehouse) and Snowflake Schema (a data-modeling pattern) never conflate", () => {
  assert.equal(resolveCanonicalSkill("Snowflake")?.canonical, "Snowflake");
  assert.equal(resolveCanonicalSkill("Snowflake Schema")?.canonical, "Snowflake Schema");
  assert.notEqual(resolveCanonicalSkill("Snowflake")?.canonical, resolveCanonicalSkill("Snowflake Schema")?.canonical);
});

test("generic collision-prone words are never aliased bare (Delta, Fabric, Functions)", () => {
  assert.equal(resolveCanonicalSkill("Delta"), null, "'Delta' alone must stay unrecognized — 'Delta Lake' only matches the full phrase");
  assert.equal(resolveCanonicalSkill("Fabric"), null, "'Fabric' alone must stay unrecognized — too generic/collision-prone as a bare alias");
});

test("AKS correctly aliases to Kubernetes (same underlying technology, not a false-positive risk)", () => {
  assert.equal(resolveCanonicalSkill("AKS")?.canonical, "Kubernetes");
});

test("unrecognizedCandidateSkillNames surfaces exactly the taxonomy-unmatched raw names", () => {
  const p = profile([
    { rawSkillName: "Python", source: "employer" },
    { rawSkillName: "ObscureInternalTool", source: "inventory_only" },
  ]);
  const unrecognized = unrecognizedCandidateSkillNames(normalizeCandidateSkills(p));
  assert.deepEqual(unrecognized, ["ObscureInternalTool"]);
});
