import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import type { CandidateProfile } from "@/lib/match/types";
import {
  checkPresentationAttribution,
  collectRoleProjectEvidence,
  ENVIRONMENT_MAX_ITEMS,
  ENVIRONMENT_MIN_ITEMS,
  evaluatePresentationStructure,
  extractNumericClaims,
  extractProperNounTokens,
  findEnvironmentDumps,
  findTruncatedBullets,
  renderPresentationStandardSection,
  renderRoleProjectEvidenceSection,
} from "../presentationStructure";
import { checkSummaryOpening } from "../professionalIdentity";
import { validateResumeContentStructure } from "../handoff/importer";
import { evaluateTruthfulness } from "../reviewers/truthfulnessChecks";
import { evaluateStructuralChecks } from "../reviewers/structuralChecks";
import { RENDERER_VERSION } from "../../../../tools/tailoring-engine/constants";
import { generateResumeDocx, splitEducationLine } from "../../../../tools/tailoring-engine/resume-template";
import { validateDocx } from "../../../../tools/tailoring-engine/validate-docx";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";

/**
 * Stage 31 — the reference-resume presentation standard.
 *
 * Pure/local tests: no database, no network, no Claude. The DOCX cases render to a temp directory
 * and read the resulting OOXML back, because every defect this stage is meant to prevent
 * (a section in the wrong place, a role header collapsed back onto one line, a bullet list rendered
 * as unmarked paragraphs) is invisible in the content model and only exists in the rendered file.
 */

// --- Fixtures ----------------------------------------------------------------------------------

const PROFILE: CandidateProfile = {
  schemaVersion: 1,
  sourceHashes: { resume: "r", skills: "s" },
  builtAt: "2026-01-01T00:00:00.000Z",
  totalYearsExperience: null,
  skills: [
    { rawSkillName: "Azure Data Factory", source: "employer", attributedTo: [{ employer: "Comerica Bank" }] },
    { rawSkillName: "Snowflake", source: "employer", attributedTo: [{ employer: "Microgate Technologies" }] },
    { rawSkillName: "Terraform", source: "inventory_only" },
  ],
  experience: [
    {
      employer: "Comerica Bank",
      title: "Data Engineer",
      startDate: "2025-02",
      endDate: null,
      technologies: ["Azure Data Factory", "Databricks", "Delta Lake", "PySpark"],
    },
    {
      employer: "Microgate Technologies",
      title: "Data Engineer",
      startDate: "2020-01",
      endDate: "2021-11",
      technologies: ["Snowflake", "Python", "Power BI"],
    },
  ],
  education: [{ level: "Master's", field: "Computer Science", institution: "Chicago State University" }],
  certifications: [{ name: "Microsoft Certified: Azure Data Engineer Associate (DP-203)" }],
};

function resume(overrides: Partial<ResumeContent> = {}): ResumeContent {
  return {
    name: "Test Candidate",
    tagline: "Data Engineer | Azure Data Platform | Databricks",
    location: "Dallas, TX",
    phone: "+1 (555) 867-5309",
    email: "test.candidate@realmail.com",
    linkedin: "linkedin.com/in/testcandidate",
    summary: ["Data engineer building Azure data platforms."],
    skillGroups: [{ label: "Cloud & Data Platforms", items: ["Azure Data Factory", "Databricks"] }],
    certifications: ["Microsoft Certified: Azure Data Engineer Associate (DP-203)"],
    experience: [
      {
        title: "Data Engineer",
        company: "Comerica Bank",
        dates: "Feb 2025 – Present",
        projectDescription: "Azure Data Factory ingestion into a Delta Lake lakehouse for banking analytics.",
        bullets: [
          "Design metadata-driven Azure Data Factory pipelines landing source data in Delta Lake.",
          "Build PySpark transformations in Databricks, cutting batch processing time 30%.",
        ],
        environment: ["Azure Data Factory", "Databricks", "Delta Lake", "PySpark"],
      },
      {
        title: "Data Engineer",
        company: "Microgate Technologies",
        dates: "Jan 2020 – Nov 2021",
        projectDescription: "Snowflake warehouse serving shipment reporting.",
        bullets: ["Reduced Snowflake processing time 40% through warehouse tuning and query optimization."],
        environment: ["Snowflake", "Python", "Power BI"],
      },
    ],
    education: ["Master of Science in Computer Science, Chicago State University — Jan 2022 – May 2023"],
    ...overrides,
  };
}

