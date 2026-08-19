import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTRUCTION_HASH, INSTRUCTION_VERSION } from "../canonicalInstructions";
import { buildEmployerEvidenceMap, renderEmployerEvidenceSection } from "../employerEvidence";
import { determineFinalDisposition, evaluateSafety, TRUTHFULNESS_COMPLIANCE_CHECKS } from "../finalDisposition";
import { evaluateQualityGate } from "../qualityGate";
import { DEFAULT_MAX_ITERATIONS, INSTRUCTION_COMPLIANCE_CHECK_NAMES } from "../types";
import type { ComplianceStatus, InstructionComplianceChecks, StructuredResumeReview } from "../types";
import type { CandidateProfile } from "@/lib/match/types";

/**
 * Stage 28 — fast pipeline, and the safety rules that speed must never buy.
 *
 * Pure tests: no database, no filesystem, no Claude, no network.
 */

function allChecks(status: ComplianceStatus): InstructionComplianceChecks {
  const checks = {} as InstructionComplianceChecks;
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) checks[name] = status;
  return checks;
}

function review(overrides: Partial<StructuredResumeReview> = {}): StructuredResumeReview {
  return {
    overallScore: 96,
    atsScore: 96,
    keywordAlignmentScore: 96,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 96,
    formattingScore: 100,
    missingRequiredSkills: [],
    incorrectTechnologyUsage: [],
    genericBullets: [],
    missingImpactEvidence: [],
    summaryIssues: [],
    skillsOrderingIssues: [],
    truthfulnessIssues: [],
    blockingIssues: [],
    requiredCorrections: [],
    blockingFailures: [],
    recruiterQualityAssessment: { status: "PASS", score: 100, issues: [] },
    instructionCompliance: {
      instructionVersion: INSTRUCTION_VERSION,
      instructionHash: INSTRUCTION_HASH,
      checks: allChecks("PASS"),
      notes: [],
    },
    ...overrides,
  } as StructuredResumeReview;
}

/** A truthful but merely-good attempt: every guardrail holds, optimisation sits in the 70-80 band. */
function safeButUnoptimized(score = 78): StructuredResumeReview {
  return review({
    overallScore: score,
    atsScore: score,
    recruiterQualityAssessment: { status: "REVIEW", score: 40, issues: [] },
    instructionCompliance: {
      instructionVersion: INSTRUCTION_VERSION,
      instructionHash: INSTRUCTION_HASH,
      checks: { ...allChecks("PASS"), technologyGrouping: "REVIEW", bulletWriting: "FAIL", finalValidation: "FAIL" },
      notes: [],
    },
  });
}

function attempt(iterationNumber: number, r: StructuredResumeReview) {
  return { iterationNumber, review: r };
}

// =================================================================================================
// A. Two-iteration budget
// =================================================================================================

test("S28-01 the content-iteration budget is 2", () => {
  assert.equal(DEFAULT_MAX_ITERATIONS, 2, "a third Claude content generation must not be reachable by default");
});

test("S28-02 the gate sends a failing attempt to human review at the 2-iteration bound, not to a third try", () => {
  const failing = review({ blockingIssues: ["something"] });
  assert.equal(evaluateQualityGate(failing, 1, DEFAULT_MAX_ITERATIONS), "IMPROVEMENT_NEEDED", "iteration 1 may be corrected");
  assert.equal(
    evaluateQualityGate(failing, 2, DEFAULT_MAX_ITERATIONS),
    "NEEDS_HUMAN_REVIEW",
    "after iteration 2 the answer is human review — never a third generation"
  );
});

// =================================================================================================
// B. Safety is absolute — a fabricated 100 must lose to a truthful 78
// =================================================================================================

test("S28-10 a truthful 78 is SAFE_BEST_ATTEMPT and a human may send it", () => {
  const result = determineFinalDisposition([attempt(1, safeButUnoptimized(78))]);
  assert.equal(result.disposition, "SAFE_BEST_ATTEMPT");
  assert.equal(result.safety.safe, true);
  assert.equal(result.optimizationScore, 78);
  assert.equal(result.humanMaySend, true);
  assert.ok(result.optimizationFindings.length > 0, "the human should see WHY it is not perfect");
});

test("S28-11 SAFE_BEST_ATTEMPT is never reported as READY", () => {
  const result = determineFinalDisposition([attempt(1, safeButUnoptimized(78))]);
  assert.notEqual(result.disposition, "READY", "a 78 must never be presented as a perfect result");
  // At the final iteration the gate still refuses it — SAFE_BEST_ATTEMPT is a separate, weaker
  // statement about safety, never a claim that the gate passed.
  assert.equal(evaluateQualityGate(safeButUnoptimized(78), 2, 2), "NEEDS_HUMAN_REVIEW", "and the gate itself still refuses it");
});

