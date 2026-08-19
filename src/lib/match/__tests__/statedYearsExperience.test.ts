import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Document, Packer, Paragraph, TextRun } from "docx";
import {
  documentXmlToText,
  extractStatedYearsFromText,
  readStatedYearsExperience,
} from "../statedYearsExperience";

/**
 * The candidate's stated total years of experience, taken from their own master evidence.
 *
 * The defect: build-candidate-profile writes `totalYearsExperience: null` by design, expecting the
 * app to compute it from employment dates. For a candidate with a gap in their history the
 * interval-union math correctly refuses to produce a figure, so the derived index recorded null
 * while the Master Resume stated "Data Engineer with 6 years…" in its first line. Every rebuild
 * discarded a verified fact.
 */

async function writeMasterResume(dir: string, text: string, filename = "resume.docx"): Promise<void> {
  const doc = new Document({
    sections: [{ children: text.split("\n").map((line) => new Paragraph({ children: [new TextRun(line)] })) }],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), await Packer.toBuffer(doc));
}

// --- The stated-figure rule (pure) --------------------------------------------------------------

test("SY-01 an explicitly stated total is read exactly as written", () => {
  // The real corpus line, verbatim.
  assert.equal(
    extractStatedYearsFromText(
      "Data Engineer with 6 years designing, building, and maintaining production data lake and data warehouse platforms on Microsoft Azure"
    ),
    6
  );
  assert.equal(extractStatedYearsFromText("Data Engineer with over 6 years of hands-on experience in designing"), 6);
  assert.equal(extractStatedYearsFromText("8+ years of professional experience across banking"), 8);
  assert.equal(extractStatedYearsFromText("12 years experience delivering data platforms"), 12);
});

test("SY-02 a qualifier never inflates the stated number", () => {
  // "over 6" must yield 6 — the number the evidence states — never a rounded-up 7.
  for (const qualifier of ["over", "more than", "nearly", "almost", "about", "around", "roughly", "approximately"]) {
    assert.equal(extractStatedYearsFromText(`Data Engineer with ${qualifier} 6 years of experience`), 6, qualifier);
  }
});

test("SY-03 nothing is inferred where no figure is stated", () => {
  const noFigure = [
    "Data Engineer designing and maintaining production data platforms on Microsoft Azure.",
    "Data Engineer specializing in Delta Lake and Azure Databricks.",
    "",
    "Built pipelines since 2019 across several employers.",
  ];
  for (const text of noFigure) assert.equal(extractStatedYearsFromText(text), null, `must not guess from: ${text}`);
});

test("SY-04 a per-technology or per-role duration is not mistaken for a career total", () => {
  // "3 years" here belongs to a skill, not to the candidate; no total is stated, so none is returned.
  assert.equal(extractStatedYearsFromText("Snowflake (3 years), Databricks, Delta Lake"), null);
  assert.equal(extractStatedYearsFromText("Held the role for 2 years before moving to Fiserv."), null);
});

test("SY-05 implausible figures are refused rather than trusted", () => {
  assert.equal(extractStatedYearsFromText("with 0 years of experience"), null);
  assert.equal(extractStatedYearsFromText("with 99 years of experience"), null);
});

test("SY-06 WordprocessingML is reduced to its visible text in reading order", () => {
  const xml =
    '<w:p><w:r><w:t xml:space="preserve">Data Engineer with 6 </w:t></w:r><w:r><w:t>years</w:t></w:r></w:p>' +
    "<w:p><w:r><w:t>Azure &amp; Databricks</w:t></w:r></w:p>";
  const text = documentXmlToText(xml);
  assert.match(text, /Data Engineer with 6 years/);
  assert.match(text, /Azure & Databricks/);
  assert.equal(extractStatedYearsFromText(text), 6);
});

// --- Reading one candidate's own evidence -------------------------------------------------------

