import test from "node:test";
import assert from "node:assert/strict";
import type { CandidateProfile } from "@/lib/match/types";
import { buildEmployerEvidenceMap, renderEmployerEvidenceSection } from "../employerEvidence";
import { classifyForEmployer, mayUseAtEmployer } from "../msiEvidence";
import { evaluateMsiCompliance } from "../reviewers/msiComplianceChecks";
import { checkPresentationAttribution } from "../presentationStructure";
import { CANONICAL_TAILORING_INSTRUCTIONS } from "../canonicalInstructions";
import { renderPresentationStandardSection } from "../presentationStructure";
import { evaluateQualityGate } from "../qualityGate";
import { DEFAULT_MAX_ITERATIONS } from "../types";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";

/**
 * The MSI evidence contract.
 *
 * Two rules under test: the Master Skills Inventory is genuine candidate evidence rather than a
 * keyword list, and an MSI-supported skill may be used across the candidate's listed clients unless
 * the inventory explicitly scopes it. Everything else — no-fabrication, employers/titles/dates,
 * certifications, years, one-primary-technology-per-bullet, layout — must be exactly as it was.
 */

const PROFILE: CandidateProfile = {
  schemaVersion: 1,
  sourceHashes: { resume: "r", skills: "s" },
  builtAt: "2026-01-01T00:00:00Z",
  skills: [
    // Declared, unrestricted — the Example A case.
    { rawSkillName: "Snowflake", source: "employer", attributedTo: [{ employer: "Client A" }] },
    { rawSkillName: "PySpark", source: "inventory_only" },
    // Declared, EXPLICITLY scoped — the Example C case.
    { rawSkillName: "Kubernetes", source: "employer", attributedTo: [{ employer: "Client A" }], restrictedToEmployers: ["Client A"] },
  ],
  experience: [
    { employer: "Client A", title: "Data Engineer", startDate: "2021-03", endDate: null, technologies: ["Snowflake", "Kubernetes"] },
    { employer: "Client B", title: "Data Engineer", startDate: "2019-06", endDate: "2021-02", technologies: ["SQL"] },
  ],
  education: [],
  certifications: [{ name: "SnowPro Core", issuer: "Snowflake" }],
  totalYearsExperience: null,
} as CandidateProfile;

const resume = (over: Partial<ResumeContent> = {}): ResumeContent =>
  ({
    name: "Test Candidate",
    summary: [],
    skillGroups: [],
    experience: [],
    education: [],
    certifications: [],
    ...over,
  }) as unknown as ResumeContent;

test("MSI-1 an MSI-supported skill may be used at another listed client when unrestricted", () => {
  assert.equal(mayUseAtEmployer(PROFILE, "Snowflake", "Client B"), true);
  assert.equal(classifyForEmployer(PROFILE, "Snowflake", "Client B"), "MSI_EVIDENCE");
  const b = buildEmployerEvidenceMap(PROFILE).employers.find((e) => e.employer === "Client B")!;
  assert.ok(b.availableViaMsi.includes("Snowflake"));
});

test("MSI-2 it is not rejected merely because the Master Resume lacks it under that employer", () => {
  // Snowflake is written only under Client A. Client B's Environment line must still be accepted.
  const issues = checkPresentationAttribution(
    resume({
      experience: [
        { company: "Client B", title: "Data Engineer", dates: "2019 – 2021", location: "", projectDescription: "", bullets: ["Built ingestion pipelines."], environment: ["Snowflake"] },
      ],
    } as Partial<ResumeContent>),
    PROFILE
  );
  assert.deepEqual(issues, [], "the Master Resume's silence under Client B is not evidence of absence");

  const b = buildEmployerEvidenceMap(PROFILE).employers.find((e) => e.employer === "Client B")!;
  assert.ok(!b.prohibitedHere.includes("Snowflake"), "silence must never become a prohibition");
});

test("MSI-3 explicit client-scoped MSI evidence stays restricted", () => {
  assert.equal(classifyForEmployer(PROFILE, "Kubernetes", "Client B"), "CLIENT_SCOPED_ELSEWHERE");
  assert.equal(mayUseAtEmployer(PROFILE, "Kubernetes", "Client B"), false);
  assert.equal(mayUseAtEmployer(PROFILE, "Kubernetes", "Client A"), true, "it is still usable where it IS scoped");

  const b = buildEmployerEvidenceMap(PROFILE).employers.find((e) => e.employer === "Client B")!;
  assert.ok(b.prohibitedHere.includes("Kubernetes"));
  assert.ok(!b.availableViaMsi.includes("Kubernetes"));

  const issues = checkPresentationAttribution(
    resume({
      experience: [
        { company: "Client B", title: "Data Engineer", dates: "2019 – 2021", location: "", projectDescription: "", bullets: ["Ran workloads."], environment: ["Kubernetes"] },
      ],
    } as Partial<ResumeContent>),
    PROFILE
  );
  assert.ok(issues.length > 0, "an explicitly scoped technology must still be rejected elsewhere");
});

test("MSI-4 a skill in neither the Master Resume nor the MSI stays unsupported", () => {
  assert.equal(classifyForEmployer(PROFILE, "Terraform", "Client A"), "UNSUPPORTED");
  assert.equal(mayUseAtEmployer(PROFILE, "Terraform", "Client A"), false);
  for (const e of buildEmployerEvidenceMap(PROFILE).employers) {
    assert.ok(!e.supported.includes("Terraform"));
    assert.ok(!e.availableViaMsi.includes("Terraform"), "nothing may make an undeclared technology available");
  }
});

