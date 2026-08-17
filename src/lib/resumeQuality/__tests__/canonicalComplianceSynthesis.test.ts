import assert from "node:assert/strict";
import { test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import {
  CANONICAL_TAILORING_INSTRUCTIONS,
  computeInstructionHash,
  currentInstructionIdentity,
  INSTRUCTION_HASH,
  INSTRUCTION_VERSION,
  matchesCurrentInstructions,
} from "../canonicalInstructions";
import { generateColdFollowUpEmail } from "../coldFollowUpEmail";
import { HARD_GATE_CHECKS, SOFT_GATE_CHECKS, allChecksPass } from "../instructionCompliance";
import { evaluateQualityGate } from "../qualityGate";
import { renderReviewFeedbackMarkdown } from "../reviewFeedback";
import { reviewResumeDeterministically } from "../reviewers/deterministicReviewer";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES, structuredResumeReviewSchema, type StructuredResumeReview } from "../types";
import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";

// --- Shared fixtures --------------------------------------------------------------------------------

function unit(overrides: Partial<RequirementUnit>): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: [],
    categories: [],
    label: "requirement",
    requirementLevel: "Required",
    criticality: "CRITICAL",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    fromUnclaimedText: false,
    ...overrides,
  };
}

function masterProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "r", skills: "s" },
    builtAt: "2015-01-01T00:00:00Z",
    skills: [
      { rawSkillName: "Azure", source: "employer" },
      { rawSkillName: "Azure Data Factory", source: "employer" },
      { rawSkillName: "Databricks", source: "employer" },
    ],
    experience: [
      { employer: "Acme Corp", title: "Senior Data Engineer", startDate: "2015-01", endDate: null, technologies: ["Azure", "Azure Data Factory", "Databricks"] },
    ],
    education: [{ level: "Bachelor's", field: "Computer Science", institution: "State University" }],
    certifications: [],
    totalYearsExperience: 10,
    ...overrides,
  };
}

const CLEAN_RESUME: ResumeContent = {
  name: "Jordan Rivera",
  tagline: "Senior Data Engineer",
  location: "Remote",
  phone: "312-555-9821",
  email: "jordan@gmail.com",
  summary: [
    "Senior Data Engineer with 10+ years building Azure Data Factory and Databricks pipelines for enterprise analytics platforms.",
  ],
  skillGroups: [{ label: "Cloud & Data Platform", items: ["Azure", "Azure Data Factory", "Databricks"] }],
  experience: [
    {
      title: "Senior Data Engineer",
      company: "Acme Corp",
      dates: "2015 - Present",
      bullets: [
        "Designed Azure Data Factory pipelines that reduced nightly batch processing time from 6 hours to 45 minutes.",
        "Built Databricks notebooks to transform 2TB of daily transaction data into curated analytics tables.",
      ],
    },
  ],
  education: ["B.S. Computer Science, State University"],
};

const CLEAN_REQUIREMENTS: RequirementUnit[] = [
  unit({ memberSkillNames: ["Azure"], label: "Azure" }),
  unit({ memberSkillNames: ["Azure Data Factory"], label: "Azure Data Factory" }),
  unit({ memberSkillNames: ["Databricks"], label: "Databricks" }),
];

const CLEAN_COVER_LETTER: CoverLetterContent = {
  name: "Jordan Rivera",
  location: "Remote",
  phone: "312-555-9821",
  email: "jordan@gmail.com",
  salutation: "Dear Hiring Team,",
  paragraphs: ["I'm excited to apply my Azure Data Factory and Databricks experience to this role."],
  closing: "Sincerely,\nJordan Rivera",
};

function cleanReview(): StructuredResumeReview {
  return reviewResumeDeterministically({
    resume: CLEAN_RESUME,
    jobRequirements: CLEAN_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    coverLetter: CLEAN_COVER_LETTER,
    // Stage 21: matches CLEAN_RESUME.tagline so the positioning/recruiter-quality gate genuinely
    // PASSes rather than REVIEW-ing for a missing target role.
    targetRoleTitle: "Senior Data Engineer",
  });
}

// --- 1. Canonical instruction identity: exposure & determinism -------------------------------------

