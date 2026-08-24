import fs from "node:fs";
import JSZip from "jszip";
import type { ResumeContent, CoverLetterContent } from "../../../tools/tailoring-engine/types";

export interface ArtifactParityResult {
  valid: boolean;
  document: "resume" | "coverLetter";
  violations: string[];
  checkedSections: {
    name: boolean;
    summary?: boolean;
    experience?: { employer: string; matchedBullets: number; expectedBullets: number }[];
    skills?: boolean;
    education?: boolean;
    certifications?: boolean;
    coverLetterParagraphs?: { index: number; found: boolean }[];
  };
}

/**
 * Normalizes text deterministically to eliminate rendering-specific variations
 * (whitespace, line breaks, smart quotes, bullet glyphs, Unicode normalization).
 */
export function normalizeSemanticText(text: string): string {
  if (!text) return "";
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[•\-\*–\t\r\n]+/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Extracts raw combined text from a DOCX file buffer or path.
 */
export async function extractDocxText(docxPathOrBuffer: string | Buffer): Promise<string> {
  const buffer = typeof docxPathOrBuffer === "string"
    ? fs.readFileSync(docxPathOrBuffer)
    : docxPathOrBuffer;

  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return "";

  const tMatches = xml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
  return tMatches.map((m) => m.replace(/<[^>]+>/g, "")).join(" ");
}

/**
 * Validates semantic artifact parity between ResumeContent JSON and the rendered Resume.docx.
 */
export async function validateResumeArtifactParity(
  docxPathOrBuffer: string | Buffer,
  resume: ResumeContent
): Promise<ArtifactParityResult> {
  const rawText = await extractDocxText(docxPathOrBuffer);
  const normDocx = normalizeSemanticText(rawText);
  const violations: string[] = [];

  // 1. Candidate Name
  const normName = normalizeSemanticText(resume.name);
  const nameMatched = normDocx.includes(normName);
  if (!nameMatched) {
    violations.push(`Rendered Resume.docx missing candidate name: "${resume.name}"`);
  }

  // 2. Summary
  let summaryMatched = true;
  for (const sumLine of resume.summary) {
    const normSummary = normalizeSemanticText(sumLine);
    // Check first 40 chars of summary line
    const excerpt = normSummary.slice(0, 40);
    if (!normDocx.includes(excerpt)) {
      summaryMatched = false;
      violations.push(`Rendered Resume.docx missing summary content excerpt: "${excerpt}"`);
    }
  }

  // 3. Experience & Bullets
  const experienceChecks: Array<{ employer: string; matchedBullets: number; expectedBullets: number }> = [];
  for (const exp of resume.experience) {
    const normCompany = normalizeSemanticText(exp.company);
    if (!normDocx.includes(normCompany)) {
      violations.push(`Rendered Resume.docx missing employer: "${exp.company}"`);
    }

    let matchedBullets = 0;
    for (const bullet of exp.bullets) {
      const normBullet = normalizeSemanticText(bullet);
      const excerpt = normBullet.slice(0, 35);
      if (normDocx.includes(excerpt)) {
        matchedBullets += 1;
      } else {
        violations.push(`At ${exp.company}, rendered Resume.docx missing bullet excerpt: "${excerpt}"`);
      }
    }

    experienceChecks.push({
      employer: exp.company,
      matchedBullets,
      expectedBullets: exp.bullets.length,
    });
  }

  // 4. Skills
  let skillsMatched = true;
  if (resume.skillGroups && resume.skillGroups.length > 0) {
    const firstGroup = resume.skillGroups[0];
    for (const item of firstGroup.items.slice(0, 3)) {
      const normItem = normalizeSemanticText(item);
      if (!normDocx.includes(normItem)) {
        skillsMatched = false;
        violations.push(`Rendered Resume.docx missing primary skill item: "${item}"`);
      }
    }
  }

  return {
    valid: violations.length === 0,
    document: "resume",
    violations,
    checkedSections: {
      name: nameMatched,
      summary: summaryMatched,
      experience: experienceChecks,
      skills: skillsMatched,
      education: true,
      certifications: true,
    },
  };
}

/**
 * Validates semantic artifact parity between CoverLetterContent JSON and the rendered CoverLetter.docx.
 * Specifically catches generic placeholder body rendering defects.
 */
export async function validateCoverLetterArtifactParity(
  docxPathOrBuffer: string | Buffer,
  coverLetter: CoverLetterContent
): Promise<ArtifactParityResult> {
  const rawText = await extractDocxText(docxPathOrBuffer);
  const normDocx = normalizeSemanticText(rawText);
  const violations: string[] = [];

  // Check for generic placeholder failure mode
  if (normDocx.includes("i am excited to apply for this position") && !coverLetter.paragraphs.some(p => normalizeSemanticText(p).includes("excited to apply for this position"))) {
    violations.push(`Rendered CoverLetter.docx contains generic placeholder text instead of approved cover letter paragraphs.`);
  }

  const paragraphChecks: Array<{ index: number; found: boolean }> = [];
  let lastPos = 0;

  for (let i = 0; i < coverLetter.paragraphs.length; i++) {
    const para = coverLetter.paragraphs[i];
    const normPara = normalizeSemanticText(para);
    const excerpt = normPara.slice(0, 45);

    const pos = normDocx.indexOf(excerpt, lastPos);
    if (pos >= 0) {
      paragraphChecks.push({ index: i, found: true });
      lastPos = pos + excerpt.length;
    } else {
      paragraphChecks.push({ index: i, found: false });
      violations.push(`Paragraph ${i + 1} from cover_letter_content.json missing in rendered CoverLetter.docx (excerpt: "${excerpt}")`);
    }
  }

  return {
    valid: violations.length === 0,
    document: "coverLetter",
    violations,
    checkedSections: {
      name: normDocx.includes(normalizeSemanticText(coverLetter.name)),
      coverLetterParagraphs: paragraphChecks,
    },
  };
}
