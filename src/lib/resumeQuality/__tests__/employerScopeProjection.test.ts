import assert from "node:assert/strict";
import { test } from "node:test";
import { filterEmployerEvidenceMap } from "../employerEvidence";
import type { EmployerEvidenceMap } from "../employerEvidence";
import { filterRoleProjectEvidence } from "../presentationStructure";
import type { RoleProjectEvidence } from "../presentationStructure";
import { employerScopeForRepair } from "../repairScope";
import type { RepairOperation, RepairPlan } from "../repairScope";

/**
 * SUMMARY QUALITY + WRITER TOKEN OPTIMIZATION (2026-08-23) — TARGETED_REPAIR context reduction.
 *
 * These are pure-function unit tests for the three small projections handoff/exporter.ts composes to
 * scope a repair's writer-facing employer evidence to only the employers a repair's own operations
 * actually touch. Deliberately unit-level (no DB/fixture harness) — exporter.ts's own wiring is
 * covered by the full existing externalHandoff.test.ts integration suite, which continues to pass
 * unchanged; these tests exist so the SCOPING DECISION itself (which employers survive, which are
 * dropped, and the safe defaults when scope is ambiguous) is directly verifiable and doesn't rely on
 * reading the exporter's control flow to trust.
 */

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

function plan(operations: RepairOperation[] | undefined): RepairPlan {
  return {
    scope: "RESUME_ONLY",
    reason: "test",
    resumeFindings: [],
    coverLetterFindings: [],
    unattributedFindings: [],
    operations,
  } as RepairPlan;
}

// --- employerScopeForRepair --------------------------------------------------------------------

test("employerScopeForRepair returns exactly the distinct employers named across operations", () => {
  const scope = employerScopeForRepair(plan([op({ employer: "Comerica Bank" }), op({ employer: "Fiserv" }), op({ employer: "Comerica Bank" })]));
  assert.ok(scope);
  assert.deepEqual([...scope!].sort(), ["Comerica Bank", "Fiserv"]);
});

test("employerScopeForRepair returns null (no filter) when the plan is undefined", () => {
  assert.equal(employerScopeForRepair(undefined), null);
});

test("employerScopeForRepair returns null (no filter) when operations is undefined", () => {
  assert.equal(employerScopeForRepair(plan(undefined)), null);
});

test("employerScopeForRepair returns null (no filter, the safe default) when every operation is unattributed to any employer", () => {
  const scope = employerScopeForRepair(plan([op({ employer: undefined, section: "summary" }), op({ employer: undefined, section: "skills" })]));
  assert.equal(scope, null, "an ambiguous signal must default to including everyone, never to zero employers");
});

test("employerScopeForRepair ignores operations with no employer while still scoping to the ones that have one", () => {
  const scope = employerScopeForRepair(plan([op({ employer: "Fiserv" }), op({ employer: undefined, section: "summary" })]));
  assert.ok(scope);
  assert.deepEqual([...scope!], ["Fiserv"]);
});

// --- filterEmployerEvidenceMap -------------------------------------------------------------------

function evidenceMap(employers: string[]): EmployerEvidenceMap {
  return {
    employers: employers.map((employer) => ({
      employer,
      title: "Data Engineer",
      supported: ["Databricks"],
      availableViaMsi: [],
      prohibitedHere: [],
      inventoryReachesRole: true,
    })),
    inventoryOnlyCount: 0,
  };
}

test("filterEmployerEvidenceMap keeps only employers in scope", () => {
  const map = evidenceMap(["Comerica Bank", "Fiserv", "Microgate Technologies"]);
  const filtered = filterEmployerEvidenceMap(map, new Set(["Fiserv"]));
  assert.deepEqual(filtered.employers.map((e) => e.employer), ["Fiserv"]);
  assert.equal(filtered.inventoryOnlyCount, map.inventoryOnlyCount, "inventoryOnlyCount is a resume-wide fact, not per-employer — must pass through unchanged");
});

test("filterEmployerEvidenceMap with scope=null returns the map completely unchanged (INITIAL_GENERATION's own path)", () => {
  const map = evidenceMap(["Comerica Bank", "Fiserv"]);
  assert.deepEqual(filterEmployerEvidenceMap(map, null), map);
});

test("filterEmployerEvidenceMap never mutates the original map", () => {
  const map = evidenceMap(["Comerica Bank", "Fiserv"]);
  const before = JSON.stringify(map);
  filterEmployerEvidenceMap(map, new Set(["Fiserv"]));
  assert.equal(JSON.stringify(map), before);
});

// --- filterRoleProjectEvidence -------------------------------------------------------------------

function roleEvidence(employers: string[]): RoleProjectEvidence[] {
  return employers.map((employer) => ({
    employer,
    title: "Data Engineer",
    evidencedTechnologies: ["Databricks"],
    bulletCount: 3,
    supportsProjectLine: true,
  }));
}

test("filterRoleProjectEvidence keeps only roles in scope", () => {
  const evidence = roleEvidence(["Comerica Bank", "Fiserv"]);
  const filtered = filterRoleProjectEvidence(evidence, new Set(["Comerica Bank"]));
  assert.deepEqual(filtered.map((e) => e.employer), ["Comerica Bank"]);
});

test("filterRoleProjectEvidence with scope=null returns the evidence completely unchanged", () => {
  const evidence = roleEvidence(["Comerica Bank", "Fiserv"]);
  assert.deepEqual(filterRoleProjectEvidence(evidence, null), evidence);
});

test("filterRoleProjectEvidence against an empty scope keeps nothing (deliberately reachable only when the caller passes a real, non-null, non-empty-signal scope)", () => {
  const evidence = roleEvidence(["Comerica Bank", "Fiserv"]);
  assert.deepEqual(filterRoleProjectEvidence(evidence, new Set()), []);
});