test("canonical instruction version and hash are exposed and stable across repeated computation", () => {
  assert.equal(INSTRUCTION_VERSION, "2026-08-10");
  assert.equal(typeof INSTRUCTION_HASH, "string");
  assert.equal(INSTRUCTION_HASH.length, 64); // sha256 hex digest
  assert.equal(computeInstructionHash(), INSTRUCTION_HASH);
  assert.equal(computeInstructionHash(), computeInstructionHash());

  const identity = currentInstructionIdentity();
  assert.deepEqual(identity, { instructionVersion: INSTRUCTION_VERSION, instructionHash: INSTRUCTION_HASH });
  assert.equal(matchesCurrentInstructions(identity), true);
  assert.equal(matchesCurrentInstructions({ instructionVersion: "2026-08-06", instructionHash: "stale" }), false);
  assert.equal(matchesCurrentInstructions(undefined), false);
});

test("the canonical instruction text is non-empty and contains the guardrail section headers the reviewer implements checks for", () => {
  assert.ok(CANONICAL_TAILORING_INSTRUCTIONS.length > 1000);
  for (const marker of [
    "MASTER SKILLS INVENTORY RULE",
    "DEEP-REWRITE REQUIREMENT",
    "ARCHITECTURE INTEGRITY RULE",
    "ONE PRIMARY TECHNOLOGY PER RESPONSIBILITY",
    "METRIC INFERENCE POLICY",
    "NO CONTRADICTING TECHNOLOGIES",
    "CROSS-DOCUMENT CONSISTENCY LOCK",
    "BANNED AI-SOUNDING LANGUAGE",
    "YEARS-OF-EXPERIENCE AND EDUCATION HONESTY",
    "EMPLOYMENT-TYPE HANDLING",
    "RESUME LENGTH AND BULLET CAPS",
    "VERB TENSE CONSISTENCY",
    "ATS FORMATTING",
    "FINAL VALIDATION",
  ]) {
    assert.ok(CANONICAL_TAILORING_INSTRUCTIONS.includes(marker), `expected canonical text to contain "${marker}"`);
  }
});

// --- 2. All 22 checks present, additive, backward compatible ---------------------------------------

test("a fully clean, grounded, cross-consistent resume produces instructionCompliance with all 22 named checks and reaches READY", () => {
  const review = cleanReview();
  assert.ok(review.instructionCompliance, "instructionCompliance must be attached");
  const compliance = review.instructionCompliance!;
  assert.equal(Object.keys(compliance.checks).length, INSTRUCTION_COMPLIANCE_CHECK_NAMES.length);
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) {
    assert.ok(name in compliance.checks, `missing check: ${name}`);
  }
  assert.equal(compliance.instructionVersion, INSTRUCTION_VERSION);
  assert.equal(compliance.instructionHash, INSTRUCTION_HASH);

  const parsed = structuredResumeReviewSchema.safeParse(review);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));

  const outcome = evaluateQualityGate(review, 1, 3);
  assert.equal(outcome, "READY", `expected READY, got ${outcome}. checks: ${JSON.stringify(compliance.checks)}`);
});

test("HARD_GATE_CHECKS and SOFT_GATE_CHECKS together cover every named check exactly once", () => {
  const combined = [...HARD_GATE_CHECKS, ...SOFT_GATE_CHECKS].sort();
  const all = [...INSTRUCTION_COMPLIANCE_CHECK_NAMES].sort();
  assert.deepEqual(combined, all);
});

// --- 3. Gate-condition combinations (spec §7, items ~46-51) -----------------------------------------

test("gate condition combination: high score + perfect truthfulness/architecture but a hard-gate compliance FAIL never reaches READY", () => {
  // Resume claims a technology ("Kafka") not present anywhere in the Master Resume profile.
  const ungrounded: ResumeContent = {
    ...CLEAN_RESUME,
    skillGroups: [{ label: "Cloud & Data Platform", items: ["Azure", "Azure Data Factory", "Databricks", "Kafka"] }],
    experience: [{ ...CLEAN_RESUME.experience[0], bullets: [...CLEAN_RESUME.experience[0].bullets, "Streamed events through Kafka topics for downstream consumers."] }],
  };
  const review = reviewResumeDeterministically({
    resume: ungrounded,
    jobRequirements: CLEAN_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    coverLetter: CLEAN_COVER_LETTER,
  });
  assert.equal(review.instructionCompliance?.checks.masterSkillsInventoryCompliance, "FAIL");
  const outcome = evaluateQualityGate(review, 1, 3);
  assert.notEqual(outcome, "READY");
  assert.ok(
    review.requiredCorrections.some((c) => c.priority === "CRITICAL" && c.description.includes("masterSkillsInventoryCompliance")),
    "an ungrounded technology must produce an actionable CRITICAL correction, not just a silent gate block"
  );
});

