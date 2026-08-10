import fs from "node:fs";
import path from "node:path";
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Tab,
  TabStopType,
  TextRun,
} from "docx";
import {
  BLACK,
  CONTENT_WIDTH,
  FONT,
  HEADING_RULE_COLOR,
  MARGIN,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  SIZE_BODY,
  SIZE_CONTACT,
  SIZE_EXPERIENCE_HEADING,
  SIZE_HEADING,
  SIZE_NAME,
  SIZE_TAGLINE,
} from "./constants";
import type { ResumeContent } from "./types";

const BULLET_REF = "resume-bullets";
// Compact-but-clear hanging indent: bullet glyph sits at the margin, wrapped lines align under
// the first letter of the bullet text (not under the glyph) at this same offset.
const BULLET_INDENT_LEFT = 274; // ~0.19in
const BULLET_INDENT_HANGING = 274;

function run(text: string): TextRun {
  return new TextRun({ text, font: FONT, color: BLACK, size: SIZE_BODY });
}

/** Real clickable hyperlink with readable display text, not a raw tracking URL. */
function link(displayText: string, url: string, size = SIZE_CONTACT): ExternalHyperlink {
  return new ExternalHyperlink({
    link: url,
    children: [
      new TextRun({ text: displayText, size, font: FONT, color: "0563C1", underline: {} }),
    ],
  });
}

function nameLine(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 40 },
    children: [new TextRun({ text, bold: true, size: SIZE_NAME, font: FONT, color: BLACK })],
  });
}

function taglineLine(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 40 },
    children: [new TextRun({ text, italics: true, size: SIZE_TAGLINE, font: FONT, color: BLACK })],
  });
}

/** location | phone | email (mailto: link) | LinkedIn (https: link, readable text not a raw URL) */
function contactLine(params: {
  location: string;
  phone: string;
  email: string;
  linkedin?: string;
}): Paragraph {
  const sep = () => new TextRun({ text: "  |  ", size: SIZE_CONTACT, font: FONT, color: BLACK });
  const children: (TextRun | ExternalHyperlink)[] = [
    new TextRun({ text: params.location, size: SIZE_CONTACT, font: FONT, color: BLACK }),
    sep(),
    new TextRun({ text: params.phone, size: SIZE_CONTACT, font: FONT, color: BLACK }),
    sep(),
    link(params.email, `mailto:${params.email}`),
  ];
  if (params.linkedin) {
    const url = params.linkedin.startsWith("http") ? params.linkedin : `https://${params.linkedin}`;
    children.push(sep(), link(params.linkedin, url));
  }
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children });
}

/**
 * keepNext so a heading never renders as the last line on a page, orphaned from its content.
 * Explicit zero indent so the bottom border always spans the exact same left/right content
 * boundary as every other section, regardless of any inherited style default.
 */
function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    keepNext: true,
    indent: { left: 0, right: 0 },
    spacing: { before: 200, after: 80 },
    border: { bottom: { style: "single", size: 6, color: HEADING_RULE_COLOR, space: 2 } },
    children: [
      new TextRun({ text: text.toUpperCase(), bold: true, size: SIZE_HEADING, font: FONT, color: BLACK }),
    ],
  });
}

function bodyParagraph(text: string): Paragraph {
  return new Paragraph({
    keepLines: true,
    widowControl: true,
    indent: { left: 0, right: 0 },
    spacing: { after: 100 },
    children: [run(text)],
  });
}

function skillGroupLine(label: string, items: string[]): Paragraph {
  return new Paragraph({
    keepLines: true,
    widowControl: true,
    indent: { left: 0, right: 0 },
    spacing: { after: 60 },
    children: [
      new TextRun({ text: `${label}: `, bold: true, size: SIZE_BODY, font: FONT, color: BLACK }),
      run(items.join(", ")),
    ],
  });
}

/**
 * Company left, dates right — a real right-tab-stop element (`Tab`), not a literal "\t" embedded
 * in a text run. A raw tab character inside <w:t> is not a paragraph-tab-stop instruction to most
 * renderers (browsers, some ATS parsers) — it just renders as an ordinary tab-width whitespace
 * glyph, which is why dates previously landed a few characters after the title instead of at the
 * right margin. `Tab` emits the dedicated OOXML <w:tab/> run element real Word requires.
 */
function roleHeader(title: string, company: string, dates: string, keepWithNext: boolean): Paragraph {
  return new Paragraph({
    keepNext: keepWithNext,
    indent: { left: 0, right: 0 },
    spacing: { before: 180, after: 60 },
    tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }],
    children: [
      new TextRun({
        text: `${title} | ${company}`,
        bold: true,
        size: SIZE_EXPERIENCE_HEADING,
        font: FONT,
        color: BLACK,
      }),
      new TextRun({
        children: [new Tab(), dates],
        bold: true,
        size: SIZE_EXPERIENCE_HEADING,
        font: FONT,
        color: BLACK,
      }),
    ],
  });
}

/** keepNext chains a bullet to the next paragraph so Word avoids breaking mid-role wherever it can. */
function bullet(text: string, keepWithNext: boolean): Paragraph {
  return new Paragraph({
    numbering: { reference: BULLET_REF, level: 0 },
    keepLines: true,
    widowControl: true,
    keepNext: keepWithNext,
    spacing: { after: 80 },
    children: [run(text)],
  });
}

export async function generateResumeDocx(content: ResumeContent, outputPath: string): Promise<void> {
  const children: Paragraph[] = [
    nameLine(content.name),
    taglineLine(content.tagline),
    contactLine({
      location: content.location,
      phone: content.phone,
      email: content.email,
      linkedin: content.linkedin,
    }),

    sectionHeading("Professional Summary"),
    ...content.summary.map(bodyParagraph),

    sectionHeading("Technical Skills"),
    ...content.skillGroups.map((g) => skillGroupLine(g.label, g.items)),
  ];

  if (content.certifications && content.certifications.length > 0) {
    children.push(sectionHeading("Certifications"));
    children.push(...content.certifications.map(bodyParagraph));
  }

  children.push(sectionHeading("Professional Experience"));
  for (const role of content.experience) {
    // The role header keeps-with-next unconditionally (never orphan a heading from its first bullet).
    children.push(roleHeader(role.title, role.company, role.dates, true));
    role.bullets.forEach((text, i) => {
      const isLast = i === role.bullets.length - 1;
      children.push(bullet(text, !isLast));
    });
  }

  children.push(sectionHeading("Education"));
  children.push(...content.education.map(bodyParagraph));

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: BULLET_REF,
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: { left: BULLET_INDENT_LEFT, hanging: BULLET_INDENT_HANGING },
                },
              },
            },
          ],
        },
      ],
    },
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
