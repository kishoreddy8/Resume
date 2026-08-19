import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import {
  checkHeadline,
  checkSummaryQuality,
  checkSkillsBreadth,
  checkSummaryShape,
  countSentences,
  evaluatePresentationContract,
  findAiDashPunctuation,
  MAX_HEADLINE_SEGMENTS,
} from "../presentationContract";
import { findThirdPersonNarration } from "../professionalIdentity";
import { generateResumeDocx } from "../../../../tools/tailoring-engine/resume-template";
import { generateCoverLetterDocx } from "../../../../tools/tailoring-engine/cover-letter-template";
import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";

/**
 * Stage 31.1 — the resume presentation contract. Pure/local; no database, no network, no Claude.
 */

const PROFILE: CandidateProfile = {
  schemaVersion: 1,
  sourceHashes: { resume: "r", skills: "s" },
  builtAt: "2026-01-01T00:00:00.000Z",
  totalYearsExperience: null,
  skills: [{ rawSkillName: "Azure Databricks", source: "employer", attributedTo: [{ employer: "Comerica Bank" }] }],
  experience: [
    { employer: "Comerica Bank", title: "Data Engineer", startDate: "2025-02", endDate: null, technologies: ["Azure Databricks", "Delta Lake"] },
    { employer: "Fiserv", title: "Data Engineer", startDate: "2023-07", endDate: "2025-01", technologies: ["Azure Data Factory"] },
  ],
  education: [],
  certifications: [{ name: "Microsoft Certified: Azure Data Engineer Associate (DP-203)" }],
};

// Deliberately NOT three capability stems in a row — that is the template pattern S311C-42 rejects,
// and a fixture that models it would quietly assert the wrong thing everywhere it is used.
const GOOD_SUMMARY =
  "Data Engineer building governed lakehouse platforms for banking and payments data on Azure. " +
  "Pipeline ownership runs end to end, from source ingestion through release, feeding models that analytics " +
  "and risk teams query directly. " +
  "Careful tuning and incremental load design cut curated-layer runtime by 35%.";

function resume(overrides: Partial<ResumeContent> = {}): ResumeContent {
  return {
    name: "Saikishore Reddy",
    tagline: "Data Engineer | AI Engineer",
    location: "Dallas, TX",
    phone: "+1 (945) 237-0560",
    email: "real.candidate@realmail.com",
    summary: [GOOD_SUMMARY],
    skillGroups: [{ label: "Data Engineering / Processing", items: ["PySpark", "Azure Databricks", "Delta Lake"] }],
    certifications: ["Microsoft Certified: Azure Data Engineer Associate (DP-203)"],
    experience: [
      {
        title: "Data Engineer",
        company: "Comerica Bank",
        dates: "Feb 2025 - Present",
        projectDescription: "Delta Lake curation on Azure Databricks for deposit reporting.",
        bullets: ["Built PySpark transformations in Azure Databricks, cutting batch runtime 30%."],
        environment: ["Azure Databricks", "Delta Lake"],
      },
    ],
    education: ["Master of Science in Computer Science, Chicago State University — Jan 2022 – May 2023"],
    ...overrides,
  };
}

function coverLetter(overrides: Partial<CoverLetterContent> = {}): CoverLetterContent {
  return {
    name: "Saikishore Reddy",
    location: "Dallas, TX",
    phone: "+1 (945) 237-0560",
    email: "real.candidate@realmail.com",
    salutation: "Dear Hiring Team,",
    paragraphs: ["I am writing about the Senior Data Engineer role."],
    closing: "Sincerely,\nSaikishore Reddy",
    ...overrides,
  };
}

