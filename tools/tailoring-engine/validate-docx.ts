import fs from "node:fs";
import JSZip from "jszip";
import { CONTENT_WIDTH, FONT, MARGIN, PAGE_HEIGHT, PAGE_WIDTH } from "./constants";

export interface ValidationResult {
  valid: boolean;
  violations: string[];
}

const MARGIN_MIN = 792; // 0.55in in twips
const MARGIN_MAX = 936; // 0.65in

/**
 * Deterministic, programmatic checks against the raw OOXML — the layout rules a generated resume
 * must satisfy regardless of which JD it was tailored for. This exists specifically because a
 * subtle bug (a literal "\t" character instead of a real <w:tab/> element) passed every visual
 * "looks right in the code" review and was only caught by inspecting the actual rendered output —
 * this module makes that class of regression fail generation automatically instead of requiring
 * a human to notice it again.
 */
export type DocumentKind = "resume" | "coverLetter";

export async function validateDocx(
  filePath: string,
  kind: DocumentKind = "resume"
): Promise<ValidationResult> {
  const violations: string[] = [];
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);

  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    return { valid: false, violations: ["word/document.xml missing from package"] };
  }

  // --- Page size & margins ---
  const pgSzMatch = documentXml.match(/<w:pgSz w:w="(\d+)" w:h="(\d+)"/);
  if (!pgSzMatch) {
    violations.push("No <w:pgSz> found — page size not set");
  } else {
    const [, w, h] = pgSzMatch;
    if (Number(w) !== PAGE_WIDTH || Number(h) !== PAGE_HEIGHT) {
      violations.push(`Page size ${w}x${h} does not match expected US Letter ${PAGE_WIDTH}x${PAGE_HEIGHT}`);
    }
  }

  const pgMarMatches = [...documentXml.matchAll(/<w:pgMar[^/]*\/>/g)];
  if (pgMarMatches.length === 0) {
    violations.push("No <w:pgMar> found — margins not set");
  } else {
    for (const [tag] of pgMarMatches) {
      const sides: Record<string, number> = {};
      for (const side of ["top", "right", "bottom", "left"]) {
        const m = tag.match(new RegExp(`w:${side}="(\\d+)"`));
        if (m) sides[side] = Number(m[1]);
      }
      const values = Object.values(sides);
      if (values.some((v) => v < MARGIN_MIN || v > MARGIN_MAX)) {
        violations.push(`Margin out of 0.55-0.65in range: ${JSON.stringify(sides)}`);
      }
      if (new Set(values).size > 1) {
        violations.push(`Margins are not a single consistent value: ${JSON.stringify(sides)}`);
      }
      if (values.length && Math.abs(values[0] - MARGIN) > 200) {
        violations.push(`Margin ${values[0]} drifted far from the configured MARGIN constant ${MARGIN}`);
      }
    }
  }

  // --- Font ---
  if (!documentXml.includes(`w:ascii="${FONT}"`)) {
    violations.push(`Expected font "${FONT}" not found anywhere in document.xml`);
  }
  const nonCalibriFonts = [...documentXml.matchAll(/w:ascii="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((f) => f !== FONT);
  if (nonCalibriFonts.length > 0) {
    violations.push(`Non-${FONT} fonts present: ${[...new Set(nonCalibriFonts)].join(", ")}`);
  }

  if (kind === "resume") {
    // --- Section heading dividers: identical border, zero indent (full content width) ---
    // [\s\S] in place of dotAll (`s` flag) `.` — identical matching semantics (every character is
    // either whitespace or non-whitespace), compatible with this project's ES2017 target. The `s`
    // flag requires ES2018+; this file is now included in the main app's tsc pass (see the Stage 1
    // relocation report), which surfaced the incompatibility.
    const headingParagraphs = [...documentXml.matchAll(/<w:p>(?:(?!<\/w:p>)[\s\S])*?w:pStyle w:val="Heading1"(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/g)];
    if (headingParagraphs.length === 0) {
      violations.push("No section headings found (expected at least Professional Summary, Technical Skills, Professional Experience, Education)");
    }
    const borderSizes = new Set<string>();
    for (const [para] of headingParagraphs) {
      const border = para.match(/<w:pBdr><w:bottom w:val="single" w:color="[^"]+" w:sz="(\d+)" w:space="(\d+)"\/><\/w:pBdr>/);
      if (!border) {
        violations.push("A section heading is missing its bottom-border divider");
        continue;
      }
      borderSizes.add(border[1]);
      if (!/<w:ind w:left="0" w:right="0"\/>/.test(para) && !/<w:ind[^/]*w:left="0"[^/]*w:right="0"/.test(para)) {
        violations.push("A section heading does not have explicit left=0/right=0 indent (divider width could drift from content width)");
      }
    }
    if (borderSizes.size > 1) {
      violations.push(`Section heading dividers have inconsistent thickness: ${[...borderSizes].join(", ")}`);
    }

    // --- Role header tab stops: real <w:tab/> element, correct right-tab position ---
    // This is the exact regression class the "\t"-in-text bug belongs to — assert it structurally.
    // Same [\s\S]-for-dotAll substitution as headingParagraphs above.
    const tabsParagraphs = [...documentXml.matchAll(/<w:p>(?:(?!<\/w:p>)[\s\S])*?<w:tabs>(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/g)];
    if (tabsParagraphs.length === 0) {
      violations.push("No role-header tab-stop paragraphs found — expected one per Professional Experience entry");
    }
    for (const [para] of tabsParagraphs) {
      const posMatch = para.match(/<w:tab w:val="right" w:pos="(\d+)"\/>/);
      if (!posMatch) {
        violations.push("A paragraph declares <w:tabs> but no right tab stop was found");
        continue;
      }
      if (Number(posMatch[1]) !== CONTENT_WIDTH) {
        violations.push(
          `Tab stop position ${posMatch[1]} does not equal the derived content width ${CONTENT_WIDTH} (must be computed from page width minus margins, never hard-coded)`
        );
      }
      if (!/<w:r>(?:(?!<\/w:r>).)*<w:tab\/>/.test(para)) {
        violations.push(
          "A tab-stop paragraph has no real <w:tab/> run element — a literal \"\\t\" character embedded in <w:t> text does not trigger tab-stop alignment in most renderers/parsers"
        );
      }
      if (/<w:t[^>]*>\t/.test(para) || /<w:t[^>]*>[^<]*\t/.test(para)) {
        violations.push('A tab-stop paragraph contains a literal tab character inside <w:t> text — use the Tab element instead');
      }
    }

    // --- Bullet numbering / hanging indent ---
    const numberingXml = await zip.file("word/numbering.xml")?.async("string");
    if (!numberingXml) {
      violations.push("word/numbering.xml missing — bullets would not render as real list items");
    } else {
      const hangingMatches = [...numberingXml.matchAll(/w:hanging="(\d+)"/g)].map((m) => Number(m[1]));
      if (hangingMatches.length === 0) {
        violations.push("No hanging indent found in numbering.xml — wrapped bullet lines would align under the bullet glyph, not the text");
      } else if (hangingMatches.some((v) => v < 100 || v > 720)) {
        violations.push(`Bullet hanging indent out of a sane compact range (100-720 twips): ${hangingMatches.join(", ")}`);
      }
    }
  }

  // --- Pagination controls present (resume-specific: headings/role headers must stick to content) ---
  if (kind === "resume" && !documentXml.includes("<w:keepNext/>")) {
    violations.push("No <w:keepNext/> found anywhere — headings/role headers can be orphaned from their content across a page break");
  }
  if (!documentXml.includes("<w:widowControl/>")) {
    violations.push("No <w:widowControl/> found — isolated single lines can be left at the top/bottom of a page");
  }

  // --- Never use tables, text boxes, floating shapes, or images for resume layout ---
  if (documentXml.includes("<w:tbl>")) violations.push("Document contains a <w:tbl> table — forbidden for resume layout");
  if (documentXml.includes("<w:pict>")) violations.push("Document contains legacy VML drawing (<w:pict>) — forbidden");
  if (documentXml.includes("<w:drawing>")) violations.push("Document contains a <w:drawing> (image/shape/text box) — forbidden");
  if (documentXml.includes("w:framePr")) violations.push("Document contains a frame (w:framePr) — forbidden floating text");

  // --- No header/footer content ---
  const headerFooterFiles = Object.keys(zip.files).filter((f) => /word\/(header|footer)\d*\.xml$/.test(f));
  if (headerFooterFiles.length > 0) {
    violations.push(`Document defines header/footer parts (${headerFooterFiles.join(", ")}) — resumes must not carry important content there`);
  }

  // --- Hyperlinks present (email at minimum) ---
  const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("string");
  if (!relsXml || !relsXml.includes("mailto:")) {
    violations.push("No mailto: hyperlink relationship found — email should be a real clickable link");
  }

  return { valid: violations.length === 0, violations };
}

export function formatValidationReport(name: string, result: ValidationResult): string {
  if (result.valid) return `✓ ${name}: all layout checks passed`;
  return [`✗ ${name}: ${result.violations.length} violation(s)`, ...result.violations.map((v) => `  - ${v}`)].join("\n");
}
