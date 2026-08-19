import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  checkSummaryOpening,
  deriveProfessionalIdentity,
  headlinePreservesIdentity,
  normalizeRoleTitle,
  renderProfessionalIdentitySection,
} from "../professionalIdentity";
import { evaluateQualityGate } from "../qualityGate";
import { determineFinalDisposition } from "../finalDisposition";
import { DEFAULT_MAX_ITERATIONS, INSTRUCTION_COMPLIANCE_CHECK_NAMES } from "../types";
import { INSTRUCTION_HASH, INSTRUCTION_VERSION } from "../canonicalInstructions";
import { stripTrailingSignature } from "../../../../tools/tailoring-engine/cover-letter-template";
import { generateResumeDocx } from "../../../../tools/tailoring-engine/resume-template";
import { generateCoverLetterDocx } from "../../../../tools/tailoring-engine/cover-letter-template";
import type { CandidateProfile } from "@/lib/match/types";
import type { ComplianceStatus, InstructionComplianceChecks, StructuredResumeReview } from "../types";
import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";

/**
 * Stage 30 — presentation-only corrections. Every case below is about how the SAME content is
 * described or laid out; none of them changes what content is produced.
 *
 * Pure + temp filesystem. No database, no Claude, no network.
 */

/** The candidate profile shape from the real corpus: a data engineer, no computed total YOE. */
const PROFILE: CandidateProfile = {
  schemaVersion: 1,
  sourceHashes: { resume: "r", skills: "s" },
  builtAt: "2026-01-01T00:00:00Z",
  skills: [],
  experience: [
    { employer: "Comerica Bank", title: "Data Engineer", startDate: "2025-02", endDate: null, technologies: [] },
    { employer: "Fiserv", title: "Senior Data Engineer", startDate: "2023-07", endDate: "2025-01", technologies: [] },
    { employer: "Microgate", title: "Data Engineer I", startDate: "2020-01", endDate: "2021-11", technologies: [] },
  ],
  education: [],
  certifications: [],
  totalYearsExperience: null,
} as unknown as CandidateProfile;

// =================================================================================================
// Issue 1 — professional summary opening
// =================================================================================================

test("S30-01 the summary must not begin with generic identity wording", () => {
  // The exact opening the real corpus produced.
  const real = "Engineer with close to five years of hands-on delivery across banking and payments.";
  const issues = checkSummaryOpening(real, null);
  assert.ok(issues.some((i) => i.kind === "GENERIC_OPENING"), "\"Engineer with...\" must be flagged");

  for (const bad of [
    "Professional with a background in data platforms.",
    "Experienced professional delivering pipelines.",
    "Results-driven professional building data systems.",
    "Candidate with strong Azure experience.",
  ]) {
    assert.ok(checkSummaryOpening(bad, null).some((i) => i.kind === "GENERIC_OPENING"), `must flag: ${bad}`);
  }

  // A real identity-led opening passes.
  const good = "Data Engineer specializing in Azure Databricks, PySpark, and SQL across banking and payments.";
  assert.deepEqual(checkSummaryOpening(good, null), [], "an identity-led opening must not be flagged");
});

test("S30-02 the summary cannot invent or estimate years of experience", () => {
  // CareerOps computed no total for this candidate, so any figure is the writer's own arithmetic.
  for (const bad of [
    "Data Engineer with close to five years of delivery.",
    "Data Engineer with over 4 years across banking.",
    "Data Engineer with roughly six years of experience.",
    "Data Engineer with 5+ years building pipelines.",
  ]) {
    const issues = checkSummaryOpening(bad, null);
    assert.ok(issues.some((i) => i.kind === "UNVERIFIED_YEARS"), `must flag unverified years: ${bad}`);
  }

  // Describing depth without counting it is fine.
  assert.deepEqual(
    checkSummaryOpening("Data Engineer delivering production pipelines on Azure Databricks.", null),
    [],
    "depth without a year count is acceptable"
  );

  // When CareerOps HAS a verified figure, stating it is not flagged as unverified.
  const withVerified = checkSummaryOpening("Data Engineer with 5 years of delivery.", 5);
  assert.ok(!withVerified.some((i) => i.kind === "UNVERIFIED_YEARS"));
});