async function render(content: ResumeContent): Promise<{ texts: string[]; xml: string; numbering: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s311c-"));
  const out = path.join(dir, "Resume.docx");
  await generateResumeDocx(content, out);
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const xml = (await zip.file("word/document.xml")!.async("string")) ?? "";
  const numbering = (await zip.file("word/numbering.xml")?.async("string")) ?? "";
  const texts = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
    .map(([, b]) => [...b.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join("").trim())
    .filter((t) => t.length > 0);
  return { texts, xml, numbering };
}

// --- HEADLINE (tests 6-9) -----------------------------------------------------------------------

test("S311C-06 a role-identity headline passes", () => {
  assert.deepEqual(checkHeadline("Data Engineer | AI Engineer", undefined), []);
  assert.deepEqual(checkHeadline("Senior Data Engineer", PROFILE), []);
});

test("S311C-07 a technology-stack headline fails — including the exact one the real run produced", () => {
  const real = "Data Engineer | Cloud Data Ingestion & Distributed Batch Processing | Spark, PySpark, Python, Azure Databricks, Delta Lake, Snowflake";
  const issues = checkHeadline(real, PROFILE);
  assert.ok(issues.some((i) => i.kind === "HEADLINE_CONTAINS_TECHNOLOGY"), `must be rejected: ${JSON.stringify(issues)}`);
  assert.ok(issues.some((i) => i.kind === "HEADLINE_TOO_MANY_SEGMENTS") === false || real.split("|").length > MAX_HEADLINE_SEGMENTS);
  assert.ok(checkHeadline("Data Engineer | Python | Spark | Databricks", PROFILE).some((i) => i.kind === "HEADLINE_CONTAINS_TECHNOLOGY"));
});

test("S311C-08 a JD title cannot overwrite the candidate's identity", () => {
  // The candidate has only ever been a Data Engineer; the posting is for a Software Engineer.
  const issues = checkHeadline("Software Engineer | Big Data", PROFILE);
  assert.ok(issues.some((i) => i.kind === "HEADLINE_ROLE_NOT_EVIDENCED"));
  // Seniority variants of a real title stay allowed.
  assert.deepEqual(checkHeadline("Senior Data Engineer", PROFILE).filter((i) => i.kind === "HEADLINE_ROLE_NOT_EVIDENCED"), []);
});

test("S311C-09 an unevidenced role identity cannot be invented from JD vocabulary", () => {
  for (const invented of ["Data Engineer | AI Engineer", "Data Engineer | Machine Learning Engineer", "Cloud Engineer"]) {
    const issues = checkHeadline(invented, PROFILE);
    assert.ok(
      issues.some((i) => i.kind === "HEADLINE_ROLE_NOT_EVIDENCED"),
      `"${invented}" is not evidenced for this profile and must be flagged`
    );
  }
  // With no profile the claim cannot be checked, and is NOT asserted to be false.
  assert.deepEqual(checkHeadline("Data Engineer | AI Engineer", undefined), []);
});

// --- SUMMARY (tests 10-19) ----------------------------------------------------------------------

test("S311C-10 the summary renders as exactly ONE paragraph, however the writer segmented it", async () => {
  const fragmented = resume({
    summary: [
      "Data Engineer specializing in cloud-scale data engineering.",
      "Experienced in governed batch and incremental pipelines.",
      "Skilled in data modeling and performance optimization.",
    ],
  });
  const { texts } = await render(fragmented);
  const start = texts.indexOf("PROFESSIONAL SUMMARY");
  const end = texts.indexOf("TECHNICAL SKILLS");
  assert.equal(end - start, 2, "exactly one paragraph may sit between the two headings");
  assert.equal(
    texts[start + 1],
    "Data Engineer specializing in cloud-scale data engineering. Experienced in governed batch and incremental pipelines. Skilled in data modeling and performance optimization."
  );
});

test("S311C-11 a 3-4 sentence summary passes; anything shorter or longer is reported", () => {
  assert.equal(countSentences(GOOD_SUMMARY), 3);
  assert.deepEqual(checkSummaryShape([GOOD_SUMMARY]).filter((i) => i.kind === "SUMMARY_SENTENCE_COUNT"), []);
  assert.ok(checkSummaryShape(["One sentence only."]).some((i) => i.kind === "SUMMARY_SENTENCE_COUNT"));
  const sixSentences = Array.from({ length: 6 }, (_, i) => `Sentence number ${i} about data engineering.`).join(" ");
  assert.ok(checkSummaryShape([sixSentences]).some((i) => i.kind === "SUMMARY_SENTENCE_COUNT"));
});

test("S311C-12 the Professional Summary carries no bullet formatting", async () => {
  const { xml, texts } = await render(resume());
  const start = xml.indexOf("PROFESSIONAL SUMMARY");
  const end = xml.indexOf("TECHNICAL SKILLS");
  const between = xml.slice(start, end);
  assert.ok(!between.includes("<w:numPr>"), "the summary paragraph must not be a list item");
  assert.ok(texts.includes(GOOD_SUMMARY));
});

test("S311C-15 first-person pronouns are ALLOWED — the candidate specified this register", () => {
  // Reversal of an earlier Stage 31.1 rule, at the candidate's explicit and repeated instruction.
  // Their differentiating sentence closes in the first person by design.
  const firstPerson = [
    "Data Engineer with 6 years of hands-on experience designing data infrastructure. " +
      "Expertise spans ingestion, storage and analysis. " +
      "My dual expertise across engineering and infrastructure means I craft pipelines that are as strategic as they are systematic.",
  ];
  assert.deepEqual(checkSummaryShape(firstPerson), [], `first person must not be flagged: ${JSON.stringify(checkSummaryShape(firstPerson))}`);
  assert.deepEqual(checkSummaryQuality(firstPerson), []);

  // Third-person NARRATION remains a separate, still-enforced defect.
  assert.equal(findThirdPersonNarration(["Owns ETL delivery end to end."]).length, 1);
});

// --- DASHES (tests 25-28) -----------------------------------------------------------------------

test("S311C-25 an em dash anywhere in resume prose is caught", () => {
  const withEmDash = resume();
  withEmDash.experience[0].bullets = ["Built scalable pipelines — improving processing reliability."];
  const issues = findAiDashPunctuation(withEmDash);
  assert.ok(issues.some((i) => i.kind === "AI_DASH_PUNCTUATION"));
  assert.match(issues[0].message, /em dash/);

  const inSummary = resume({ summary: ["Data Engineer specializing in ETL — and lakehouse design. Experienced in Spark. Skilled in SQL."] });
  assert.ok(findAiDashPunctuation(inSummary).length > 0);
  const inProject = resume();
  inProject.experience[0].projectDescription = "Delta Lake curation — for deposit reporting.";
  assert.ok(findAiDashPunctuation(inProject).length > 0);
});

test("S311C-26 an en dash used as prose punctuation is caught, but a date range is not", () => {
  const prose = resume({ summary: ["Data Engineer specializing in ETL – and lakehouse design. Experienced in Spark. Skilled in SQL."] });
  assert.ok(findAiDashPunctuation(prose).some((i) => i.kind === "AI_DASH_PUNCTUATION"));

  // "Feb 2025 – Present" and "Jan 2022 – May 2023" are legitimate and must not be flagged.
  const dated = resume();
  dated.experience[0].dates = "Feb 2025 – Present";
  dated.education = ["Master of Science in Computer Science, Chicago State University – Jan 2022 – May 2023"];
  assert.deepEqual(findAiDashPunctuation(dated), [], "date ranges are the one legitimate en dash");
});

test("S311C-27 ordinary hyphenated terms remain allowed", () => {
  const hyphenated = resume({
    summary: ["Data Engineer specializing in end-to-end, real-time, cloud-native delivery. Experienced in CI/CD-related tooling. Skilled in SQL."],
  });
  hyphenated.experience[0].bullets = ["Built cloud-native, real-time pipelines with end-to-end testing."];
  assert.deepEqual(findAiDashPunctuation(hyphenated), []);
});

test("S311C-28 the cover letter follows the same dash rule", () => {
  const bad = coverLetter({ paragraphs: ["I delivered the platform — improving reliability."] });
  const issues = findAiDashPunctuation(resume(), bad);
  assert.ok(issues.some((i) => /Cover letter paragraph 1/.test(i.message)));
  assert.deepEqual(findAiDashPunctuation(resume(), coverLetter()), []);
});

// --- SKILLS (tests 20-24) -----------------------------------------------------------------------

const JD: RequirementUnit[] = [
  { kind: "skill", memberSkillNames: ["Python"], categories: [], label: "Python", requirementLevel: "Required", criticality: "CRITICAL", evidenceSnippets: [], experienceDepthRequired: false, fromUnclaimedText: false },
  { kind: "skill", memberSkillNames: ["Apache Spark"], categories: [], label: "Spark", requirementLevel: "Required", criticality: "REQUIRED", evidenceSnippets: [], experienceDepthRequired: false, fromUnclaimedText: false },
  { kind: "skill", memberSkillNames: ["Snowflake"], categories: [], label: "Snowflake", requirementLevel: "Required", criticality: "REQUIRED", evidenceSnippets: [], experienceDepthRequired: false, fromUnclaimedText: false },
];

test("S311C-21 domain-relevant skills beyond the JD are kept, not flagged", () => {
  const ecosystem = resume({
    skillGroups: [
      { label: "Languages", items: ["Python", "SQL"] },
      { label: "Data Engineering / Processing", items: ["Apache Spark", "PySpark", "Databricks", "Delta Lake"] },
      { label: "Databases / Warehouses", items: ["Snowflake", "Azure Synapse Analytics"] },
    ],
  });
  assert.deepEqual(checkSkillsBreadth(ecosystem, JD), [], "breadth beyond the posting is exactly what is wanted");
});

test("S311C-20/22 a section that is only the JD's own skills is reported as a transcription", () => {
  const jdOnly = resume({ skillGroups: [{ label: "Languages", items: ["Python", "Apache Spark", "Snowflake"] }] });
  const issues = checkSkillsBreadth(jdOnly, JD);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "SKILLS_JD_ONLY");
  assert.match(issues[0].message, /technical ecosystem/);
  // With no JD to compare against, nothing is asserted.
  assert.deepEqual(checkSkillsBreadth(jdOnly, undefined), []);
});