async function renderXml(content: ResumeContent): Promise<{ xml: string; numbering: string; filePath: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage31-"));
  const filePath = path.join(dir, "Resume.docx");
  await generateResumeDocx(content, filePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  return {
    xml: (await zip.file("word/document.xml")?.async("string")) ?? "",
    numbering: (await zip.file("word/numbering.xml")?.async("string")) ?? "",
    filePath,
  };
}

/** Visible text of the document, in reading order, with paragraph boundaries preserved. */
function paragraphTexts(xml: string): string[] {
  return [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map(([, body]) =>
    [...body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((m) => m[1])
      .join("")
      .replace(/&amp;/g, "&")
      .trim()
  );
}

// --- S31-01..04 — document structure ------------------------------------------------------------

test("S31-01 sections render in the reference order", async () => {
  const { xml } = await renderXml(resume({ keyProjects: [{ name: "p", description: "d" }] }));
  const texts = paragraphTexts(xml);
  const order = [
    "PROFESSIONAL SUMMARY",
    "TECHNICAL SKILLS",
    "CERTIFICATIONS",
    "PROFESSIONAL EXPERIENCE",
    "KEY PROJECTS",
    "EDUCATION",
  ];
  const positions = order.map((h) => texts.indexOf(h));
  positions.forEach((p, i) => assert.notEqual(p, -1, `${order[i]} section is missing`));
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1], `${order[i]} must come after ${order[i - 1]}`);
  }
});

test("S31-02 the header block is left-aligned, and the headline is bold rather than italic", async () => {
  const { xml } = await renderXml(resume());
  const header = xml.slice(0, xml.indexOf("PROFESSIONAL SUMMARY"));
  assert.doesNotMatch(header, /w:jc w:val="center"/, "the reference anchors name/headline/contact to the left margin");
  const headlineParagraph = [...header.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)]
    .map(([p]) => p)
    .find((p) => p.includes("Azure Data Platform"));
  assert.ok(headlineParagraph, "headline paragraph not found");
  assert.match(headlineParagraph, /<w:b\/>/, "the headline is bold in the reference");
  assert.doesNotMatch(headlineParagraph, /<w:i\/>/, "the headline is not italic in the reference");
});

test("S31-03 each role renders as TWO lines — employer with right-tabbed dates, then the title", async () => {
  const { xml } = await renderXml(resume());
  const texts = paragraphTexts(xml);
  const companyIdx = texts.indexOf("Comerica BankFeb 2025 – Present");
  assert.notEqual(companyIdx, -1, `expected a company+dates line, got: ${JSON.stringify(texts.slice(0, 30))}`);
  assert.equal(texts[companyIdx + 1], "Data Engineer", "the job title must sit on its own line beneath the employer");
  // And the dates must reach the right margin via a real tab element, not a literal tab character.
  const para = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map(([p]) => p).find((p) => p.includes("Comerica Bank"));
  assert.match(para!, /<w:tab\/>/, "dates must be positioned by a real <w:tab/> run element");
  assert.doesNotMatch(para!, /<w:t[^>]*>[^<]*\t/, "no literal tab characters inside text runs");
});

test("S31-04 employer location renders only when supplied, and is never invented", async () => {
  const without = await renderXml(resume());
  assert.ok(
    paragraphTexts(without.xml).includes("Comerica BankFeb 2025 – Present"),
    "with no location the company line must render the company alone"
  );

  const content = resume();
  content.experience[0].location = "Dallas, TX";
  const withLocation = await renderXml(content);
  assert.ok(paragraphTexts(withLocation.xml).includes("Comerica Bank, Dallas, TXFeb 2025 – Present"));
});

// --- S31-05..07 — the Project: / Environment: lines ---------------------------------------------