test("SY-07 the verified figure survives a profile rebuild — it is read from evidence every time", async () => {
  const master = fs.mkdtempSync(path.join(os.tmpdir(), "sy-master-"));
  await writeMasterResume(master, "Professional Summary\nData Engineer with 6 years designing and maintaining data platforms.");

  // A rebuild writes totalYearsExperience: null. The figure must still be recoverable afterwards,
  // because it is taken from the master resume rather than carried by the derived index.
  assert.equal(readStatedYearsExperience(master), 6);
  assert.equal(readStatedYearsExperience(master), 6, "and again, deterministically");
});

test("SY-08 a candidate whose evidence states no figure stays null — never guessed", async () => {
  const master = fs.mkdtempSync(path.join(os.tmpdir(), "sy-none-"));
  await writeMasterResume(master, "Professional Summary\nData Engineer specializing in Delta Lake and Azure Databricks.");
  assert.equal(readStatedYearsExperience(master), null);

  // An empty master directory is equally silent, not zero.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sy-empty-"));
  assert.equal(readStatedYearsExperience(empty), null);
});

test("SY-09 one candidate can never inherit another candidate's figure", async () => {
  const alice = fs.mkdtempSync(path.join(os.tmpdir(), "sy-alice-"));
  const bob = fs.mkdtempSync(path.join(os.tmpdir(), "sy-bob-"));
  const carol = fs.mkdtempSync(path.join(os.tmpdir(), "sy-carol-"));
  await writeMasterResume(alice, "Data Engineer with 6 years of experience.");
  await writeMasterResume(bob, "Data Analyst with 11 years of experience.");
  await writeMasterResume(carol, "Data Scientist building models across healthcare.");

  assert.equal(readStatedYearsExperience(alice), 6);
  assert.equal(readStatedYearsExperience(bob), 11);
  // Carol states none, and must not pick up Alice's or Bob's.
  assert.equal(readStatedYearsExperience(carol), null);
  // Re-reading in a different order changes nothing — there is no shared or cached state.
  assert.equal(readStatedYearsExperience(bob), 11);
  assert.equal(readStatedYearsExperience(alice), 6);
});

test("SY-10 reading a candidate's evidence never modifies it", async () => {
  const master = fs.mkdtempSync(path.join(os.tmpdir(), "sy-immutable-"));
  await writeMasterResume(master, "Data Engineer with 6 years of experience.");
  const file = path.join(master, "resume.docx");

  const before = {
    sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    size: fs.statSync(file).size,
    mtimeMs: fs.statSync(file).mtimeMs,
    entries: fs.readdirSync(master).sort(),
  };

  for (let i = 0; i < 3; i++) assert.equal(readStatedYearsExperience(master), 6);

  const after = {
    sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    size: fs.statSync(file).size,
    mtimeMs: fs.statSync(file).mtimeMs,
    entries: fs.readdirSync(master).sort(),
  };
  assert.deepEqual(after, before, "master evidence must be byte-identical and untouched after reading");
});

test("SY-11 an unreadable or absent master resume degrades to null, never to an error", () => {
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), "sy-broken-"));
  fs.writeFileSync(path.join(broken, "resume.docx"), Buffer.from("not a zip at all"));
  assert.equal(readStatedYearsExperience(broken), null, "a corrupt file must not throw");
  assert.equal(readStatedYearsExperience(path.join(broken, "does-not-exist")), null);
});

test("SY-12 nothing here computes years from employment dates", () => {
  // Comments stripped first: the module's header explains at length why it does NOT do date math,
  // and a naive grep over prose would flag that explanation as the very thing it disclaims.
  const source = fs
    .readFileSync(path.resolve("src/lib/match/statedYearsExperience.ts"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.ok(!/computeTotalYearsExperience/.test(source), "this module must not reach for the date math");
  assert.ok(!/startDate|endDate/.test(source), "employment dates play no part in a STATED figure");
  // And the date math itself is untouched by this change.
  const duration = fs.readFileSync(path.resolve("src/lib/match/experienceDuration.ts"), "utf-8");
  assert.match(duration, /export function computeTotalYearsExperience/, "the existing computation still exists");
});
