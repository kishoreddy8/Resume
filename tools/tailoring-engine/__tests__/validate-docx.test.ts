import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import JSZip from "jszip";
import { CONTENT_WIDTH, FONT, MARGIN, PAGE_HEIGHT, PAGE_WIDTH } from "../constants";
import { validateDocx } from "../validate-docx";

/**
 * Characterization tests for validateDocx's two structural-paragraph regexes (Stage 1B — ES2017
 * dotAll-flag compatibility fix; see validate-docx.ts's headingParagraphs/tabsParagraphs matchAll
 * calls). Builds minimal-but-complete synthetic .docx packages with JSZip (the same library
 * validateDocx itself uses to read one) rather than re-implementing the regex in the test file, so
 * this exercises the real exported function, not a copy of its logic.
 *
 * These specifically prove the [\s\S] replacement for the dotAll `s` flag preserves exact matching
 * behavior: newline-spanning paragraphs still match, valid content still passes, invalid content is
 * still caught (border/tab-stop violations), and matching stays scoped to one paragraph at a time
 * (never merges two <w:p> blocks into one match).
 */

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-docx-test-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const VALID_PG_SZ = `<w:pgSz w:w="${PAGE_WIDTH}" w:h="${PAGE_HEIGHT}"/>`;
const VALID_PG_MAR = `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}"/>`;
const VALID_FONT_RUN = `<w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}"/></w:rPr>`;

/** A correctly-formed section heading paragraph — passes every heading-related check. */
function validHeadingParagraph(text = "Professional Summary"): string {
  return (
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/>` +
    `<w:pBdr><w:bottom w:val="single" w:color="444444" w:sz="8" w:space="4"/></w:pBdr>` +
    `<w:ind w:left="0" w:right="0"/></w:pPr>` +
    `<w:r>${VALID_FONT_RUN}<w:t>${text}</w:t></w:r></w:p>`
  );
}

/** Same content, but with the pieces spread across literal newlines — the exact case the dotAll
 *  flag (and its [\s\S] replacement) exists to handle. */
function validHeadingParagraphWithNewlines(text = "Professional Summary"): string {
  return (
    `<w:p>\n<w:pPr>\n<w:pStyle w:val="Heading1"/>\n` +
    `<w:pBdr><w:bottom w:val="single" w:color="444444" w:sz="8" w:space="4"/></w:pBdr>\n` +
    `<w:ind w:left="0" w:right="0"/>\n</w:pPr>\n` +
    `<w:r>${VALID_FONT_RUN}<w:t>${text}</w:t></w:r>\n</w:p>`
  );
}

/** A Heading1 paragraph deliberately missing its <w:pBdr> border — must still be caught. */
function headingParagraphMissingBorder(text = "Technical Skills"): string {
  return (
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/>` +
    `<w:ind w:left="0" w:right="0"/></w:pPr>` +
    `<w:r>${VALID_FONT_RUN}<w:t>${text}</w:t></w:r></w:p>`
  );
}

/** A correctly-formed role-header paragraph with a real <w:tab/> run element at the right position. */
function validTabsParagraph(): string {
  return (
    `<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="${CONTENT_WIDTH}"/></w:tabs></w:pPr>` +
    `<w:r>${VALID_FONT_RUN}<w:t>Company A</w:t></w:r>` +
    `<w:r>${VALID_FONT_RUN}<w:tab/></w:r>` +
    `<w:r>${VALID_FONT_RUN}<w:t>2020 - Present</w:t></w:r></w:p>`
  );
}

/** Declares <w:tabs> but uses a literal tab character in <w:t> text instead of a real <w:tab/> run —
 *  the exact regression class validateDocx exists to catch. */
function tabsParagraphWithLiteralTabChar(): string {
  return (
    `<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="${CONTENT_WIDTH}"/></w:tabs></w:pPr>` +
    `<w:r>${VALID_FONT_RUN}<w:t>Company A\t2020 - Present</w:t></w:r></w:p>`
  );
}

interface BuildOptions {
  bodyParagraphs: string;
  includeNumbering?: boolean;
}