test("S311C-24 the check is deterministic — identical input yields identical output", () => {
  const r = resume({ skillGroups: [{ label: "Languages", items: ["Python", "Apache Spark", "Snowflake"] }] });
  assert.deepEqual(checkSkillsBreadth(r, JD), checkSkillsBreadth(r, JD));
  assert.deepEqual(checkHeadline(r.tagline, PROFILE), checkHeadline(r.tagline, PROFILE));
});

// --- CERTIFICATIONS (tests 29-33) ---------------------------------------------------------------

test("S311C-29/30/31 certifications render as U+2022 bullets, exactly as the reference defines", async () => {
  const twoCerts = resume({
    certifications: [
      "Microsoft Certified: Azure Data Engineer Associate (DP-203)",
      "Microsoft Certified: Azure Fundamentals (AZ-900)",
    ],
  });
  const { xml, numbering, texts } = await render(twoCerts);
  assert.ok(texts.includes("CERTIFICATIONS"), "the section renders whenever certifications exist");

  // The reference's numbering.xml defines numFmt="bullet" with lvlText="•" (U+2022). Ours must match.
  assert.match(numbering, /<w:numFmt w:val="bullet"\/>/);
  assert.ok(numbering.includes("•"), "the bullet glyph must be U+2022, as recovered from the reference");

  const paras = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map(([p]) => p);
  const certParas = paras.filter((p) => p.includes("Microsoft Certified"));
  assert.equal(certParas.length, 2);
  for (const p of certParas) assert.match(p, /<w:numPr>/, "every certification uses the same list treatment");
  // Consistent: both reference the same numbering definition.
  const ids = certParas.map((p) => p.match(/<w:numId w:val="(\d+)"\/>/)?.[1]);
  assert.equal(new Set(ids).size, 1, "all certifications share one numbering definition");
});

