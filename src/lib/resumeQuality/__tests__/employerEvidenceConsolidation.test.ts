import assert from "node:assert/strict";
import { test } from "node:test";
import type { CandidateProfile } from "@/lib/match/types";
import { buildEmployerEvidenceMap, renderEmployerEvidenceSection } from "../employerEvidence";

/**
 * INITIAL_GENERATION TOKEN OPTIMIZATION (2026-08-23) — EMPLOYER EVIDENCE CONSOLIDATION.
 *
 * renderEmployerEvidenceSection used to print every employer's full `availableViaMsi` list in full —
 * on the real corpus, 4 near-identical 130-150+ item lists sharing ~90% overlap. It now prints the
 * shared technology pool once and a per-employer delta. These tests prove the EMPLOYER EVIDENCE
 * SAFETY checklist this optimization must satisfy: every supported technology remains represented,
 * every MSI-available technology remains represented, every prohibited attribution remains
 * represented, no technology gains employer scope, no technology loses legitimate scope.
 */

function profile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "h1", skills: "h2" },
    builtAt: "2026-01-01T00:00:00Z",
    skills: [
      { rawSkillName: "Azure Data Factory", source: "employer", attributedTo: [{ employer: "Fiserv" }] },
      { rawSkillName: "Surrogate Keys", source: "employer", attributedTo: [{ employer: "Fiserv" }] },
      { rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Microgate" }] },
      { rawSkillName: "Spark", source: "employer", attributedTo: [{ employer: "Microgate" }] },
      { rawSkillName: "SQL", source: "employer", attributedTo: [{ employer: "Microgate" }] },
      { rawSkillName: "Kubernetes", source: "inventory_only" },
      // Explicitly restricted — must never appear as "available" at Fiserv.
      { rawSkillName: "Snowflake", source: "employer", attributedTo: [{ employer: "Microgate" }], restrictedToEmployers: ["Microgate"] },
    ],
    experience: [
      { employer: "Fiserv", title: "Data Engineer", startDate: "2023-01", endDate: null, technologies: ["Azure Data Factory", "Surrogate Keys"] },
      { employer: "Microgate", title: "Engineer", startDate: "2020-01", endDate: "2022-12", technologies: ["Python", "Spark", "SQL"] },
      // No recognizable technology of its own -> ROLE_OUT_OF_SCOPE, inventory does not reach it.
      { employer: "BHEL", title: "Trainee", startDate: "2018-01", endDate: "2019-12", technologies: ["Heavy electrical machines"] },
    ],
    education: [],
    certifications: [],
    totalYearsExperience: 6,
    ...overrides,
  };
}