test("S31-05 Project: and Environment: lines render around the bullets, in that order", async () => {
  const { xml } = await renderXml(resume());
  const texts = paragraphTexts(xml).filter((t) => t.length > 0);
  const project = texts.findIndex((t) => t.startsWith("Project: Azure Data Factory ingestion"));
  const firstBullet = texts.findIndex((t) => t.startsWith("Design metadata-driven"));
  const environment = texts.findIndex((t) => t.startsWith("Environment: Azure Data Factory"));
  assert.ok(project !== -1 && firstBullet !== -1 && environment !== -1, "all three parts must render");
  assert.ok(project < firstBullet, "the scope line introduces the bullets");
  assert.ok(environment > firstBullet, "the environment line closes the role");
});

test("S31-06 a role without the optional lines still renders correctly", async () => {
  const content = resume();
  delete content.experience[0].projectDescription;
  delete content.experience[0].environment;
  const { xml } = await renderXml(content);
  const texts = paragraphTexts(xml);
  assert.equal(texts.filter((t) => t.startsWith("Project:")).length, 1, "only the second role still has one");
  assert.ok(texts.includes("Comerica BankFeb 2025 – Present"), "the role itself must still render");
  assert.ok(texts.some((t) => t.startsWith("Design metadata-driven")), "its bullets must still render");
});

test("S31-07 the Project/Environment labels are emphasised so they read as annotation, not as claims", async () => {
  // Stage 31.1 — the emphasis is BOLD ONLY. The reference sets these lines in italic, but the
  // document now carries no italic styling at all, so the bold label alone has to do the work of
  // marking the line as annotation rather than as another achievement claim.
  const { xml } = await renderXml(resume());
  const paras = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map(([p]) => p);
  for (const label of ["Project: ", "Environment: "]) {
    const para = paras.find((p) => p.includes(`<w:t xml:space="preserve">${label}</w:t>`));
    assert.ok(para, `${label} label run not found`);
    assert.match(para, /<w:b\/>/, "the label stays bold");
    assert.doesNotMatch(para, /<w:i\/>/, "no italic styling anywhere in the document");
  }
  assert.equal((xml.match(/<w:i\/>/g) ?? []).length, 0, "the whole resume must be free of italic runs");
});

// --- S31-08..11 — employer-scoped attribution (the safety core) ---------------------------------

/* REVISED BY THE MSI EVIDENCE CONTRACT.
 *
 * S31-08 and S31-09 previously asserted that a technology evidenced at ANOTHER employer, and an
 * inventory-only technology, were both rejected under a given employer. Those were the two rules
 * the MSI contract replaces: a Master Resume is compressed, so its silence about a technology under
 * one client is not a statement that the candidate never used it there, and the Master Skills
 * Inventory is candidate-declared evidence rather than a keyword list.
 *
 * The safety core they were protecting is unchanged and is still asserted below — an explicitly
 * client-scoped technology, and one with no evidence anywhere, are both still caught. */

test("S31-08 a technology evidenced at ANOTHER employer may now be used here", () => {
  const content = resume();
  content.experience[0].environment = ["Azure Data Factory", "Snowflake"]; // Snowflake is written at Microgate
  assert.deepEqual(
    checkPresentationAttribution(content, PROFILE),
    [],
    "the Master Resume's silence about Snowflake at Comerica is not evidence of absence"
  );
});

test("S31-08b an EXPLICITLY client-scoped technology is still caught elsewhere", () => {
  // Same shape as S31-08, except the inventory itself limits the skill.
  const scoped: CandidateProfile = {
    ...PROFILE,
    skills: PROFILE.skills.map((sk) =>
      sk.rawSkillName === "Snowflake" ? { ...sk, restrictedToEmployers: ["Microgate Technologies"] } : sk
    ),
  };
  const content = resume();
  content.experience[0].environment = ["Azure Data Factory", "Snowflake"];
  const issues = checkPresentationAttribution(content, scoped);
  assert.equal(issues.length, 1, `expected exactly one issue, got ${JSON.stringify(issues)}`);
  assert.equal(issues[0].field, "environment");
  assert.equal(issues[0].offending, "Snowflake");
  assert.match(issues[0].message, /Comerica Bank/);
});