test("S28-12 a fabricated 100 loses to a truthful 78", () => {
  const fabricated100 = review({
    overallScore: 100,
    atsScore: 100,
    blockingFailures: [{ type: "UNSUPPORTED_CLAIM", description: "Claims Kubernetes, which no evidence supports." }],
  });
  const truthful78 = safeButUnoptimized(78);

  const result = determineFinalDisposition([attempt(1, fabricated100), attempt(2, truthful78)]);
  assert.equal(result.selectedIterationNumber, 2, "the truthful attempt must win despite scoring 22 points lower");
  assert.equal(result.disposition, "SAFE_BEST_ATTEMPT");
  assert.equal(result.safety.safe, true);
});

test("S28-13 when every attempt is unsafe the result is BLOCKED and no human may send it", () => {
  const unsafe = review({
    overallScore: 100,
    blockingFailures: [{ type: "EMPLOYER_CONTRADICTION", description: "Cover letter attributes Spark to Fiserv." }],
  });
  const result = determineFinalDisposition([attempt(1, unsafe), attempt(2, unsafe)]);
  assert.equal(result.disposition, "BLOCKED");
  assert.equal(result.humanMaySend, false);
  assert.ok(result.safety.blockers.some((b) => b.includes("EMPLOYER_CONTRADICTION")));
});

test("S28-14 every named absolute blocker is genuinely absolute", () => {
  const cases: [string, StructuredResumeReview][] = [
    ["fabricated/unsupported claim", review({ blockingFailures: [{ type: "UNSUPPORTED_CLAIM", description: "x" }] })],
    ["employer attribution", review({ blockingFailures: [{ type: "EMPLOYER_CONTRADICTION", description: "x" }] })],
    ["cross-artifact contradiction", review({ blockingFailures: [{ type: "CROSS_ARTIFACT_CONTRADICTION", description: "x" }] })],
    ["placeholder contact", review({ blockingFailures: [{ type: "PLACEHOLDER_CONTACT", description: "x" }] })],
    ["truthfulness score", review({ truthfulnessScore: 99 })],
    ["architecture contradiction", review({ architectureConsistencyScore: 99 })],
    ["safety never evaluated", review({ blockingFailures: undefined })],
    ["compliance never computed", review({ instructionCompliance: undefined })],
  ];
  for (const [label, r] of cases) {
    const verdict = evaluateSafety(r);
    assert.equal(verdict.safe, false, `${label} must be an absolute blocker even at a perfect score`);
    const disposition = determineFinalDisposition([attempt(1, r)]);
    assert.equal(disposition.disposition, "BLOCKED", `${label} must never reach a sendable state`);
    assert.equal(disposition.humanMaySend, false);
  }
});

test("S28-15 each truthfulness compliance check blocks on its own", () => {
  for (const check of TRUTHFULNESS_COMPLIANCE_CHECKS) {
    const r = review({
      instructionCompliance: {
        instructionVersion: INSTRUCTION_VERSION,
        instructionHash: INSTRUCTION_HASH,
        checks: { ...allChecks("PASS"), [check]: "FAIL" },
        notes: [],
      },
    });
    assert.equal(evaluateSafety(r).safe, false, `${check} must be treated as a truthfulness blocker`);
  }
});

test("S28-16 style/presentation weakness never blocks a truthful package", () => {
  const stylish = review({
    overallScore: 72,
    instructionCompliance: {
      instructionVersion: INSTRUCTION_VERSION,
      instructionHash: INSTRUCTION_HASH,
      checks: {
        ...allChecks("PASS"),
        technologyGrouping: "REVIEW",
        bulletWriting: "FAIL",
        bannedLanguage: "FAIL",
        verbTenseConsistency: "FAIL",
        resumeLengthBulletCaps: "REVIEW",
        finalValidation: "FAIL",
      },
      notes: [],
    },
  });
  const verdict = evaluateSafety(stylish);
  assert.equal(verdict.safe, true, `presentation problems must not be treated as fabrication: ${verdict.blockers.join("; ")}`);
  assert.equal(determineFinalDisposition([attempt(1, stylish)]).disposition, "SAFE_BEST_ATTEMPT");
});

