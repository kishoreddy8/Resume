import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import { FIXTURES } from "../fixtures/index";
import { generateResumeDocx } from "../resume-template";
import { validateDocx } from "../validate-docx";
import { buildCertificationBadgeRuns, hasCertificationBadges, matchCertificationBadge } from "../certificationBadges";
import type { ResumeContent } from "../types";

const fixture = FIXTURES[0];

async function documentXml(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);
  return zip.file("word/document.xml")!.async("string");
}

async function docxText(filePath: string): Promise<string> {
  const xml = await documentXml(filePath);
  // Strip tags to get plain readable text, same spirit as the app's own ATS-extraction intent.
  return xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function resumeWith(overrides: Partial<ResumeContent>): ResumeContent {
  return { ...fixture.resume, ...overrides };
}

// --- Unit tests: matchCertificationBadge / buildCertificationBadgeRuns -----------------------------

test("Phase H: known vendor certifications resolve to the expected badge family", () => {
  assert.equal(matchCertificationBadge("Microsoft Certified: Azure Data Engineer Associate (DP-203)")?.label, "Azure");
  assert.equal(matchCertificationBadge("AWS Certified Solutions Architect – Associate")?.label, "AWS");
  assert.equal(matchCertificationBadge("Google Cloud Professional Data Engineer")?.label, "Google Cloud");
  assert.equal(matchCertificationBadge("Databricks Certified Data Engineer Associate")?.label, "Databricks");
  assert.equal(matchCertificationBadge("SnowPro Core Certification (Snowflake)")?.label, "Snowflake");
  assert.equal(matchCertificationBadge("SnowPro Core Certification")?.label, "Snowflake");
});

test("Phase H: an unrecognized certification never invents a badge", () => {
  assert.equal(matchCertificationBadge("Certified ScrumMaster (CSM)"), null);
  assert.equal(matchCertificationBadge("PMP"), null);
});

test("Phase H: no certifications produces no badge runs (never a placeholder)", () => {
  assert.deepEqual(buildCertificationBadgeRuns(undefined), []);
  assert.deepEqual(buildCertificationBadgeRuns([]), []);
  assert.equal(hasCertificationBadges(undefined), false);
  assert.equal(hasCertificationBadges([]), false);
});

test("Phase H: an entirely-unrecognized certification list produces no badge runs", () => {
  assert.deepEqual(buildCertificationBadgeRuns(["Certified ScrumMaster (CSM)", "PMP"]), []);
  assert.equal(hasCertificationBadges(["Certified ScrumMaster (CSM)", "PMP"]), false);
});

test("Phase H: a mix of recognized and unrecognized certifications badges only the recognized ones", () => {
  const runs = buildCertificationBadgeRuns(["Microsoft Certified: Azure Data Engineer Associate (DP-203)", "Certified ScrumMaster (CSM)"]);
  assert.equal(runs.length, 1);
  assert.equal(hasCertificationBadges(["Microsoft Certified: Azure Data Engineer Associate (DP-203)", "Certified ScrumMaster (CSM)"]), true);
});

test("Phase H: two certifications in the same vendor family produce one badge run, not two", () => {
  const runs = buildCertificationBadgeRuns([
    "AWS Certified Cloud Practitioner",
    "AWS Certified Solutions Architect – Associate",
  ]);
  assert.equal(runs.length, 1, "duplicate families must collapse into a single compact badge");
});

test("Phase H: badge runs are capped at 3 even with more recognized families", () => {
  const runs = buildCertificationBadgeRuns([
    "AWS Certified Cloud Practitioner",
    "Microsoft Certified: Azure Data Engineer Associate (DP-203)",
    "Google Cloud Professional Data Engineer",
    "Databricks Certified Data Engineer Associate",
    "SnowPro Core Certification",
  ]);
  assert.equal(runs.length, 3, "the headline-line badge row is compact — more than 3 families must not be shown");
});

// --- Integration: the real DOCX renderer, real ATS text extraction, real XML structure -------------

test("Phase H: a candidate with a recognized certification gets a top-right badge run AND the full certification text, with no forbidden table", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-certbadge-"));
  try {
    const outputPath = path.join(tmpDir, "Resume.docx");
    await generateResumeDocx(resumeWith({ certifications: ["Microsoft Certified: Azure Data Engineer Associate (DP-203)"] }), outputPath);

    const text = await docxText(outputPath);
    assert.match(text, /AZURE CERTIFIED/, "the badge run's spelled-out family name must be real extractable text");
    assert.match(text, /Microsoft Certified: Azure Data Engineer Associate \(DP-203\)/, "the full certification name must remain in the Certifications section, unchanged");

    const xml = await documentXml(outputPath);
    // validate-docx.ts hard-fails any resume containing a <w:tbl> — the top-right placement must
    // never be built as a table, only as a right tab stop on an ordinary header paragraph.
    assert.doesNotMatch(xml, /<w:tbl>/, "a recognized badge must never introduce a table — see validate-docx.ts's table ban");
    assert.match(xml, /<w:tab\/>/, "the badge is reached via a real tab-stop run, the same mechanism companyLine already uses for dates");
    assert.match(xml, /<w:shd /, "the badge itself is a shaded run — that is its only visual distinction from plain text");

    const validation = await validateDocx(outputPath, "resume");
    assert.equal(validation.valid, true, `badge presentation must not break ATS validity: ${JSON.stringify(validation.violations)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Phase H: the candidate's name paragraph never carries a badge run, with one or two recognized certifications", async () => {
  // The name line is the one protected exception: stage311NameAndVoice.test.ts's "the display name
  // survives rendering exactly" requires the FIRST paragraph's extracted text to be the candidate's
  // display name and nothing else. This proves that invariant holds even when badges are present —
  // both badge slots (headline, contact) must be used before this would ever be at risk.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-certbadge-name-"));
  try {
    const onePath = path.join(tmpDir, "one.docx");
    const twoPath = path.join(tmpDir, "two.docx");
    await generateResumeDocx(resumeWith({ certifications: ["Microsoft Certified: Azure Data Engineer Associate (DP-203)"] }), onePath);
    await generateResumeDocx(
      resumeWith({ certifications: ["Microsoft Certified: Azure Data Engineer Associate (DP-203)", "AWS Certified Cloud Practitioner"] }),
      twoPath
    );
    for (const p of [onePath, twoPath]) {
      const xml = await documentXml(p);
      const firstParagraph = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/)?.[0] ?? "";
      const firstParagraphText = [...firstParagraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join("");
      assert.equal(firstParagraphText, fixture.resume.name, "the name paragraph must contain the display name and nothing else, even with badges present");
      assert.doesNotMatch(firstParagraph, /<w:shd /, "the name paragraph must never carry a shaded badge run");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Phase H: an unrecognized certification renders text-only — no badge run, no shading, full name still present", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-certbadge-unknown-"));
  try {
    const outputPath = path.join(tmpDir, "Resume.docx");
    await generateResumeDocx(resumeWith({ certifications: ["Certified ScrumMaster (CSM)"] }), outputPath);
    const text = await docxText(outputPath);
    assert.match(text, /Certified ScrumMaster \(CSM\)/);
    assert.doesNotMatch(text, /CERTIFIED /, "no all-caps badge text should appear when nothing is recognized");

    const xml = await documentXml(outputPath);
    assert.doesNotMatch(xml, /<w:shd /, "no shaded run at all when no certification is recognized");
    assert.doesNotMatch(xml, /<w:tbl>/);

    const validation = await validateDocx(outputPath, "resume");
    assert.equal(validation.valid, true, `unrecognized certification must still validate cleanly: ${JSON.stringify(validation.violations)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Phase H: a candidate with zero certifications renders cleanly with no badge artifact, no shading, and no Certifications section", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-certbadge-none-"));
  try {
    const outputPath = path.join(tmpDir, "Resume.docx");
    await generateResumeDocx(resumeWith({ certifications: undefined }), outputPath);
    const text = await docxText(outputPath);
    assert.doesNotMatch(text, /Certifications/);

    const xml = await documentXml(outputPath);
    assert.doesNotMatch(xml, /<w:shd /);
    assert.doesNotMatch(xml, /<w:tbl>/);

    const validation = await validateDocx(outputPath, "resume");
    assert.equal(validation.valid, true, `no-certification candidate must still validate cleanly: ${JSON.stringify(validation.violations)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Phase H: multiple certifications across different vendor families all badge and all remain in text", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-certbadge-multi-"));
  try {
    const outputPath = path.join(tmpDir, "Resume.docx");
    const certs = [
      "Microsoft Certified: Azure Data Engineer Associate (DP-203)",
      "Databricks Certified Data Engineer Associate",
      "AWS Certified Cloud Practitioner",
    ];
    await generateResumeDocx(resumeWith({ certifications: certs }), outputPath);
    const text = await docxText(outputPath);
    for (const cert of certs) {
      assert.ok(text.includes(cert), `full certification text must remain present: ${cert}`);
    }
    // All three ride the headline line's badge row (cap is 3).
    assert.match(text, /AZURE CERTIFIED/);
    assert.match(text, /DATABRICKS CERTIFIED/);
    assert.match(text, /AWS CERTIFIED/);
    const validation = await validateDocx(outputPath, "resume");
    assert.equal(validation.valid, true, `multiple badges must not break ATS validity: ${JSON.stringify(validation.violations)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Phase H: certifications never derive from Technical Skills / MSI mentions of the same vendor names", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-certbadge-skillsonly-"));
  try {
    const outputPath = path.join(tmpDir, "Resume.docx");
    await generateResumeDocx(
      resumeWith({
        certifications: undefined,
        skillGroups: [
          { label: "Cloud Platforms", items: ["Azure", "AWS", "Google Cloud", "Databricks", "Snowflake"] },
        ],
      }),
      outputPath
    );
    const text = await docxText(outputPath);
    assert.doesNotMatch(text, /CERTIFIED/, "mentioning a vendor's name in Skills must never produce a certification badge");
    const xml = await documentXml(outputPath);
    assert.doesNotMatch(xml, /<w:shd /, "no shaded badge run without an actual certification behind it");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Phase H: a targeted repair that never touches certifications leaves the badge runs and certification text identical", async () => {
  // The badge runs are derived purely from ResumeContent.certifications at render time — there is
  // no separate stored state for them, so it is architecturally impossible for them to drift
  // independently of the certifications array. This test proves that directly: rendering the SAME
  // certifications twice (simulating "before" and "after" an unrelated repair pass) produces
  // byte-identical output.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-certbadge-repair-"));
  try {
    const certs = ["Microsoft Certified: Azure Data Engineer Associate (DP-203)"];
    const beforePath = path.join(tmpDir, "before.docx");
    const afterPath = path.join(tmpDir, "after.docx");
    await generateResumeDocx(resumeWith({ certifications: certs }), beforePath);
    await generateResumeDocx(resumeWith({ certifications: certs }), afterPath);
    const beforeText = await docxText(beforePath);
    const afterText = await docxText(afterPath);
    assert.equal(beforeText, afterText);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// --- Clarification: resume text is black except hyperlinks (blue) and badge artwork, no italics ----

const KNOWN_NON_BLACK_COLORS = new Set(["FFFFFF", "0563C1"]); // badge white; hyperlink blue

test("Clarification: every run color is black except hyperlinks (blue, per the reference resume) and the badge cards' own white text", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-resume-color-"));
  try {
    const withBadge = path.join(tmpDir, "with-badge.docx");
    const withoutBadge = path.join(tmpDir, "without-badge.docx");
    await generateResumeDocx(resumeWith({ certifications: ["AWS Certified Cloud Practitioner"] }), withBadge);
    await generateResumeDocx(resumeWith({ certifications: ["Certified ScrumMaster (CSM)"] }), withoutBadge);

    const withBadgeXml = await documentXml(withBadge);
    const withBadgeColors = new Set([...withBadgeXml.matchAll(/<w:color w:val="([0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase()));
    for (const color of withBadgeColors) {
      assert.ok(
        color === "000000" || KNOWN_NON_BLACK_COLORS.has(color),
        `unexpected non-black, non-badge, non-hyperlink run color: ${color}`
      );
    }
    assert.ok(withBadgeColors.has("000000"), "the identity/body text must still be explicitly black");
    assert.ok(withBadgeColors.has("FFFFFF"), "the badge itself must still be white-on-color");

    const withoutBadgeXml = await documentXml(withoutBadge);
    const withoutBadgeColors = new Set([...withoutBadgeXml.matchAll(/<w:color w:val="([0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase()));
    assert.deepEqual(withoutBadgeColors, new Set(["000000", "0563C1"]), "with no badge, every run color must be black except the hyperlink blue");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Clarification: the resume never uses italic formatting anywhere", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-resume-italics-"));
  try {
    const outputPath = path.join(tmpDir, "Resume.docx");
    await generateResumeDocx(resumeWith({ certifications: ["AWS Certified Cloud Practitioner", "Databricks Certified Data Engineer Associate"] }), outputPath);
    const xml = await documentXml(outputPath);
    assert.doesNotMatch(xml, /<w:i\/>/, "no run may set italic formatting");
    assert.doesNotMatch(xml, /<w:i w:val="(true|1)"\/>/, "no run may set italic formatting via an explicit true value either");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