test("S311C-32/33 a candidate with no certifications gets no section and no invented entry", async () => {
  const none = resume();
  delete none.certifications;
  const { texts } = await render(none);
  assert.ok(!texts.includes("CERTIFICATIONS"), "no section may render");
  assert.ok(!texts.some((t) => /certified/i.test(t)), "and nothing may be fabricated");

  // Text is passed through verbatim from evidence.
  const verbatim = "Microsoft Certified: Azure Data Engineer Associate (DP-203)";
  const { texts: withCert } = await render(resume({ certifications: [verbatim] }));
  assert.ok(withCert.includes(verbatim), "the certification name renders exactly as recorded");
});

// --- PRESERVATION (tests 34-38) -----------------------------------------------------------------

test("S311C-34/35/36 the accepted Stage 31 content is unchanged by this stage", () => {
  const accepted = JSON.parse(
    fs.readFileSync("data/generated/candidates/1/jobs/71d1d82e0b1a6977/runs/9/quality/10/human-review/resume_content.json", "utf-8")
  ) as ResumeContent;
  assert.deepEqual(accepted.experience.map((e) => e.bullets.length), [8, 6, 5], "all 19 bullets remain");
  assert.equal(accepted.experience.reduce((n, e) => n + e.bullets.length, 0), 19);
  assert.ok(accepted.experience.every((e) => (e.projectDescription ?? "").length > 0), "every Project line remains");
  assert.deepEqual(accepted.experience.map((e) => e.environment!.length), [14, 13, 8], "Environment selection unchanged");
});