// =================================================================================================
// Issue 2 — professional identity / headline
// =================================================================================================

test("S30-03 the headline preserves the candidate's professional identity", () => {
  const identity = deriveProfessionalIdentity(PROFILE);
  assert.ok(identity);
  assert.equal(identity.identity, "Data Engineer", "derived from the most recent role, seniority stripped");
  assert.ok(headlinePreservesIdentity("Data Engineer | Azure Databricks | PySpark | SQL", identity.identity));
  assert.ok(headlinePreservesIdentity("Senior Data Engineer | Cloud Data Platforms", identity.identity));
});

test("S30-04 a JD title alone cannot overwrite the candidate's identity", () => {
  const identity = deriveProfessionalIdentity(PROFILE)!;
  // The exact headline the real corpus produced, from a JD titled "Lead Software Engineer - ...".
  const fromJd = "Software Engineer - Python, SQL, Databricks, Java | Banking & Payments Data Platforms";
  assert.equal(
    headlinePreservesIdentity(fromJd, identity.identity),
    false,
    "a data engineer must not be re-labelled a software engineer to mirror the JD"
  );
  assert.equal(headlinePreservesIdentity("Machine Learning Engineer | Spark", identity.identity), false);
});

test("S30-05 the headline may still carry JD-relevant specialization after the identity", () => {
  const identity = deriveProfessionalIdentity(PROFILE)!;
  for (const headline of [
    "Data Engineer | Azure Databricks | PySpark | SQL | Cloud Data Platforms",
    "Data Engineer | Banking & Payments Data Platforms",
    "Data Engineer – Databricks & Delta Lake | Python",
  ]) {
    assert.ok(headlinePreservesIdentity(headline, identity.identity), `specialization must be allowed: ${headline}`);
  }
});

test("S30-13 identity derivation is evidence-driven and never fabricated", () => {
  assert.equal(normalizeRoleTitle("Senior Lead Data Engineer"), "Data Engineer");
  assert.equal(normalizeRoleTitle("Software Engineer III"), "Software Engineer");
  assert.equal(normalizeRoleTitle("Data Engineer - Databricks"), "Data Engineer");
  // No experience means no claim at all.
  const empty = { ...PROFILE, experience: [] } as unknown as CandidateProfile;
  assert.equal(deriveProfessionalIdentity(empty), null);
  assert.equal(renderProfessionalIdentitySection(null, null), "");
});

test("S30-14 the writer section states the identity rule and the no-invented-years rule", () => {
  const section = renderProfessionalIdentitySection(deriveProfessionalIdentity(PROFILE), null);
  assert.match(section, /Derived identity: Data Engineer/);
  // Stage 31.1 replaced "must LEAD with this professional identity" with the stricter rule that the
  // headline carries evidence-backed ROLE IDENTITIES ONLY. The identity requirement is unchanged —
  // it is now stated as "each supported by a title the candidate actually held", plus an explicit
  // prohibition on technologies and on the JD introducing an identity.
  assert.match(section, /professional ROLE IDENTITIES ONLY/);
  assert.match(section, /supported by a title the candidate actually held/);
  assert.match(section, /never put technologies in it/i);
  assert.match(section, /job's title never replaces the candidate's own/i);
  assert.match(section, /do NOT state one/i, "with no verified total, the writer must be told not to state years");
  assert.match(section, /close to five years/, "the exact failure mode is named so it cannot recur");

  const withYears = renderProfessionalIdentitySection(deriveProfessionalIdentity(PROFILE), 5);
  assert.match(withYears, /only verified figure is 5/);
});

// =================================================================================================
// Issue 3 — pagination
// =================================================================================================

function resumeFixture(bulletsPerRole: number): ResumeContent {
  const bullets = Array.from({ length: bulletsPerRole }, (_, i) => `Engineered pipeline component number ${i + 1} with measurable delivery impact across the platform.`);
  return {
    name: "Sai Kishore Reddy",
    tagline: "Data Engineer | Azure Databricks | PySpark",
    location: "Dallas, TX",
    phone: "(214) 555-0111",
    email: "candidate@gmail.test",
    summary: ["Data Engineer specializing in Azure Databricks and PySpark."],
    skillGroups: [{ label: "Cloud & Data", items: ["Azure Databricks", "PySpark"] }],
    experience: [
      { title: "Data Engineer", company: "Comerica Bank", dates: "Feb 2025 – Present", bullets: [...bullets] },
      { title: "Data Engineer", company: "Fiserv", dates: "Jul 2023 – Jan 2025", bullets: [...bullets] },
    ],
    education: ["M.S. Computer Science"],
  } as unknown as ResumeContent;
}


