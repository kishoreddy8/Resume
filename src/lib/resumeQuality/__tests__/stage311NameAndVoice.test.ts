import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";

// Set BEFORE anything imports src/db: getDb() resolves the path once, and every test in this file
// must be unable to touch the production database. The candidates queries are therefore imported
// dynamically, inside the one test that needs them.
process.env.CAREER_OPS_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "stage311-db-")),
  "test.db"
);

import {
  checkSummaryOpening,
  describeNarrationIssue,
  findThirdPersonNarration,
} from "../professionalIdentity";
import { finalCoverLetterFilename, finalResumeFilename, sanitizeNameSegment } from "../workspace";
import { generateResumeDocx } from "../../../../tools/tailoring-engine/resume-template";
import { generateCoverLetterDocx } from "../../../../tools/tailoring-engine/cover-letter-template";
import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";

/**
 * Stage 31.1 — the candidate's display name, and the voice the summary is written in.
 *
 * Pure/local: no database writes outside a temp DB, no network, no Claude.
 */

const DISPLAY_NAME = "Saikishore Reddy";

function resume(name = DISPLAY_NAME): ResumeContent {
  return {
    name,
    tagline: "Data Engineer | Azure Data Platform | Databricks",
    location: "Dallas, TX",
    phone: "+1 (945) 237-0560",
    email: "real.candidate@realmail.com",
    summary: ["Data Engineer specializing in Azure Databricks and Delta Lake."],
    skillGroups: [{ label: "Cloud & Data Platforms", items: ["Azure Databricks"] }],
    certifications: ["Microsoft Certified: Azure Data Engineer Associate (DP-203)"],
    experience: [
      {
        title: "Data Engineer",
        company: "Comerica Bank",
        dates: "Feb 2025 – Present",
        projectDescription: "Delta Lake curation on Azure Databricks.",
        bullets: ["Built PySpark transformations in Azure Databricks."],
        environment: ["Azure Databricks", "Delta Lake"],
      },
    ],
    education: ["Master of Science in Computer Science, Chicago State University — Jan 2022 – May 2023"],
  };
}

function coverLetter(name = DISPLAY_NAME): CoverLetterContent {
  return {
    name,
    location: "Dallas, TX",
    phone: "+1 (945) 237-0560",
    email: "real.candidate@realmail.com",
    salutation: "Dear Hiring Team,",
    paragraphs: ["I am applying for the Senior Data Engineer role."],
    closing: `Sincerely,\n${name}`,
  };
}