test("S311C-37 Stage 30 pagination behaviour is unchanged", async () => {
  const { xml } = await render(resume());
  assert.equal((xml.match(/<w:br w:type="page"\/>/g) ?? []).length, 0, "no explicit page breaks");
  assert.ok(!xml.includes("pageBreakBefore"));
  assert.match(xml, /<w:keepNext\/>/);
  assert.match(xml, /<w:widowControl\/>/);
  const source = fs.readFileSync(path.resolve("tools/tailoring-engine/resume-template.ts"), "utf-8");
  assert.match(source, /for \(const text of role\.bullets\) out\.push\(bullet\(text, false\)\)/, "bullets stay individually breakable");
});

test("S311C-38 the cover letter still signs off exactly once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s311c-cl-"));
  const out = path.join(dir, "CoverLetter.docx");
  await generateCoverLetterDocx(coverLetter(), out);
  const xml = (await (await JSZip.loadAsync(fs.readFileSync(out))).file("word/document.xml")!.async("string")) ?? "";
  const texts = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
    .map(([, b]) => [...b.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join("").trim())
    .filter((t) => t.length > 0);
  assert.equal(texts.filter((t) => t === "Saikishore Reddy").length, 2, "letterhead once, signature once");
  assert.equal(texts[texts.length - 1], "Saikishore Reddy");
});

test("S311C-39 the whole contract composes, and a compliant resume produces no findings", () => {
  assert.deepEqual(
    evaluatePresentationContract({ resume: resume(), coverLetter: coverLetter(), masterResumeProfile: undefined, jobRequirements: undefined }),
    []
  );
});

// --- Gate teeth ---------------------------------------------------------------------------------