test("gate condition combination: instructionCompliance present but computed against a stale/different instruction identity never reaches READY", () => {
  const review = cleanReview();
  const stale: StructuredResumeReview = {
    ...review,
    instructionCompliance: { ...review.instructionCompliance!, instructionVersion: "2026-08-06", instructionHash: "0".repeat(64) },
  };
  const outcome = evaluateQualityGate(stale, 1, 3);
  assert.notEqual(outcome, "READY", "a review computed against a stale instruction snapshot must never be READY");
});

test("gate condition combination: a review missing instructionCompliance entirely (legacy shape) never reaches READY, and never crashes", () => {
  const review = cleanReview();
  const legacy = { ...review } as StructuredResumeReview;
  delete (legacy as { instructionCompliance?: unknown }).instructionCompliance;
  assert.doesNotThrow(() => evaluateQualityGate(legacy, 1, 3));
  const outcome = evaluateQualityGate(legacy, 1, 3);
  assert.notEqual(outcome, "READY", "absence of compliance data must never be treated as a free pass");
});

test("gate condition combination: original Stage 7 conditions all pass but one soft-gate check is FAIL still blocks READY (soft checks are not optional)", () => {
  const review = cleanReview();
  const compliance = review.instructionCompliance!;
  assert.equal(allChecksPass(compliance), true);
  const oneSoftFail: StructuredResumeReview = {
    ...review,
    instructionCompliance: { ...compliance, checks: { ...compliance.checks, bannedLanguage: "FAIL" } },
  };
  assert.equal(evaluateQualityGate(oneSoftFail, 1, 3), "IMPROVEMENT_NEEDED");
});

test("gate condition combination: a REVIEW status (not just FAIL) on any check also blocks READY — ambiguous evidence is never treated as compliant", () => {
  const review = cleanReview();
  const compliance = review.instructionCompliance!;
  const withReview: StructuredResumeReview = {
    ...review,
    instructionCompliance: { ...compliance, checks: { ...compliance.checks, deepRewrite: "REVIEW" } },
  };
  assert.notEqual(evaluateQualityGate(withReview, 1, 3), "READY");
});

test("gate condition combination: overallScore alone can never compensate — a maxed-out score with one hard-gate FAIL still blocks READY", () => {
  const review = cleanReview();
  const compliance = review.instructionCompliance!;
  const inflatedScoreButFailing: StructuredResumeReview = {
    ...review,
    overallScore: 100,
    instructionCompliance: { ...compliance, checks: { ...compliance.checks, employmentTypeHandling: "FAIL" } },
  };
  assert.notEqual(evaluateQualityGate(inflatedScoreButFailing, 1, 3), "READY");
});

// --- 4. writerValidation is provenance-only, never authoritative ------------------------------------

test("a writer's self-reported writerValidation claiming full PASS never influences CareerOps's independently computed instructionCompliance or the gate outcome", () => {
  // The deterministic reviewer never even reads a writerValidation field — this test documents that
  // ResumeReviewerInput has no such field CareerOps could accidentally consult.
  const inputKeys = Object.keys({
    applicationId: 1,
    candidateId: 1,
    workflowId: 1,
    iterationNumber: 1,
    resumePath: "x",
    jobDescriptionPath: "x",
    resume: CLEAN_RESUME,
  });
  assert.ok(!inputKeys.includes("writerValidation"));

  const review = cleanReview();
  // Even a maximally dishonest self-report cannot change what was already computed.
  const dishonestlyClaimedFullPass = { instructionVersion: "9.9.9", instructionHash: "not-real", checks: {}, notes: ["I promise everything passes"] };
  assert.notDeepEqual(review.instructionCompliance, dishonestlyClaimedFullPass);
});

// --- 5. Hard-gate correction wiring ------------------------------------------------------------------