async function renderedParagraphs(render: (out: string) => Promise<void>): Promise<{ texts: string[]; xml: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage311-"));
  const out = path.join(dir, "doc.docx");
  await render(out);
  const xml = (await (await JSZip.loadAsync(fs.readFileSync(out))).file("word/document.xml")!.async("string")) ?? "";
  const texts = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
    .map(([, body]) =>
      [...body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join("").trim()
    )
    .filter((t) => t.length > 0);
  return { texts, xml };
}

// --- Name ---------------------------------------------------------------------------------------

test("S311-01 the display name survives rendering exactly — never re-split or re-joined", async () => {
  const { texts } = await renderedParagraphs((out) => generateResumeDocx(resume(), out));
  assert.equal(texts[0], DISPLAY_NAME, "the resume heading is the display name verbatim");
  assert.ok(!texts.some((t) => t.includes("Sai Kishore")), "the name must never be re-split into two words");
});

test("S311-02 the cover letter heading uses the same display name", async () => {
  const { texts } = await renderedParagraphs((out) => generateCoverLetterDocx(coverLetter(), out));
  assert.equal(texts[0], DISPLAY_NAME);
});

test("S311-03 the cover letter signs off with the display name exactly once", async () => {
  const { texts } = await renderedParagraphs((out) => generateCoverLetterDocx(coverLetter(), out));
  assert.equal(texts[texts.length - 1], DISPLAY_NAME, "the last line is the signature");
  assert.equal(texts[texts.length - 2], "Sincerely,", "the closing keeps its salutation");
  // Letterhead + signature = 2. Anything more is the duplicate-signature defect returning.
  assert.equal(texts.filter((t) => t === DISPLAY_NAME).length, 2, "letterhead once, signature once — never twice at the end");
});

test("S311-04 final filenames use the sanitized candidate first name", () => {
  assert.equal(finalResumeFilename("Saikishore"), "Saikishore_Resume.docx");
  assert.equal(finalCoverLetterFilename("Saikishore"), "Saikishore_CoverLetter.docx");
});

test("S311-05 a first name containing a space can never reach a filename unsanitized", () => {
  // The defect the human-review package had: it interpolated candidate.first_name directly, so the
  // same candidate got "Sai Kishore_Resume_HumanReview.docx" from one path and
  // "SaiKishore_Resume.docx" from the other.
  assert.equal(sanitizeNameSegment("Sai Kishore"), "SaiKishore");
  assert.ok(!finalResumeFilename("Sai Kishore").includes(" "), "no filename may contain a space");
  const source = fs.readFileSync(path.resolve("src/lib/resumeQuality/humanReviewPackage.ts"), "utf-8");
  assert.match(source, /sanitizeNameSegment\(candidate\?\.first_name/, "the human-review package must sanitize too");
});

test("S311-06 the name fix is generic — nothing is hardcoded to this candidate", async () => {
  for (const other of ["Ada Lovelace", "Jean-Luc Picard", "María José Ruiz"]) {
    const { texts } = await renderedParagraphs((out) => generateResumeDocx(resume(other), out));
    assert.equal(texts[0], other, `${other} must render verbatim`);
  }
  assert.equal(sanitizeNameSegment("Jean-Luc"), "JeanLuc");
  for (const file of ["tools/tailoring-engine/resume-template.ts", "src/lib/resumeQuality/workspace.ts", "src/db/queries/candidates.ts"]) {
    const source = fs.readFileSync(path.resolve(file), "utf-8");
    assert.ok(
      !/["'`]Saikishore Reddy["'`]/.test(source),
      `${file} must not hardcode this candidate's name`
    );
  }
});

test("S311-07 updateCandidateName stores the display name verbatim, and only rebuilds it when absent", async () => {
  const { createCandidate, getCandidate, updateCandidateName } = await import("@/db/queries/candidates");
  const created = createCandidate({ firstName: "Sai Kishore", lastName: "Reddy" });
  assert.equal(created.display_name, "Sai Kishore Reddy", "creation joins the parts — this is the drift this stage fixes");

  const fixed = updateCandidateName(created.id, {
    firstName: "Saikishore",
    lastName: "Reddy",
    displayName: DISPLAY_NAME,
  })!;
  assert.equal(fixed.display_name, DISPLAY_NAME, "an explicit display name is stored exactly as given");
  assert.equal(fixed.first_name, "Saikishore");
  assert.equal(getCandidate(created.id)!.display_name, DISPLAY_NAME, "and it persists");

  // Omitting displayName keeps the historical join, so existing callers are unaffected.
  const rejoined = updateCandidateName(created.id, { firstName: "Ada", lastName: "Lovelace" })!;
  assert.equal(rejoined.display_name, "Ada Lovelace");

  assert.throws(() => updateCandidateName(created.id, { firstName: " ", lastName: "Reddy" }));
});

// --- Summary voice ------------------------------------------------------------------------------

test("S311-08 the exact third-person sentences the real corpus produced are detected", () => {
  const issues = findThirdPersonNarration([
    "Data Engineer specializing in enterprise data ingestion and distributed batch processing.",
    "Owns ETL delivery end to end: incremental CDC ingestion, PySpark and Spark SQL transformation logic.",
    "Works directly with product, finance, and reporting stakeholders to document pipeline designs.",
  ]);
  assert.equal(issues.length, 2, `expected exactly the two narrated sentences: ${JSON.stringify(issues)}`);
  assert.deepEqual(issues.map((i) => i.verb), ["Owns", "Works"]);
  assert.match(describeNarrationIssue(issues[0]), /implied first person/);
  assert.match(describeNarrationIssue(issues[0]), /do not fix this by putting the whole summary in the past tense/i);
});

test("S311-09 every prohibited narration verb is caught, in any summary paragraph", () => {
  const verbs = ["Owns", "Works", "Builds", "Develops", "Manages", "Leads", "Creates", "Implements", "Maintains", "Collaborates"];
  for (const verb of verbs) {
    const issues = findThirdPersonNarration(["Data Engineer specializing in Delta Lake.", `${verb} the data platform for finance teams.`]);
    assert.equal(issues.length, 1, `${verb} must be detected`);
    assert.equal(issues[0].verb, verb);
  }
  // Mid-paragraph sentences count too — not just the paragraph's first sentence.
  assert.equal(findThirdPersonNarration(["Specializing in Delta Lake. Owns the ingestion platform."]).length, 1);
});

test("S311-10 capability-style alternatives all pass", () => {
  const accepted = [
    "Data Engineer specializing in enterprise data ingestion and distributed batch processing.",
    "Experienced in end-to-end ETL delivery, including incremental CDC ingestion and Type 2 SCD history.",
    "Brings hands-on experience across Spark batch processing, Python ingestion utilities, and SQL modeling.",
    "Expertise in governed Azure lakehouse platforms in financial services.",
    "Proven experience delivering scheduled data pipelines in production.",
    "Skilled in PySpark and Spark SQL transformation logic.",
    "Hands-on experience with Snowflake and Unix shell automation.",
    "Experienced collaborating with product, finance, and reporting stakeholders to define test cases.",
  ];
  assert.deepEqual(findThirdPersonNarration(accepted), [], "no capability construction may be flagged");
});

test("S311-11 the check does not fire on the same words used as anything but a sentence-opening verb", () => {
  const innocent = [
    "Experienced with frameworks and networks across distributed systems.",
    "Understands how Spark works internally is not a claim made here; Working knowledge of Azure applies.",
    "Skilled in Databricks Workflows and Azure Logic Apps.",
    "Expertise in leads-management data models and builds-per-day telemetry.",
  ];
  assert.deepEqual(findThirdPersonNarration(innocent), [], `no false positives: ${JSON.stringify(findThirdPersonNarration(innocent))}`);
});

test("S311-12 narration is a presentation finding — it never becomes a truthfulness blocker", async () => {
  const { evaluateStructuralChecks } = await import("../reviewers/structuralChecks");
  const { evaluateTruthfulness } = await import("../reviewers/truthfulnessChecks");
  const narrated = resume();
  narrated.summary = ["Data Engineer specializing in Delta Lake.", "Owns ETL delivery end to end."];

  const structural = evaluateStructuralChecks(narrated);
  assert.ok(structural.formattingScore < 100, "it must cost formatting score");
  assert.ok(structural.corrections.some((c) => /third person/.test(c.description)), "and reach the writer");

  // Truthfulness is untouched by voice: the sentence is badly written, not untrue.
  assert.equal(evaluateTruthfulness(narrated, undefined).truthfulnessScore, 85, "the no-profile baseline, unchanged");
});

// --- Stage 30/31 rules must survive -------------------------------------------------------------

test("S311-13 the identity-opening and unverified-years rules are still enforced", () => {
  for (const bad of [
    "Engineer with a decade of delivery.",
    "Data Engineer with deep Azure experience.",
    "Professional with broad platform exposure.",
    "Candidate with strong SQL.",
    "Results-driven professional delivering data platforms.",
    "Seasoned professional in data engineering.",
    "Experienced professional delivering data platforms.",
  ]) {
    assert.ok(checkSummaryOpening(bad, null).some((i) => i.kind === "GENERIC_OPENING"), `must still be rejected: ${bad}`);
  }
  for (const years of [
    "Data Engineer specializing in Delta Lake with close to five years of delivery.",
    "Data Engineer specializing in Delta Lake across nearly five years.",
    "Data Engineer specializing in Delta Lake over 6 years.",
  ]) {
    assert.ok(
      checkSummaryOpening(years, null).some((i) => i.kind === "UNVERIFIED_YEARS"),
      `unverified years must still be rejected: ${years}`
    );
  }
  // The approved opening still passes both rules.
  assert.deepEqual(checkSummaryOpening("Data Engineer specializing in enterprise data ingestion.", null), []);
});

test("S311-14 no italic styling is emitted anywhere in either document", async () => {
  const r = await renderedParagraphs((out) => generateResumeDocx(resume(), out));
  const c = await renderedParagraphs((out) => generateCoverLetterDocx(coverLetter(), out));
  assert.equal((r.xml.match(/<w:i\/>/g) ?? []).length, 0, "the resume must contain no italic runs");
  assert.equal((c.xml.match(/<w:i\/>/g) ?? []).length, 0, "the cover letter must contain no italic runs");
  // The Project/Environment labels still carry emphasis — bold, not italic.
  assert.match(r.xml, /<w:b\/>/, "bold emphasis is retained");
  assert.ok(r.texts.some((t) => t.startsWith("Project: ")), "the Project line still renders");
  assert.ok(r.texts.some((t) => t.startsWith("Environment: ")), "the Environment line still renders");
});
