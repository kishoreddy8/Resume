import assert from "node:assert/strict";
import { test } from "node:test";
import { buildJdPriorityMatrix } from "../jdPriorityMatrix";
import { rankCandidateSkills, recommendedSkillOrder } from "../skillRanking";
import { JD_SHAPES, MULTI_JD_MASTER_PROFILE } from "./fixtures/multiJdCandidate";

test("core data-engineering skills outrank Docker/Kubernetes/observability for a data-engineering JD", () => {
  const matrix = buildJdPriorityMatrix(JD_SHAPES[0].requirements, "Senior Data Engineer", MULTI_JD_MASTER_PROFILE); // Snowflake-heavy
  const order = recommendedSkillOrder(MULTI_JD_MASTER_PROFILE, matrix);
  const idx = (s: string) => order.indexOf(s);
  assert.ok(idx("Snowflake") < idx("Docker"), `Snowflake (${idx("Snowflake")}) should rank above Docker (${idx("Docker")})`);
  assert.ok(idx("dbt") < idx("Docker"));
  assert.ok(idx("Airflow") < idx("Kubernetes"));
});

test("the inverse holds for a genuinely platform-engineering-centric JD — role relevance actually flips", () => {
  const matrix = buildJdPriorityMatrix(JD_SHAPES[3].requirements, "Platform Engineer", MULTI_JD_MASTER_PROFILE); // Platform-heavy
  const order = recommendedSkillOrder(MULTI_JD_MASTER_PROFILE, matrix);
  const idx = (s: string) => order.indexOf(s);
  assert.ok(idx("Terraform") < idx("Snowflake"), `Terraform (${idx("Terraform")}) should rank above Snowflake (${idx("Snowflake")}) for a platform JD`);
  assert.ok(idx("Docker") < idx("dbt"));
});

test("no unsupported JD skill ever enters the ranking — only candidate-evidenced skills appear", () => {
  const matrix = buildJdPriorityMatrix(JD_SHAPES[2].requirements, "AI Data Engineer", MULTI_JD_MASTER_PROFILE); // Azure OpenAI/RAG - unsupported
  const order = recommendedSkillOrder(MULTI_JD_MASTER_PROFILE, matrix);
  assert.ok(!order.includes("Azure OpenAI"));
  assert.ok(!order.includes("RAG"));
  assert.ok(!order.includes("Azure AI Search"));
  // Python (genuinely evidenced AND in this JD) still appears.
  assert.ok(order.includes("Python"));
});

test("STRONG evidence (used at an employer) outranks PARTIAL evidence (inventory-only) at the same JD tier", () => {
  const matrix = buildJdPriorityMatrix(
    [
      { kind: "skill", memberSkillNames: ["Snowflake"], categories: [], label: "Snowflake", requirementLevel: "Required", criticality: "CRITICAL", evidenceSnippets: [], experienceDepthRequired: false, requestedYears: null, fromUnclaimedText: false },
      { kind: "skill", memberSkillNames: ["PostgreSQL"], categories: [], label: "PostgreSQL", requirementLevel: "Required", criticality: "CRITICAL", evidenceSnippets: [], experienceDepthRequired: false, requestedYears: null, fromUnclaimedText: false },
    ],
    "Senior Data Engineer",
    MULTI_JD_MASTER_PROFILE
  );
  const ranked = rankCandidateSkills(MULTI_JD_MASTER_PROFILE, matrix);
  const snowflake = ranked.find((r) => r.skill === "Snowflake")!;
  const postgres = ranked.find((r) => r.skill === "PostgreSQL")!;
  assert.equal(snowflake.evidenceStrength, "STRONG"); // used at Northwind
  assert.equal(postgres.evidenceStrength, "PARTIAL"); // inventory_only in the fixture, never attributed to an employer
  assert.ok(snowflake.score > postgres.score);
});

test("recency: a skill used at the most recent employer ranks above an equal-tier, equal-evidence skill used only at an older employer", () => {
  const matrix = buildJdPriorityMatrix(
    [
      { kind: "skill", memberSkillNames: ["Snowflake"], categories: [], label: "Snowflake", requirementLevel: "Required", criticality: "CRITICAL", evidenceSnippets: [], experienceDepthRequired: false, requestedYears: null, fromUnclaimedText: false },
      { kind: "skill", memberSkillNames: ["Terraform"], categories: [], label: "Terraform", requirementLevel: "Required", criticality: "CRITICAL", evidenceSnippets: [], experienceDepthRequired: false, requestedYears: null, fromUnclaimedText: false },
    ],
    "Senior Data Engineer",
    MULTI_JD_MASTER_PROFILE
  );
  const ranked = rankCandidateSkills(MULTI_JD_MASTER_PROFILE, matrix);
  const snowflake = ranked.find((r) => r.skill === "Snowflake")!; // most recent employer (Northwind, current)
  const terraform = ranked.find((r) => r.skill === "Terraform")!; // oldest employer (Solstice, 2015-2018)
  assert.equal(snowflake.recentlyUsed, true);
  assert.equal(terraform.recentlyUsed, false);
  assert.ok(snowflake.score > terraform.score);
});

test("recency alone can never overcome a real priority-tier gap — a recently-used P4 skill still ranks below an older P1 skill", () => {
  const matrix = buildJdPriorityMatrix(JD_SHAPES[0].requirements, "Senior Data Engineer", MULTI_JD_MASTER_PROFILE);
  // In shape A, Docker is P4 and is NOT used at the most recent employer either, but even if it were,
  // 1.2x cannot bridge a P4(2)->P1(5) weight gap combined with equal evidence tiers.
  const ranked = rankCandidateSkills(MULTI_JD_MASTER_PROFILE, matrix);
  const snowflakeScore = ranked.find((r) => r.skill === "Snowflake")!.score; // P1, STRONG, recent = 5*3*1.2=18
  const dockerScore = ranked.find((r) => r.skill === "Docker")!.score; // P4, STRONG, not recent = 2*3*1.0=6
  assert.ok(snowflakeScore > dockerScore * 2, `expected a decisive gap: snowflake=${snowflakeScore} docker=${dockerScore}`);
});