test("S311C-40 a narrated or em-dashed summary CANNOT reach READY — the rules have real teeth", async () => {
  const { reviewResumeDeterministically } = await import("../reviewers/deterministicReviewer");
  const { evaluateQualityGate } = await import("../qualityGate");

  const clean = resume();
  const cleanReview = reviewResumeDeterministically({ resume: clean, masterResumeProfile: PROFILE, targetRoleTitle: "Data Engineer" });
  assert.equal(cleanReview.instructionCompliance?.checks.bannedLanguage, "PASS", "the baseline must be clean");

  // The exact defects the real corpus shipped with, each on its own.
  const narrated = resume({
    summary: ["Data Engineer specializing in ETL. Owns ETL delivery end to end. Skilled in SQL. Experienced in Spark."],
  });
  const narratedReview = reviewResumeDeterministically({ resume: narrated, masterResumeProfile: PROFILE, targetRoleTitle: "Data Engineer" });
  assert.equal(narratedReview.instructionCompliance?.checks.bannedLanguage, "FAIL");
  assert.notEqual(evaluateQualityGate(narratedReview, 1, 2), "READY", "third-person narration must block READY");

  const dashed = resume({
    summary: ["Data Engineer specializing in ETL — and lakehouse design. Skilled in SQL. Experienced in Spark."],
  });
  const dashedReview = reviewResumeDeterministically({ resume: dashed, masterResumeProfile: PROFILE, targetRoleTitle: "Data Engineer" });
  assert.equal(dashedReview.instructionCompliance?.checks.bannedLanguage, "FAIL");
  assert.notEqual(evaluateQualityGate(dashedReview, 1, 2), "READY", "em dash prose punctuation must block READY");

  // ...and neither is a truthfulness finding: the sentence is badly written, not untrue. Compared
  // against the SAME resume without the defect, so the assertion measures this stage's effect and
  // not the fixture's own unrelated truthfulness baseline.
  assert.equal(
    narratedReview.truthfulnessScore,
    cleanReview.truthfulnessScore,
    "narration must not move truthfulness by a single point"
  );
  assert.equal(
    dashedReview.truthfulnessScore,
    cleanReview.truthfulnessScore,
    "punctuation must not move truthfulness by a single point"
  );
  assert.equal(narratedReview.blockingIssues.length, cleanReview.blockingIssues.length, "and must raise no blocking issue");
});

test("S311C-41 the accepted Stage 31 resume would now be refused by the gate", async () => {
  const { reviewResumeDeterministically } = await import("../reviewers/deterministicReviewer");
  const { evaluateQualityGate } = await import("../qualityGate");
  const accepted = JSON.parse(
    fs.readFileSync("data/generated/candidates/1/jobs/71d1d82e0b1a6977/runs/9/quality/10/human-review/resume_content.json", "utf-8")
  ) as ResumeContent;
  const profile = JSON.parse(fs.readFileSync("data/candidates/1/candidate-profile.json", "utf-8"));

  // It carries all three: "Owns…", "Works…", and a paired em dash in the third sentence group.
  const review = reviewResumeDeterministically({ resume: accepted, masterResumeProfile: profile, targetRoleTitle: "Senior Data Engineer" });
  assert.equal(review.instructionCompliance?.checks.bannedLanguage, "FAIL");
  assert.notEqual(evaluateQualityGate(review, 1, 2), "READY");
  // Its facts were never in question, and still are not.
  assert.equal(review.truthfulnessScore, 100);
  assert.equal(review.architectureConsistencyScore, 100);
});

// --- Summary quality: positioning, not inventory -------------------------------------------------

test("S311C-42 the keyword-dump summary the writer produced under the stem menu is rejected", async () => {
  const { checkSummaryQuality } = await import("../presentationContract");
  // Verbatim from workflow 11, iteration 2 — 795 chars, 13 technologies, 4 stem openings.
  const produced = [
    "Data Engineer specializing in Spark-based distributed processing, Python and SQL pipeline development, and cloud data ingestion across Azure Databricks, Delta Lake and Snowflake. " +
      "Experienced in delivering end-to-end ETL from Oracle, DB2 and SQL Server sources into medallion architecture lakehouse layers, with CDC-driven incremental loads, SCD history tracking and dimensional models that reporting teams query directly. " +
      "Hands-on experience with PySpark performance tuning that reduced curated layer runtime by roughly 35%, alongside Pytest based test suites and Azure DevOps CI/CD that keep pipeline releases predictable. " +
      "Skilled in partnering with analytics and business stakeholders on design documentation and test cases while keeping governed, monitored pipelines dependable in production.",
  ];
  const kinds = checkSummaryQuality(produced).map((i) => i.kind);
  assert.ok(kinds.includes("SUMMARY_TECHNOLOGY_DUMP"), "13 technologies is inventory, not positioning");
  assert.ok(kinds.includes("SUMMARY_FORMULAIC"), "four identical frames must be rejected");
  assert.ok(kinds.includes("SUMMARY_TOO_LONG"), "795 characters is roughly 8 lines, not 3-5");
});