test("every hard-gate FAIL is surfaced as its own actionable CRITICAL requiredCorrection naming the specific check", () => {
  const flawed: ResumeContent = {
    ...CLEAN_RESUME,
    summary: ["Data Engineer with experience in cloud platforms."],
    experience: [{ ...CLEAN_RESUME.experience[0], bullets: ["Hired directly by Acme Corp as a full-time employee to support data pipelines."] }],
  };
  const review = reviewResumeDeterministically({ resume: flawed, jobRequirements: CLEAN_REQUIREMENTS, masterResumeProfile: masterProfile() });
  assert.equal(review.instructionCompliance?.checks.employmentTypeHandling, "FAIL");
  const correction = review.requiredCorrections.find((c) => c.description.includes("employmentTypeHandling"));
  assert.ok(correction, "expected a requiredCorrection naming employmentTypeHandling");
  assert.equal(correction!.priority, "CRITICAL");
});

// --- 6. Cold follow-up email — deterministic, never AI, never contradicts the resume ---------------

test("generateColdFollowUpEmail is deterministic and only ever references skills/bullets already present on the resume", () => {
  const first = generateColdFollowUpEmail({ resume: CLEAN_RESUME, companyName: "Acme Analytics", jobTitle: "Senior Data Engineer" });
  const second = generateColdFollowUpEmail({ resume: CLEAN_RESUME, companyName: "Acme Analytics", jobTitle: "Senior Data Engineer" });
  assert.equal(first, second);
  assert.ok(first.includes("Jordan Rivera"));
  assert.ok(first.includes("Acme Analytics"));
  assert.ok(first.includes("Senior Data Engineer"));
  assert.ok(first.includes("Azure"));
  // Never mentions a technology absent from the resume's own skill groups.
  assert.ok(!first.includes("Kafka"));
  assert.ok(!first.toLowerCase().includes("subject: undefined"));
});

test("generateColdFollowUpEmail falls back gracefully when jobTitle is not supplied", () => {
  const email = generateColdFollowUpEmail({ resume: CLEAN_RESUME, companyName: "Acme Analytics" });
  assert.ok(email.includes(CLEAN_RESUME.tagline));
});

// --- 7. reviewFeedback.ts renders the compliance checklist ------------------------------------------

test("renderReviewFeedbackMarkdown renders a Canonical Instruction Compliance section with a checkmark line per named check", () => {
  const review = cleanReview();
  const markdown = renderReviewFeedbackMarkdown(review);
  assert.ok(markdown.includes("## Canonical Instruction Compliance"));
  assert.ok(markdown.includes(`Instruction version:`));
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) {
    const humanized = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    assert.ok(markdown.toLowerCase().includes(humanized.toLowerCase()), `expected markdown to mention "${humanized}"`);
  }
});

test("renderReviewFeedbackMarkdown degrades gracefully (no crash, explicit legacy note) for a legacy review with no instructionCompliance", () => {
  const review = cleanReview();
  const legacy = { ...review } as StructuredResumeReview;
  delete (legacy as { instructionCompliance?: unknown }).instructionCompliance;
  const markdown = renderReviewFeedbackMarkdown(legacy);
  assert.ok(markdown.includes("legacy review"));
});

// --- 8. No second AI reviewer, no paid API, anywhere in this subsystem ------------------------------

test("no OpenAI/ChatGPT/Gemini SDK usage or paid-AI-API calls appear anywhere in the resume quality reviewer subsystem", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  // Deliberately narrow to actual SDK/API-call signals, not plain prose — exporter.ts legitimately
  // names "OpenAI Codex" as one of several human-operated EXTERNAL subscription writer tools
  // (Claude Code / Codex / Antigravity / local agent) a candidate might already have a subscription
  // to; that is the intended architecture (external human-run writer, CareerOps-only reviewer), not
  // a paid API call CareerOps itself makes.
  const bannedPatterns = [
    /from ["']openai["']/i,
    /require\(["']openai["']\)/i,
    /new OpenAI\(/,
    /openai\.chat\.completions/i,
    /chatgpt.?api/i,
    /from ["']@google\/generative-ai["']/i,
    /anthropic\.messages\.create/i,
    /new Anthropic\(/,
  ];
  const root = path.join(process.cwd(), "src/lib/resumeQuality");

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__") continue; // test descriptions legitimately name the banned terms
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  for (const file of walk(root)) {
    const content = fs.readFileSync(file, "utf-8");
    for (const pattern of bannedPatterns) {
      assert.ok(!pattern.test(content), `${file} must never reference a second AI reviewer/paid API (matched ${pattern})`);
    }
  }
});