test("S31-09 an inventory-declared technology may now be listed under an employer", () => {
  const content = resume();
  content.experience[0].environment = ["Terraform"];
  assert.deepEqual(
    checkPresentationAttribution(content, PROFILE),
    [],
    "the Skills Inventory is genuine candidate evidence, not a keyword list"
  );
});

test("S31-09b a technology evidenced NOWHERE is still rejected", () => {
  const content = resume();
  content.experience[0].environment = ["Kafka"];
  const issues = checkPresentationAttribution(content, PROFILE);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].offending, "Kafka");
});

test("S31-10 a correctly-attributed Environment line produces no issues at all", () => {
  assert.deepEqual(checkPresentationAttribution(resume(), PROFILE), []);
});

test("S31-11 a Project line may not introduce a new system, or a metric of its own", () => {
  const withNewSystem = resume();
  withNewSystem.experience[0].projectDescription = "Kafka streaming ingestion for banking analytics.";
  const systemIssues = checkPresentationAttribution(withNewSystem, PROFILE);
  assert.ok(
    systemIssues.some((i) => i.field === "projectDescription" && i.offending === "Kafka"),
    `Kafka is evidenced nowhere for this candidate: ${JSON.stringify(systemIssues)}`
  );

  const withNewMetric = resume();
  withNewMetric.experience[0].projectDescription = "Azure Data Factory ingestion cutting cost 62%.";
  const metricIssues = checkPresentationAttribution(withNewMetric, PROFILE);
  assert.ok(
    metricIssues.some((i) => i.offending === "62%"),
    `no bullet under this role states 62%: ${JSON.stringify(metricIssues)}`
  );

  // And a scope line that only restates evidenced work is accepted.
  assert.deepEqual(checkPresentationAttribution(resume(), PROFILE), []);
});

test("S31-12 attribution failures reach the quality gate through truthfulness, not silently", () => {
  const clean = evaluateTruthfulness(resume(), PROFILE);
  assert.equal(clean.truthfulnessScore, 100, `baseline must be clean: ${JSON.stringify(clean.truthfulnessIssues)}`);

  /* Uses a technology evidenced NOWHERE, since a cross-employer one is no longer a failure. The
   * property under test is unchanged: a real attribution failure must reduce the truthfulness score
   * and name the offending technology, rather than being swallowed. */
  const dirty = resume();
  dirty.experience[0].environment = ["Azure Data Factory", "Kafka"];
  const result = evaluateTruthfulness(dirty, PROFILE);
  assert.ok(result.truthfulnessScore < 100, "the gate requires 100, so this must reduce the score");
  assert.ok(
    result.truthfulnessIssues.some((i) => i.includes("Kafka")),
    "the concrete offending technology must reach the writer"
  );
});

// --- S31-13..15 — completeness, truncation, and the sections with no evidence -------------------

test("S31-13 a truncated bullet is detected and deducted for", () => {
  const content = resume();
  content.experience[0].bullets = ["Design metadata-driven Azure Data Factory pipelines landing source data in…"];
  assert.equal(findTruncatedBullets(content).length, 1);

  const structural = evaluateStructuralChecks(content);
  assert.ok(structural.formattingScore < 100, "a cut bullet is a real formatting defect");
  assert.ok(structural.corrections.some((c) => c.priority === "HIGH" && /truncated/.test(c.description)));
});

test("S31-14 a missing Project/Environment line is reported but never costs formatting score", () => {
  const content = resume();
  delete content.experience[0].projectDescription;
  delete content.experience[0].environment;

  const issues = evaluatePresentationStructure(content);
  assert.equal(issues.length, 2);
  assert.ok(issues.every((i) => i.severity === "LOW"));

  const complete = evaluateStructuralChecks(resume());
  const incomplete = evaluateStructuralChecks(content);
  assert.equal(
    incomplete.formattingScore,
    complete.formattingScore,
    "an unwritten annotation line must not be able to fail an otherwise sound resume"
  );
  assert.ok(incomplete.corrections.some((c) => /no Project line/.test(c.description)));
});