test("S311C-43 a positioning summary with varied construction passes", async () => {
  const { checkSummaryQuality } = await import("../presentationContract");
  const strong = [
    "Data Engineer building governed lakehouse platforms for banking and payments data on Azure. " +
      "Pipeline ownership runs end to end, from source ingestion through release, feeding models that analytics and risk teams query directly. " +
      "Spark tuning and incremental load design cut curated-layer runtime by 35%. " +
      "A consistent bridge between platform engineering and the business teams that depend on the data.",
  ];
  assert.deepEqual(checkSummaryQuality(strong), [], `must pass: ${JSON.stringify(checkSummaryQuality(strong))}`);
});

test("S311C-44 two capability stems are fine; more than two is a template", async () => {
  const { checkSummaryQuality, SUMMARY_MAX_STEM_OPENINGS } = await import("../presentationContract");
  const twoStems = [
    "Data Engineer building governed lakehouse platforms for banking data. " +
      "Experienced in end-to-end pipeline ownership from ingestion through release. " +
      "Spark tuning cut curated-layer runtime by 35%.",
  ];
  assert.deepEqual(checkSummaryQuality(twoStems).filter((i) => i.kind === "SUMMARY_FORMULAIC"), []);
  assert.equal(SUMMARY_MAX_STEM_OPENINGS, 2);
});

test("S311C-45 summary style failures block READY without touching truthfulness", async () => {
  const { reviewResumeDeterministically } = await import("../reviewers/deterministicReviewer");
  const { evaluateQualityGate } = await import("../qualityGate");

  const dumped = resume({
    summary: [
      "Data Engineer specializing in Apache Spark, PySpark, Databricks, Delta Lake, Snowflake, Python and SQL. " +
        "Experienced in Azure Data Factory and Azure Synapse Analytics. " +
        "Skilled in Kafka and Airflow. Proven with dbt and Power BI.",
    ],
  });
  const dumpedReview = reviewResumeDeterministically({ resume: dumped, masterResumeProfile: PROFILE, targetRoleTitle: "Data Engineer" });
  assert.equal(dumpedReview.instructionCompliance?.checks.bannedLanguage, "FAIL");
  assert.notEqual(evaluateQualityGate(dumpedReview, 1, 2), "READY");

  const cleanReview = reviewResumeDeterministically({ resume: resume(), masterResumeProfile: PROFILE, targetRoleTitle: "Data Engineer" });
  assert.equal(cleanReview.instructionCompliance?.checks.bannedLanguage, "PASS");
  assert.equal(dumpedReview.truthfulnessScore, cleanReview.truthfulnessScore, "style must not move truthfulness");
});

test("S311C-46 the writer is told to position rather than list, and not to stack stems", async () => {
  const { renderProfessionalIdentitySection, deriveProfessionalIdentity } = await import("../professionalIdentity");
  const section = renderProfessionalIdentitySection(deriveProfessionalIdentity(PROFILE), null);
  assert.match(section, /POSITIONING, not inventory/);
  assert.match(section, /at most SEVEN technologies/);
  // Stage 31.1's fourth pass replaced the stem prohibition with a register the candidate specified:
  // capability-led openings are welcome, provided the sentences behind them carry substance.
  assert.match(section, /Capability-led openings are welcome/);
  assert.match(section, /do not let every sentence share the same frame AND the same emptiness/);
  // It must show a worked contrast, not just a prohibition.
  assert.match(section, /Weak \u2014 a keyword dump|Weak — a keyword dump/);
  assert.match(section, /Strong \u2014 the register to aim for|Strong — the register to aim for/);
  assert.match(section, /names ZERO products/);
  assert.match(section, /omit the years clause entirely/, "no verified figure means no years clause");
});