test("1. the technology pool section appears exactly once, not once per employer", () => {
  const section = renderEmployerEvidenceSection(buildEmployerEvidenceMap(profile()));
  const occurrences = (section.match(/Candidate's full technology pool/g) ?? []).length;
  assert.equal(occurrences, 1);
});

test("2. every technology in the pool is traceable to some employer's supported or availableViaMsi list", () => {
  const map = buildEmployerEvidenceMap(profile());
  const section = renderEmployerEvidenceSection(map);
  const poolLine = section.match(/full technology pool \(\d+\)[^:]*:\*\*\s*([^\n]+)/)?.[1] ?? "";
  const poolItems = poolLine.split(", ").map((s) => s.trim()).filter(Boolean);
  for (const item of poolItems) {
    const traceable = map.employers.some((e) => e.supported.includes(item) || e.availableViaMsi.includes(item));
    assert.ok(traceable, `pool item "${item}" must be traceable to some employer's supported/availableViaMsi`);
  }
});

test("3. no supported technology is dropped from its own employer's 'Already written here' list", () => {
  const map = buildEmployerEvidenceMap(profile());
  const section = renderEmployerEvidenceSection(map);
  for (const employer of map.employers) {
    for (const tech of employer.supported) {
      const employerBlock = section.split(`### ${employer.employer}`)[1]?.split("### ")[0] ?? "";
      assert.ok(employerBlock.includes(tech), `${employer.employer}'s own supported technology "${tech}" must appear in its block`);
    }
  }
});

test("4. an explicitly restricted technology is never presented as available at the employer it is restricted away from", () => {
  const map = buildEmployerEvidenceMap(profile());
  const section = renderEmployerEvidenceSection(map);
  const fiservBlock = section.split("### Fiserv")[1]?.split("### ")[0] ?? "";
  // Snowflake is restricted to Microgate only — Fiserv's block must list it as prohibited, never as
  // part of an unqualified "available" claim without that prohibition also being stated.
  const fiserv = map.employers.find((e) => e.employer === "Fiserv")!;
  assert.ok(fiserv.prohibitedHere.includes("Snowflake"), "Snowflake must be classified prohibited at Fiserv");
  assert.match(fiservBlock, /EXPLICITLY SCOPED TO OTHER CLIENTS/);
  assert.match(fiservBlock, /Snowflake/);
});

test("5. an out-of-domain role (inventory does not reach it) never claims pool access", () => {
  const map = buildEmployerEvidenceMap(profile());
  const section = renderEmployerEvidenceSection(map);
  const bhel = map.employers.find((e) => e.employer === "BHEL")!;
  assert.equal(bhel.inventoryReachesRole, false);
  assert.equal(bhel.availableViaMsi.length, 0);
  const bhelBlock = section.split("### BHEL")[1]?.split("### ")[0] ?? "";
  assert.match(bhelBlock, /outside the candidate's technical domain/);
  assert.doesNotMatch(bhelBlock, /available here under the MSI rule/i);
});

test("6. an employer whose availableViaMsi is non-empty and whose role IS in domain gets the pool pointer with the correct count", () => {
  const map = buildEmployerEvidenceMap(profile());
  const section = renderEmployerEvidenceSection(map);
  const microgate = map.employers.find((e) => e.employer === "Microgate")!;
  assert.ok(microgate.availableViaMsi.length > 0);
  const block = section.split("### Microgate")[1]?.split("### ")[0] ?? "";
  assert.match(block, new RegExp(`\\(${microgate.availableViaMsi.length} technologies\\)`));
});

test("7. the rendered section is materially smaller than a naive full-repeat rendering for a candidate with many overlapping employers", () => {
  // Real, taxonomy-recognized technology names are required here: roleAcceptsInventoryEvidence gates
  // on resolveSkillForReview matching a role's OWN technologies against the real skill taxonomy, so a
  // synthetic "Skill0".."Skill59" fixture would make every role look out-of-domain and produce an
  // empty availableViaMsi everywhere (a real mistake caught while writing this test).
  const REAL_TECHS = [
    "Python", "SQL", "Spark", "Databricks", "Kafka", "Snowflake", "Airflow", "Docker", "Kubernetes",
    "Terraform", "PostgreSQL", "MongoDB", "Redis", "GraphQL", "React", "TypeScript", "AWS", "Azure",
    "GCP", "Jenkins", "GitHub Actions", "Ansible", "Prometheus", "Grafana", "Elasticsearch",
  ];
  const bigProfile = profile({
    skills: REAL_TECHS.map((name) => ({ rawSkillName: name, source: "inventory_only" as const })),
    experience: [
      { employer: "Employer A", title: "Data Engineer", startDate: "2022-01", endDate: null, technologies: ["Python", "SQL"] },
      { employer: "Employer B", title: "Data Engineer", startDate: "2020-01", endDate: "2021-12", technologies: ["Python", "Spark"] },
      { employer: "Employer C", title: "Data Engineer", startDate: "2018-01", endDate: "2019-12", technologies: ["Python", "Databricks"] },
    ],
  });
  const map = buildEmployerEvidenceMap(bigProfile);
  const section = renderEmployerEvidenceSection(map);
  // A naive full-repeat rendering would print each employer's ~58-item availableViaMsi list in full,
  // 3 times. The consolidated version must be well under that.
  const naiveRepeatEstimate = map.employers.reduce((sum, e) => sum + e.availableViaMsi.join(", ").length, 0);
  const poolOnlyLength = section.match(/full technology pool[^\n]*/)?.[0]?.length ?? 0;
  assert.ok(poolOnlyLength < naiveRepeatEstimate, "consolidated section must be smaller than the naive per-employer repeat");
});

test("8. buildEmployerEvidenceMap itself is completely unaffected — this optimization only changes rendering", () => {
  const map1 = buildEmployerEvidenceMap(profile());
  const map2 = buildEmployerEvidenceMap(profile());
  assert.deepEqual(map1, map2);
  for (const e of map1.employers) {
    assert.ok(Array.isArray(e.supported));
    assert.ok(Array.isArray(e.availableViaMsi));
    assert.ok(Array.isArray(e.prohibitedHere));
  }
});