test("S31-15 Key Projects is omitted entirely — never rendered empty — with no project evidence", async () => {
  const { xml } = await renderXml(resume());
  assert.ok(!paragraphTexts(xml).includes("KEY PROJECTS"), "an evidence-free section must not render at all");

  // And the writer is told so explicitly rather than left to guess.
  const section = renderPresentationStandardSection(PROFILE);
  assert.match(section, /omit `keyProjects` entirely/);
  assert.match(section, /Do not invent projects/);
});

// --- S31-16..17 — layout mechanics preserved -----------------------------------------------------

test("S31-16 certifications render as real bullets, and education splits into degree/dates + institution", async () => {
  const { xml, numbering } = await renderXml(resume());
  const paras = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map(([p]) => p);

  const certPara = paras.find((p) => p.includes("DP-203"));
  assert.ok(certPara, "certification paragraph not found");
  assert.match(certPara, /<w:numPr>/, "certifications are a list in the reference, not unmarked body text");
  assert.ok(numbering.length > 0, "numbering.xml must exist for bullets to render as list items");

  const texts = paragraphTexts(xml);
  const degreeIdx = texts.findIndex((t) => t.startsWith("Master of Science in Computer Science"));
  assert.notEqual(degreeIdx, -1);
  assert.match(texts[degreeIdx], /Jan 2022 – May 2023$/, "dates belong on the degree line, right-aligned");
  assert.equal(texts[degreeIdx + 1], "Chicago State University", "the institution sits beneath the degree");
});

test("S31-17 an unparseable education line renders whole, never truncated or rearranged", () => {
  assert.deepEqual(splitEducationLine("Master of Science in Computer Science, Chicago State University — Jan 2022 – May 2023"), {
    degree: "Master of Science in Computer Science",
    institution: "Chicago State University",
    dates: "Jan 2022 – May 2023",
  });
  // No comma, no dash — nothing can be split, so the whole line survives as the degree line.
  assert.deepEqual(splitEducationLine("Bachelor of Technology"), { degree: "Bachelor of Technology" });
  // A trailing comma must not produce an empty institution.
  assert.deepEqual(splitEducationLine("Some Degree,"), { degree: "Some Degree," });
});

test("S31-18 the rendered document still passes every pre-existing ATS layout rule", async () => {
  const { filePath } = await renderXml(resume({ keyProjects: [{ name: "demo", description: "d", technologies: ["Python"] }] }));
  const result = await validateDocx(filePath, "resume");
  assert.deepEqual(result.violations, [], "Stage 31 must not weaken any Stage 1-30 layout guarantee");
  assert.equal(result.valid, true);
});

test("S31-19 the importer accepts the new optional fields and rejects malformed ones", () => {
  assert.doesNotThrow(() => validateResumeContentStructure(resume()));
  // Legacy content with none of the new fields must still import unchanged.
  const legacy = resume();
  legacy.experience.forEach((r) => {
    delete r.projectDescription;
    delete r.environment;
  });
  delete legacy.keyProjects;
  assert.doesNotThrow(() => validateResumeContentStructure(legacy));

  const badEnv = resume();
  (badEnv.experience[0] as { environment?: unknown }).environment = "Azure, Databricks";
  assert.throws(() => validateResumeContentStructure(badEnv), /environment must be an array of strings/);

  const badProject = resume({ keyProjects: [{ name: "", description: "d" }] });
  assert.throws(() => validateResumeContentStructure(badProject), /non-empty string name and description/);
});

test("S31-20 the token extractors used by the attribution guard behave as documented", () => {
  // Acronyms and versioned tokens are names; ordinary capitalised English deliberately is NOT,
  // because a false positive here costs a sound resume its READY disposition. Real technologies
  // are caught by the skill taxonomy instead, which is what S31-11 exercises.
  const tokens = extractProperNounTokens("Delivered a Databricks lakehouse using ADF and SCD2 patterns.");
  assert.ok(tokens.includes("ADF"), "an all-caps acronym is unmistakably a name");
  assert.ok(tokens.includes("SCD2"), "a digit-bearing token is unmistakably a name");
  assert.ok(!tokens.includes("Delivered"), "ordinary capitalised English must never be flagged");
  assert.ok(!tokens.includes("Databricks"), "taxonomy technologies are resolved by the taxonomy, not by shape");

  assert.deepEqual(extractNumericClaims("cut runtime 30% across 2 regions"), ["30%", "2"]);
});