test("MSI-4b the ungrounded-technology reviewer still catches a fabricated skill", () => {
  const r = evaluateMsiCompliance(
    resume({
      skillGroups: [{ label: "Cloud", items: ["Terraform"] }],
      experience: [],
    } as unknown as Partial<ResumeContent>),
    PROFILE
  );
  assert.ok(r.ungroundedTechnologies.includes("Terraform"), "no-fabrication behaviour is unchanged");
});

test("MSI-5 employers, titles and dates are untouched by the evidence widening", () => {
  const map = buildEmployerEvidenceMap(PROFILE);
  assert.deepEqual(map.employers.map((e) => e.employer), ["Client A", "Client B"]);
  assert.deepEqual(map.employers.map((e) => e.title), ["Data Engineer", "Data Engineer"]);
  // The evidence map exposes no date surface at all — dates remain the truthfulness reviewer's.
  assert.ok(!Object.keys(map.employers[0]).some((k) => /date/i.test(k)));
});

test("MSI-6 certification rules are untouched — the contract concerns technologies only", () => {
  const section = renderEmployerEvidenceSection(buildEmployerEvidenceMap(PROFILE));
  assert.match(section, /certifications, project identity and chronology are hard facts/i);
  assert.doesNotMatch(section, /certification.*may be (added|inferred|incorporated)/i);
});

test("MSI-7 years-of-experience rules are untouched", () => {
  const section = renderEmployerEvidenceSection(buildEmployerEvidenceMap(PROFILE));
  assert.doesNotMatch(section, /years? of experience may/i);
  // The classifier reads no years field and cannot influence one.
  assert.equal(classifyForEmployer(PROFILE, "Snowflake", "Client B"), "MSI_EVIDENCE");
});

test("MSI-8 one-primary-technology-per-bullet survives, and is restated where it now matters most", () => {
  const section = renderEmployerEvidenceSection(buildEmployerEvidenceMap(PROFILE));
  assert.match(section, /One PRIMARY technology or capability per bullet still applies/i);
  assert.match(section, /does not license keyword stuffing/i);
  assert.match(CANONICAL_TAILORING_INSTRUCTIONS, /ONE primary technology|one primary/i);
});

test("MSI-10 deterministic validation still runs and cannot be bypassed", () => {
  // No profile → the checker reports nothing rather than passing something it could not verify.
  assert.deepEqual(checkPresentationAttribution(resume(), undefined), []);
  assert.equal(evaluateMsiCompliance(resume(), undefined).insufficientProfileData, true);
  // With a profile, a violation is still produced (see MSI-3) — the path is live, not short-circuited.
});

test("MSI-9 the frozen presentation/layout contract is unchanged by this pass", () => {
  const std = renderPresentationStandardSection(PROFILE);
  // Section order, the Project:/Environment: lines and the full-sentence rule are the layout
  // contract the writer is held to. Widening evidence must not have touched any of it.
  assert.match(std, /projectDescription/);
  assert.match(std, /environment/);
  assert.match(std, /Write every bullet as a complete sentence/i);
  // The one line that DID change is the Environment rule's evidence clause — it must still require
  // per-employer grounding and still say it is checked automatically.
  assert.match(std, /Available here under the MSI rule/i);
  assert.match(std, /checked automatically, per employer, per item/i);
  // And it must not have become permissive about anything else.
  assert.match(std, /Introducing anything new here is a truthfulness failure/i);
});

test("MSI-11 Stage 21 gate semantics and the iteration cap are unchanged", () => {
  assert.equal(DEFAULT_MAX_ITERATIONS, 2, "the iteration cap is protected behaviour");
  /* The gate is fail-closed and this change feeds it nothing new. A review that does not satisfy
   * every condition must not reach READY, and must escalate rather than pass — asserted here with a
   * deliberately incomplete review, which is the state the widening could plausibly have loosened. */
  const incomplete = {
    overallScore: 100,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    blockingIssues: [],
    blockingFailures: [],
  } as unknown as Parameters<typeof evaluateQualityGate>[0];

  assert.notEqual(evaluateQualityGate(incomplete, 1, DEFAULT_MAX_ITERATIONS), "READY", "missing compliance data must never pass");
  assert.equal(evaluateQualityGate(incomplete, 1, DEFAULT_MAX_ITERATIONS), "IMPROVEMENT_NEEDED");
  assert.equal(
    evaluateQualityGate(incomplete, DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_ITERATIONS),
    "NEEDS_HUMAN_REVIEW",
    "at the cap it escalates to human review rather than shipping"
  );
});

test("MSI-A the canonical instructions and the evidence section no longer contradict each other", () => {
  const section = renderEmployerEvidenceSection(buildEmployerEvidenceMap(PROFILE));
  // The canonical rule permits bringing an MSI technology into an employer responsibility.
  assert.match(
    CANONICAL_TAILORING_INSTRUCTIONS,
    /may be incorporated into an employer\/project responsibility even when that exact technology is not currently written/i
  );
  // The section used to flatly forbid exactly that. It must not any more.
  assert.doesNotMatch(section, /you may only present the technologies under/i);
  assert.doesNotMatch(section, /Global skill evidence is not employer-specific experience evidence/i);
  assert.match(section, /Available here under the MSI rule/);
});