test("S28-17 a genuinely perfect attempt is still READY, and the gate is unchanged", () => {
  const result = determineFinalDisposition([attempt(1, review())]);
  assert.equal(result.disposition, "READY");
  assert.equal(result.humanMaySend, true);
  assert.deepEqual(result.optimizationFindings, [], "a READY package has nothing to caveat");
  assert.equal(evaluateQualityGate(review(), 1, 2), "READY");
});

// =================================================================================================
// C. Employer-scoped evidence — the Stage 27 failure, prevented before writing
// =================================================================================================

const PROFILE: CandidateProfile = {
  schemaVersion: 1,
  sourceHashes: { resume: "r", skills: "s" },
  builtAt: "2026-01-01T00:00:00Z",
  skills: [
    { rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Microgate Technologies" }] },
    { rawSkillName: "Spark", source: "employer", attributedTo: [{ employer: "Microgate Technologies" }] },
    { rawSkillName: "Surrogate Keys", source: "employer", attributedTo: [{ employer: "Fiserv" }] },
    { rawSkillName: "Kubernetes", source: "inventory_only" },
  ],
  experience: [
    { employer: "Fiserv", title: "Data Engineer", startDate: "2021-01", endDate: "2023-01", technologies: ["Azure Data Factory"] },
    { employer: "Microgate Technologies", title: "Engineer", startDate: "2019-01", endDate: "2021-01", technologies: ["SQL"] },
  ],
  education: [],
  certifications: [],
} as unknown as CandidateProfile;

test("S28-20 employer evidence separates global skills from employer-specific experience", () => {
  const map = buildEmployerEvidenceMap(PROFILE);
  const fiserv = map.employers.find((e) => e.employer === "Fiserv")!;
  const microgate = map.employers.find((e) => e.employer === "Microgate Technologies")!;

  assert.ok(fiserv.supported.includes("Surrogate Keys"), "explicit attribution counts as support");
  assert.ok(fiserv.supported.includes("Azure Data Factory"), "the role's own bullets count as support");
  // The exact Stage 27 leakage, now stated as prohibited.
  for (const tech of ["Python", "Spark"]) {
    assert.ok(!fiserv.supported.includes(tech), `${tech} is not Fiserv evidence`);
    assert.ok(fiserv.notEvidencedHere.includes(tech), `${tech} must be explicitly prohibited at Fiserv`);
  }
  assert.ok(microgate.notEvidencedHere.includes("Surrogate Keys"), "Surrogate Keys must be prohibited at Microgate");
});

test("S28-21 inventory-only skills are attributed to no employer at all", () => {
  const map = buildEmployerEvidenceMap(PROFILE);
  for (const employer of map.employers) {
    assert.ok(!employer.supported.includes("Kubernetes"), `Kubernetes has no employer evidence, so ${employer.employer} must not support it`);
  }
  assert.equal(map.inventoryOnlyCount, 1);
});

test("S28-22 negative evidence is derived, never invented", () => {
  const map = buildEmployerEvidenceMap(PROFILE);
  const fiserv = map.employers.find((e) => e.employer === "Fiserv")!;
  // Only technologies genuinely evidenced SOMEWHERE may appear as prohibited-here; the module never
  // asserts the candidate lacks a skill, and never lists a technology nobody has evidence for.
  const evidencedSomewhere = new Set(["Python", "Spark", "Surrogate Keys", "Azure Data Factory", "SQL"]);
  for (const tech of fiserv.notEvidencedHere) {
    assert.ok(evidencedSomewhere.has(tech), `${tech} was invented as negative evidence`);
  }
  assert.ok(!fiserv.notEvidencedHere.includes("Kubernetes"), "an inventory-only skill is not employer-leakage");
});

test("S28-23 the rendered writer section states the stricter cover-letter rule", () => {
  const section = renderEmployerEvidenceSection(buildEmployerEvidenceMap(PROFILE));
  assert.match(section, /EMPLOYER-SCOPED EVIDENCE/);
  assert.match(section, /NOT evidenced here/);
  assert.match(section, /cover letter/i);
  assert.ok(
    section.includes("must also appear in the bullets you write for that same employer"),
    "the cover letter is validated against the written resume, not against this map — the writer must be told so"
  );
  assert.match(section, /wrong employer is a fabrication/i);
});

test("S28-24 an empty profile produces no employer section rather than an invented one", () => {
  const empty = { ...PROFILE, experience: [], skills: [] } as unknown as CandidateProfile;
  const map = buildEmployerEvidenceMap(empty);
  assert.deepEqual(map.employers, []);
  assert.equal(renderEmployerEvidenceSection(map), "");
});