test("S31-21 the renderer version was bumped, so old and new artifacts are distinguishable", () => {
  assert.ok(RENDERER_VERSION >= 2, "a layout change this visible must not reuse the previous renderer version");
});

// =================================================================================================
// Stage 31 final-acceptance corrections
// =================================================================================================

test("S31-22 the summary opening the real corpus produced is now rejected", () => {
  // The exact sentence published by workflow 6 at a 100/100 truthfulness score.
  const real = "Data engineer with nearly five years processing and analyzing large datasets on Apache Spark.";
  const issues = checkSummaryOpening(real, null);
  assert.ok(issues.some((i) => i.kind === "GENERIC_OPENING"), `identity-then-with must be rejected: ${JSON.stringify(issues)}`);
  assert.ok(issues.some((i) => i.kind === "UNVERIFIED_YEARS"), "an unverified years figure must still be rejected");
});

test("S31-23 every prohibited opening form the user listed is caught, however the identity is qualified", () => {
  const prohibited = [
    "Data Engineer with deep Azure experience.",
    "Engineer with a decade of delivery.",
    "Professional with broad platform exposure.",
    "Candidate with strong SQL.",
    "Senior Cloud Data Architect with nearly six years of platform work.",
    "Data Engineer with 5+ years building pipelines.",
    "Experienced professional delivering data platforms.",
    "Results-driven professional delivering data platforms.",
  ];
  for (const text of prohibited) {
    assert.ok(
      checkSummaryOpening(text, null).some((i) => i.kind === "GENERIC_OPENING"),
      `must be rejected: ${text}`
    );
  }
});

test("S31-24 the required specialization-led shape is accepted, and 'with' later in the sentence is fine", () => {
  const accepted = [
    "Data Engineer specializing in Azure Databricks, PySpark, Delta Lake, and scalable cloud data platforms.",
    "Data Engineer building governed medallion lakehouses with Delta Lake and Azure Data Factory.",
    "Data Engineer delivering production pipelines on Azure Databricks.",
  ];
  for (const text of accepted) {
    assert.deepEqual(checkSummaryOpening(text, null), [], `must be accepted: ${text}`);
  }
});

test("S31-25 the summary rule now has an owner — it reaches BOTH the gate and the writer", () => {
  const bad = resume({
    summary: ["Data engineer with nearly five years processing large datasets on Apache Spark."],
  });

  // The years claim is a factual assertion: it must cost truthfulness, which the gate requires at 100.
  const truth = evaluateTruthfulness(bad, PROFILE);
  assert.ok(truth.truthfulnessScore < 100, "an unverifiable years figure must prevent READY");
  assert.ok(truth.truthfulnessIssues.some((i) => i.includes("nearly five years")));

  // The generic opening is a writing failure: it must cost formatting and reach the writer.
  const structural = evaluateStructuralChecks(bad, PROFILE);
  assert.ok(structural.formattingScore < 100, "a generic opening must cost formatting score");
  assert.ok(
    structural.corrections.some((c) => c.priority === "HIGH" && /specializing in/.test(c.description)),
    "the correction must name the required shape, not just the failure"
  );

  // And the compliant version is clean on both.
  const good = resume();
  assert.equal(evaluateTruthfulness(good, PROFILE).truthfulnessScore, 100);
});