test("S30-06 the resume renderer emits no explicit page break", () => {
  const src = fs.readFileSync(path.resolve("tools/tailoring-engine/resume-template.ts"), "utf-8");
  assert.ok(!/pageBreakBefore/.test(src), "no paragraph may force a page break");
  assert.ok(!/new PageBreak\(/.test(src), "no explicit PageBreak run may be emitted");
});

test("S30-07 bullets are not chained to each other, so an employer may split across pages", () => {
  const src = fs.readFileSync(path.resolve("tools/tailoring-engine/resume-template.ts"), "utf-8");
  // The defect: `bullet(text, !isLast)` chained every bullet but the last into one unbreakable block.
  assert.ok(!/bullet\(text,\s*!isLast\)/.test(src), "bullets must no longer keepNext-chain to each other");
  assert.ok(/bullet\(text,\s*false\)/.test(src), "bullets must be individually breakable");
  // The role header still keeps with its first bullet — a heading is never orphaned. Stage 31 split
  // that header into a company line and a title line; BOTH must keep with what follows, or the
  // employer can now be stranded at a page foot in a way Stage 30 had already ruled out.
  for (const fn of ["function companyLine", "function roleTitleLine"]) {
    const body = src.slice(src.indexOf(fn), src.indexOf("}", src.indexOf("children:", src.indexOf(fn))));
    assert.ok(body.includes("keepNext: true"), `${fn} must keep with the line that follows it`);
  }
  // Each bullet still keeps its own lines together.
  assert.ok(/keepLines: true/.test(src) && /widowControl: true/.test(src), "a single bullet must never split mid-sentence");
});

test("S30-08 Stage 30 introduces no bullet-count reduction policy", async () => {
  const content = resumeFixture(8);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s30-count-"));
  try {
    const out = path.join(dir, "Resume.docx");
    await generateResumeDocx(content, out);
    assert.ok(fs.existsSync(out), "the resume must render");
    // The renderer takes bullets verbatim; nothing in Stage 30 filters, truncates, or caps them.
    const src = fs.readFileSync(path.resolve("tools/tailoring-engine/resume-template.ts"), "utf-8");
    assert.ok(!/\.slice\(0,\s*\d+\)/.test(src), "the renderer must not truncate bullet lists");
    assert.ok(/for \(const text of role\.bullets\)/.test(src), "every bullet is rendered");
    assert.equal(content.experience[0].bullets.length, 8, "the fixture's bullets are untouched by rendering");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =================================================================================================
// Issue 4 — duplicate cover-letter signature
// =================================================================================================

test("S30-09 the closing keeps its salutation and the name is emitted exactly once", () => {
  const name = "Sai Kishore Reddy";
  // The exact value the real corpus produced.
  assert.equal(stripTrailingSignature("Sincerely,\nSai Kishore Reddy", name), "Sincerely,");
  // Writer variations all normalise to the same thing.
  assert.equal(stripTrailingSignature("Sincerely,\n\n  Sai Kishore Reddy  ", name), "Sincerely,");
  assert.equal(stripTrailingSignature("Sincerely,\nSai Kishore Reddy.", name), "Sincerely,");
  assert.equal(stripTrailingSignature("Best regards,", name), "Best regards,");
  // A body line that merely mentions the name is not a signature and must survive.
  assert.equal(
    stripTrailingSignature("Sincerely,\nSai Kishore Reddy is available immediately", name),
    "Sincerely,\nSai Kishore Reddy is available immediately"
  );
});

test("S30-15 the RENDERED cover letter carries exactly one closing signature", async () => {
  const content: CoverLetterContent = {
    name: "Sai Kishore Reddy",
    location: "Dallas, TX",
    phone: "(214) 555-0111",
    email: "candidate@gmail.test",
    salutation: "Dear Hiring Team,",
    paragraphs: ["I build production data pipelines."],
    // Exactly what the real writer produced: the name already inside the closing.
    closing: "Sincerely,\nSai Kishore Reddy",
  } as unknown as CoverLetterContent;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s30-sig-"));
  try {
    const out = path.join(dir, "CoverLetter.docx");
    await generateCoverLetterDocx(content, out);

    const zip = await import("node:zlib");
    void zip;
    const { execFileSync } = await import("node:child_process");
    // Read word/document.xml out of the .docx (a zip) without adding a dependency.
    const xml = execFileSync("unzip", ["-p", out, "word/document.xml"], { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
    const texts = [...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);

    // The closing paragraph keeps only its salutation, and the name follows exactly once after it.
    const closingIndex = texts.findIndex((t) => t.trim() === "Sincerely,");
    assert.ok(closingIndex >= 0, `the closing salutation must survive, got: ${JSON.stringify(texts.slice(-4))}`);
    const afterClosing = texts.slice(closingIndex + 1).filter((t) => t.trim() === "Sai Kishore Reddy");
    assert.equal(afterClosing.length, 1, `exactly one signature name must follow the closing, found ${afterClosing.length}`);

    // And the closing paragraph itself no longer embeds the name.
    assert.ok(!texts.some((t) => t.includes("Sincerely,") && t.includes("Sai Kishore Reddy")), "the closing must not embed the name");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S30-10 signature normalization leaves the cover-letter body untouched", async () => {
  const content: CoverLetterContent = {
    name: "Sai Kishore Reddy",
    location: "Dallas, TX",
    phone: "(214) 555-0111",
    email: "candidate@gmail.test",
    salutation: "Dear Hiring Team,",
    paragraphs: [
      "I build production data pipelines on Azure Databricks.",
      "At Comerica Bank I engineered PySpark workloads over regulated banking data.",
    ],
    closing: "Sincerely,\nSai Kishore Reddy",
  } as unknown as CoverLetterContent;

  const before = JSON.parse(JSON.stringify(content.paragraphs));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s30-cl-"));
  try {
    await generateCoverLetterDocx(content, path.join(dir, "CoverLetter.docx"));
    assert.deepEqual(content.paragraphs, before, "rendering must not mutate the body");
    assert.equal(content.closing, "Sincerely,\nSai Kishore Reddy", "the source content is never rewritten in place");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =================================================================================================
// Frozen semantics
// =================================================================================================

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

test("S30-11 READY semantics are unchanged by Stage 30", () => {
  assert.equal(DEFAULT_MAX_ITERATIONS, 2);
  assert.equal(evaluateQualityGate(review(), 1, 2), "READY");
  assert.notEqual(evaluateQualityGate(review({ overallScore: 94 }), 1, 2), "READY");
  assert.notEqual(evaluateQualityGate(review({ truthfulnessScore: 99 }), 1, 2), "READY");
  assert.notEqual(
    evaluateQualityGate(review({ blockingFailures: [{ type: "UNSUPPORTED_CLAIM", description: "x" }] }), 1, 2),
    "READY"
  );
});

test("S30-12 SAFE_BEST_ATTEMPT semantics are unchanged by Stage 30", () => {
  const truthfulButWeak = review({
    overallScore: 78,
    recruiterQualityAssessment: { status: "REVIEW", score: 40, issues: [] },
    instructionCompliance: {
      instructionVersion: INSTRUCTION_VERSION,
      instructionHash: INSTRUCTION_HASH,
      checks: { ...allChecks("PASS"), technologyGrouping: "REVIEW", finalValidation: "FAIL" },
      notes: [],
    },
  });
  const safe = determineFinalDisposition([{ iterationNumber: 1, review: truthfulButWeak }]);
  assert.equal(safe.disposition, "SAFE_BEST_ATTEMPT");
  assert.equal(safe.humanMaySend, true);

  const unsafe = determineFinalDisposition([
    { iterationNumber: 1, review: review({ overallScore: 100, blockingFailures: [{ type: "EMPLOYER_CONTRADICTION", description: "x" }] }) },
  ]);
  assert.equal(unsafe.disposition, "BLOCKED");
  assert.equal(unsafe.humanMaySend, false);
});
