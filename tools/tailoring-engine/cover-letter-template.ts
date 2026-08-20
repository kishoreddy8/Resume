import fs from "node:fs";
import path from "node:path";
import { Document, ExternalHyperlink, Packer, Paragraph, TextRun } from "docx";
import { BLACK, FONT, MARGIN, PAGE_HEIGHT, PAGE_WIDTH, SIZE_BODY, SIZE_CONTACT } from "./constants";
import type { CoverLetterContent } from "./types";

function link(displayText: string, url: string, size = SIZE_CONTACT): ExternalHyperlink {
  return new ExternalHyperlink({
    link: url,
    children: [
      new TextRun({ text: displayText, size, font: FONT, color: "0563C1", underline: {} }),
    ],
  });
}

/**
 * Stage 30 — the renderer owns the signature, deterministically.
 *
 * THE DEFECT. The template rendered `content.closing` and then appended `content.name` as its own
 * paragraph. When the writer produced a closing that already contained the name — on the real corpus
 * it was exactly "Sincerely,\nSai Kishore Reddy" — the letter ended with the candidate's name twice.
 *
 * Fixed at the renderer boundary rather than by asking the model to format it perfectly: the closing
 * is reduced to its salutation line(s) only, and the name is emitted once, by us. A writer that omits
 * the name, includes it, or includes it with different spacing all produce the same correct output.
 */
export function stripTrailingSignature(closing: string, candidateName: string): string {
  const target = candidateName.trim().toLowerCase().replace(/\s+/g, " ");
  if (target.length === 0) return closing.trim();
  const lines = closing.split(/\r?\n/);
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim().replace(/\s+/g, " ").replace(/[.,]$/, "");
    if (last.length === 0 || last.toLowerCase() === target) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join("\n").trim();
}

function bodyParagraph(text: string): Paragraph {
  return new Paragraph({
    keepLines: true,
    widowControl: true,
    indent: { left: 0, right: 0 },
    spacing: { after: 200 },
    children: [new TextRun({ text, font: FONT, color: BLACK, size: SIZE_BODY })],
  });
}

export async function generateCoverLetterDocx(
  content: CoverLetterContent,
  outputPath: string
): Promise<void> {
  const sep = () => new TextRun({ text: "  |  ", size: SIZE_CONTACT, font: FONT, color: BLACK });
  const contactChildren: (TextRun | ExternalHyperlink)[] = [
    new TextRun({ text: content.location, size: SIZE_CONTACT, font: FONT, color: BLACK }),
    sep(),
    new TextRun({ text: content.phone, size: SIZE_CONTACT, font: FONT, color: BLACK }),
    sep(),
    link(content.email, `mailto:${content.email}`),
  ];
  if (content.linkedin) {
    const url = content.linkedin.startsWith("http") ? content.linkedin : `https://${content.linkedin}`;
    contactChildren.push(sep(), link(content.linkedin, url));
  }
  if (content.github) {
    const url = content.github.startsWith("http") ? content.github : `https://${content.github}`;
    contactChildren.push(sep(), link(content.github, url));
  }

  const children: Paragraph[] = [
    new Paragraph({
      spacing: { after: 60 },
      children: [new TextRun({ text: content.name, bold: true, size: SIZE_BODY + 2, font: FONT, color: BLACK })],
    }),
    new Paragraph({ spacing: { after: 300 }, children: contactChildren }),
    bodyParagraph(content.salutation),
    ...content.paragraphs.map(bodyParagraph),
    // The closing keeps only its salutation ("Sincerely,"); the name below is the single signature.
    bodyParagraph(stripTrailingSignature(content.closing, content.name)),
    new Paragraph({
      children: [new TextRun({ text: content.name, font: FONT, color: BLACK, size: SIZE_BODY })],
    }),
  ];

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: SIZE_BODY, color: BLACK },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
          },
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
}
