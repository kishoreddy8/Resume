import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExperienceEntry } from "../../../../tools/tailoring-engine/types";
import { buildJdPriorityMatrix } from "../jdPriorityMatrix";
import { evaluateBulletOrdering, rankBulletsForEntry } from "../bulletRanking";
import { JD_SHAPES, MULTI_JD_MASTER_PROFILE } from "./fixtures/multiJdCandidate";

test("a bullet mentioning a P1 requirement scores higher than one mentioning only a P4", () => {
  const entry: ExperienceEntry = {
    title: "Senior Data Engineer",
    company: "Northwind Logistics Analytics",
    dates: "2022 - Present",
    bullets: [
      "Set up Docker containers for local development.", // P4 in shape A
      "Architected a Snowflake data warehouse for logistics analytics.", // P1 in shape A
    ],
  };
  const matrix = buildJdPriorityMatrix(JD_SHAPES[0].requirements, "Senior Data Engineer", MULTI_JD_MASTER_PROFILE);
  const ranked = rankBulletsForEntry(entry, matrix);
  const docker = ranked.find((r) => r.bullet.includes("Docker"))!;
  const snowflake = ranked.find((r) => r.bullet.includes("Snowflake"))!;
  assert.ok(snowflake.jdRelevanceScore > docker.jdRelevanceScore);
  assert.deepEqual(snowflake.matchedRequirements, ["Snowflake"]);
});

test("evaluateBulletOrdering flags a buried highly-relevant bullet beneath a materially weaker one", () => {
  const experience: ExperienceEntry[] = [
    {
      title: "Senior Data Engineer",
      company: "Northwind Logistics Analytics",
      dates: "2022 - Present",
      bullets: [
        "Set up Docker containers for local development.", // P4, weak
        "Architected a Snowflake data warehouse consolidating regional systems.", // P1, strong - buried
      ],
    },
  ];
  const matrix = buildJdPriorityMatrix(JD_SHAPES[0].requirements, "Senior Data Engineer", MULTI_JD_MASTER_PROFILE);
  const issues = evaluateBulletOrdering(experience, matrix);
  assert.ok(issues.length > 0, "expected a buried-bullet issue to be flagged");
  assert.ok(issues[0].description.includes("Northwind Logistics Analytics"));
});

test("a correctly ordered role (strongest JD-relevant bullet first) produces zero ordering issues", () => {
  const experience: ExperienceEntry[] = [
    {
      title: "Senior Data Engineer",
      company: "Northwind Logistics Analytics",
      dates: "2022 - Present",
      bullets: [
        "Architected a Snowflake data warehouse consolidating regional systems.", // P1 first
        "Set up Docker containers for local development.", // P4 second
      ],
    },
  ];
  const matrix = buildJdPriorityMatrix(JD_SHAPES[0].requirements, "Senior Data Engineer", MULTI_JD_MASTER_PROFILE);
  assert.deepEqual(evaluateBulletOrdering(experience, matrix), []);
});

test("multi-JD: the same Solstice bullets rank very differently for a platform-heavy JD vs a Snowflake-heavy JD", () => {
  const solsticeEntry: ExperienceEntry = {
    title: "Platform Engineer",
    company: "Solstice Cloud Platforms",
    dates: "2015 - 2018",
    bullets: ["Managed infrastructure with Terraform and Docker on AKS.", "Set up Prometheus and Grafana monitoring."],
  };
  const snowflakeMatrix = buildJdPriorityMatrix(JD_SHAPES[0].requirements, "Senior Data Engineer", MULTI_JD_MASTER_PROFILE);
  const platformMatrix = buildJdPriorityMatrix(JD_SHAPES[3].requirements, "Platform Engineer", MULTI_JD_MASTER_PROFILE);

  const rankedForSnowflakeJd = rankBulletsForEntry(solsticeEntry, snowflakeMatrix);
  const rankedForPlatformJd = rankBulletsForEntry(solsticeEntry, platformMatrix);

  const terraformBulletScoreForSnowflakeJd = rankedForSnowflakeJd.find((r) => r.bullet.includes("Terraform"))!.jdRelevanceScore;
  const terraformBulletScoreForPlatformJd = rankedForPlatformJd.find((r) => r.bullet.includes("Terraform"))!.jdRelevanceScore;
  assert.ok(
    terraformBulletScoreForPlatformJd > terraformBulletScoreForSnowflakeJd,
    `expected the Terraform bullet to score higher for the platform JD (${terraformBulletScoreForPlatformJd}) than the Snowflake JD (${terraformBulletScoreForSnowflakeJd})`
  );
});