async function buildTestDocx(opts: BuildOptions): Promise<string> {
  const zip = new JSZip();
  const includeNumbering = opts.includeNumbering ?? true;

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>` +
    opts.bodyParagraphs +
    `<w:sectPr>${VALID_PG_SZ}${VALID_PG_MAR}</w:sectPr>` +
    `</w:body></w:document>`;

  zip.file("word/document.xml", documentXml);
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="mailto" Target="mailto:fixture@example.com"/>` +
      `</Relationships>`
  );
  if (includeNumbering) {
    zip.file(
      "word/numbering.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>` +
        `</w:numbering>`
    );
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const filePath = path.join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.docx`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// Body wrapper providing the two other resume-only pass conditions (keepNext, widowControl) that
// aren't the focus of these tests, plus one always-present, always-valid heading + tabs pair so a
// test can isolate a SECOND paragraph's behavior without every other check failing around it.
function wrapBody(extra: string): string {
  return `<w:p><w:pPr><w:keepNext/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>` + `<w:p><w:pPr><w:widowControl/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>` + extra;
}

test("heading paragraph split across literal newlines is still matched (dotAll -> [\\s\\S] equivalence)", async () => {
  const filePath = await buildTestDocx({ bodyParagraphs: wrapBody(validHeadingParagraphWithNewlines() + validTabsParagraph()) });
  const result = await validateDocx(filePath, "resume");
  assert.ok(
    !result.violations.some((v) => v.includes("No section headings found")),
    `expected the newline-spanning heading to be matched; violations: ${JSON.stringify(result.violations)}`
  );
  assert.ok(
    !result.violations.some((v) => v.includes("missing its bottom-border divider")),
    `expected the newline-spanning heading's border to be found within its own match; violations: ${JSON.stringify(result.violations)}`
  );
});

test("tabs paragraph split across literal newlines is still matched (dotAll -> [\\s\\S] equivalence)", async () => {
  const newlineTabsParagraph = validTabsParagraph().replace("><w:pPr>", ">\n<w:pPr>\n").replace("</w:pPr>", "</w:pPr>\n");
  const filePath = await buildTestDocx({ bodyParagraphs: wrapBody(validHeadingParagraph() + newlineTabsParagraph) });
  const result = await validateDocx(filePath, "resume");
  assert.ok(
    !result.violations.some((v) => v.includes("No role-header tab-stop paragraphs found")),
    `expected the newline-spanning tabs paragraph to be matched; violations: ${JSON.stringify(result.violations)}`
  );
});

test("a fully valid document (single-line, matching real generator output shape) has zero heading/tabs violations", async () => {
  const filePath = await buildTestDocx({ bodyParagraphs: wrapBody(validHeadingParagraph() + validTabsParagraph()) });
  const result = await validateDocx(filePath, "resume");
  const structuralViolations = result.violations.filter(
    (v) => v.includes("section heading") || v.includes("role-header tab-stop") || v.includes("tab-stop paragraph")
  );
  assert.deepEqual(structuralViolations, [], `expected no heading/tabs violations; got: ${JSON.stringify(result.violations)}`);
});

test("a heading missing its border divider is still caught as a violation (rule not weakened)", async () => {
  const filePath = await buildTestDocx({ bodyParagraphs: wrapBody(validHeadingParagraph() + headingParagraphMissingBorder() + validTabsParagraph()) });
  const result = await validateDocx(filePath, "resume");
  assert.ok(
    result.violations.some((v) => v.includes("missing its bottom-border divider")),
    `expected the second heading's missing border to be caught individually (proves matching is per-paragraph, not one merged match across both headings); violations: ${JSON.stringify(result.violations)}`
  );
});

test("a literal tab character inside <w:t> text is still caught as a violation (rule not weakened)", async () => {
  const filePath = await buildTestDocx({ bodyParagraphs: wrapBody(validHeadingParagraph() + tabsParagraphWithLiteralTabChar()) });
  const result = await validateDocx(filePath, "resume");
  assert.ok(
    result.violations.some((v) => v.includes("literal tab character")),
    `expected the literal-tab-character regression to still be caught; violations: ${JSON.stringify(result.violations)}`
  );
  assert.ok(
    result.violations.some((v) => v.includes("no real <w:tab/> run element")),
    `expected the missing real <w:tab/> element to still be caught; violations: ${JSON.stringify(result.violations)}`
  );
});