test("S31-26 a headline that abandons the candidate's profession is caught", () => {
  const hijacked = resume({ tagline: "Machine Learning Engineer | Spark | Python" });
  const structural = evaluateStructuralChecks(hijacked, PROFILE);
  assert.ok(structural.corrections.some((c) => /does not lead with the candidate's own professional identity/.test(c.description)));
  // A genuine specialization after the identity stays allowed.
  assert.deepEqual(
    evaluateStructuralChecks(resume({ tagline: "Senior Data Engineer | Delta Lake | Databricks" }), PROFILE).corrections.filter((c) =>
      /professional identity/.test(c.description)
    ),
    []
  );
});

test("S31-27 a missing Project line is a real defect where evidence supports one, and silent where it does not", () => {
  const missing = resume();
  delete missing.experience[0].projectDescription;

  const withProfile = evaluatePresentationStructure(missing, PROFILE);
  const projectIssue = withProfile.find((i) => /has no Project line/.test(i.message));
  assert.ok(projectIssue, "the missing line must be reported");
  assert.equal(projectIssue.severity, "HIGH", "evidence supports it, so it is required");
  assert.match(projectIssue.message, /technologies and \d+ reviewed bullets/, "the report must state the evidence");

  // A role CareerOps has no evidence for must not be pushed into inventing one.
  const noEvidence = resume();
  delete noEvidence.experience[0].projectDescription;
  noEvidence.experience[0].company = "Employer With No Recorded Evidence";
  const unsupported = evaluatePresentationStructure(noEvidence, PROFILE).find((i) => /has no Project line/.test(i.message));
  assert.equal(unsupported?.severity, "LOW", "with no evidence, omitting the line is correct, not a defect");
});

test("S31-28 the per-role evidence the writer needs is computed, and present on iteration 1", () => {
  // Iteration 1: no draft resume exists yet, and the evidence must still be available.
  const firstPass = collectRoleProjectEvidence(undefined, PROFILE);
  assert.equal(firstPass.length, 2, "employers come from the profile when there is no draft");
  assert.ok(firstPass.every((e) => e.supportsProjectLine), "both profile employers have recorded technologies");

  const section = renderRoleProjectEvidenceSection(firstPass);
  assert.match(section, /Comerica Bank/);
  assert.match(section, /Project line: REQUIRED/);
  // SUMMARY QUALITY + WRITER TOKEN OPTIMIZATION (2026-08-23, pass 2) — this section no longer
  // repeats each employer's technology list a second time (it is identical to, and now deduplicated
  // against, the "Already written here" list renderEmployerEvidenceSection already renders); it
  // references that section by name instead.
  assert.doesNotMatch(section, /Azure Data Factory/, "the technology list itself must live in PER-EMPLOYER EVIDENCE only, not be duplicated here");
  assert.match(section, /PER-EMPLOYER EVIDENCE section/, "must point the writer at the single source of the technology list");

  // Later iterations reuse the draft's own roles and bullet counts.
  const later = collectRoleProjectEvidence(resume(), PROFILE);
  assert.equal(later.find((e) => e.employer === "Comerica Bank")?.bulletCount, 2);
});

test("S31-29 an Environment line that dumps the whole evidence set is flagged as a dump", () => {
  const dumped = resume();
  // Preview B's behaviour: every technology recorded for the employer, pasted verbatim.
  dumped.experience[0].environment = Array.from({ length: ENVIRONMENT_MAX_ITEMS + 6 }, (_, i) => `Tech ${i}`);
  const issues = findEnvironmentDumps(dumped, PROFILE);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, new RegExp(`${ENVIRONMENT_MIN_ITEMS}-${ENVIRONMENT_MAX_ITEMS} strongest`));

  // A selected line of reasonable length is not flagged.
  assert.deepEqual(findEnvironmentDumps(resume(), PROFILE), [], "a selected Environment line is fine");
});

test("S31-30 the writer is told to select, not to dump, and the bounds are stated once", () => {
  const section = renderRoleProjectEvidenceSection(collectRoleProjectEvidence(undefined, PROFILE));
  assert.match(section, /most JD-relevant first/);
  assert.match(section, /Do not paste the whole list/);
  assert.match(section, /may legitimately appear under more than one employer/, "cross-employer reuse stays allowed where evidenced");
  assert.ok(!/\d+-\d+ technologies.*\n.*\d+-\d+ technologies/.test(section), "the bounds must not be restated inconsistently");
});
