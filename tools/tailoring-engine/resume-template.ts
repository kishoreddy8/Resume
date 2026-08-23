import fs from "node:fs";
import path from "node:path";
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
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
  SIZE_ROLE_TITLE,
  SIZE_TAGLINE,
  SPACE_AFTER_SECTION_RULE,
  SPACE_BEFORE_ROLE,
  SPACE_BEFORE_SECTION,
  SPACE_BETWEEN_BULLETS,
  SPACE_BETWEEN_SKILL_LINES,
} from "./constants";
import type { ExperienceEntry, KeyProject, ResumeContent } from "./types";
import { buildCertificationBadgeRuns } from "./certificationBadges";
// sourceBadgeAssets.ts's extraction/build functions are intentionally NOT imported here while
// BADGES_ENABLED is false below — badges are disabled per explicit user request; the module itself
// is untouched for a future re-enable.

/**
 * Stage 31 — the reference-resume presentation standard.
 *
 * The section order, the left-aligned header block, the two-line role header, the `Project:` and
 * `Environment:` lines, the bulleted certifications and the optional Key Projects section all come
 * from the reference document the user supplied; the exact type sizes and vertical spacing were
 * read out of that document's OOXML rather than estimated by eye (see constants.ts).
 *
 * What did NOT come from the reference is any of its content. Everything below is a layout
 * decision applied to whatever the writer produced from THIS candidate's own evidence; sections
 * the candidate has no evidence for (Key Projects, employer locations) simply do not render.
 */

const BULLET_REF = "resume-bullets";
// Compact-but-clear hanging indent: bullet glyph sits at the margin, wrapped lines align under
// the first letter of the bullet text (not under the glyph) at this same offset.
const BULLET_INDENT_LEFT = 274; // ~0.19in
const BULLET_INDENT_HANGING = 274;

function run(text: string): TextRun {
  return new TextRun({ text, font: FONT, color: BLACK, size: SIZE_BODY });
}

const HYPERLINK_BLUE = "0563C1";

/** Real clickable hyperlink with readable display text, not a raw tracking URL — the conventional
 *  hyperlink blue, underlined, per the reference document's own contact-line styling. */
function link(displayText: string, url: string, size = SIZE_CONTACT): ExternalHyperlink {
  return new ExternalHyperlink({
    link: url,
    children: [
      new TextRun({ text: displayText, size, font: FONT, color: HYPERLINK_BLUE, underline: {} }),
    ],
  });
}

/**
 * Stage 31 — LEFT, not centred. The reference anchors the whole header block to the left margin,
 * which is also what keeps the name, headline and contact line reading as one unit instead of
 * three separately-centred fragments of differing width.
 *
 * Phase H (clarified again) — the candidate's certification badges, right tab-stopped to the
 * content margin, as one horizontal row on the SAME line as the name — the true top-right corner,
 * matching the reference resume's own badge placement exactly. Tables, text boxes and floating
 * shapes are forbidden for resume layout (validate-docx.ts — an existing ATS-safety gate this
 * change does not touch), so this is built the same way `companyLine`'s dates already sit at the
 * right margin: a real paragraph-level right tab stop, never a second column — several ImageRun
 * badges simply flow left-to-right after that one tab, exactly like any other inline run.
 *
 * WHY THE NAME LINE IS SAFE HERE, WHEN IT WASN'T FOR TEXT BADGES. `texts[0]` of the rendered
 * document is a protected invariant elsewhere (stage311NameAndVoice.test.ts's "the display name
 * survives rendering exactly") — verified by extracting every `<w:t>` text node in the first
 * paragraph and requiring it to equal the candidate's name exactly. A `Tab()` run and an `ImageRun`
 * both produce zero `<w:t>` text content (`<w:tab/>` and `<w:drawing>` respectively) — only a run
 * with an actual string produces `<w:t>`. So real preserved badge IMAGES (sourceBadgeAssets.ts —
 * always ImageRun, never any accompanying visible text) can sit on the name line without adding a
 * single character to what that invariant extracts; confirmed directly against the same regex the
 * protected test uses before this was relied on. The generic shaded-TEXT-card fallback
 * (certificationBadges.ts) is NOT eligible for this — its badges are TextRuns with real visible
 * text ("AZURE CERTIFIED" etc.), which absolutely would corrupt the extracted name, so those still
 * ride the headline line instead (see headlineLine below). isImageOnlyBadgeSet() below is the one
 * place that decides which line a given badge set is allowed to use.
 */
function isImageOnlyBadgeSet(badgeRuns: (TextRun | ImageRun)[]): badgeRuns is ImageRun[] {
  return badgeRuns.length > 0 && badgeRuns.every((r) => r instanceof ImageRun);
}

/**
 * `imageBadgesWidthTwips` is the pre-computed combined display width of `imageBadges` (see
 * sourceBadgeAssets.ts's sumBadgeDisplayWidthTwips) — a LEFT tab stop at CONTENT_WIDTH minus that
 * width places the row's own left edge so its RIGHT edge lands exactly at the content's right
 * margin, computed here rather than trusted to a right-tab-stop's own width summation (see the doc
 * comment above nameLine's declaration for why).
 */
function nameLine(text: string, imageBadges: ImageRun[] = [], imageBadgesWidthTwips = 0): Paragraph {
  const children: (TextRun | ImageRun)[] = [new TextRun({ text, bold: true, size: SIZE_NAME, font: FONT, color: BLACK })];
  if (imageBadges.length > 0) {
    // No text spacer between badges here (unlike headlineLine's text-card row): any run with real
    // text content on the name paragraph would corrupt the exact-name-match invariant this line
    // exists to protect (see the doc comment above) — even a literal space. Each source badge PNG
    // already carries its own small transparent/white border, which is enough visual separation
    // when they sit directly adjacent.
    children.push(new TextRun({ children: [new Tab()] }), ...imageBadges);
  }
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    keepNext: true,
    spacing: { after: 20 },
    ...(imageBadges.length > 0
      ? { tabStops: [{ type: TabStopType.LEFT, position: Math.max(0, CONTENT_WIDTH - imageBadgesWidthTwips) }] }
      : {}),
    children,
  });
}

/** The headline: bold, not italic, and left-aligned under the name — as the reference sets it. Only
 *  the generic text-card badge fallback rides this line (see isImageOnlyBadgeSet's doc comment) —
 *  real preserved image badges ride the name line instead, one line up. */
function headlineLine(text: string, textBadgeRuns: TextRun[]): Paragraph {
  const children: (TextRun | ImageRun)[] = [new TextRun({ text, bold: true, size: SIZE_TAGLINE, font: FONT, color: BLACK })];
  if (textBadgeRuns.length > 0) {
    children.push(new TextRun({ children: [new Tab()] }));
    textBadgeRuns.forEach((badge, i) => {
      if (i > 0) children.push(new TextRun({ text: "  ", size: SIZE_CONTACT, font: FONT }));
      children.push(badge);
    });
  }
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    keepNext: true,
    spacing: { after: 20 },
    ...(textBadgeRuns.length > 0 ? { tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }] } : {}),
    children,
  });
}

/** location | phone | email (mailto: link) | LinkedIn (https: link, readable text not a raw URL) */
function contactLine(params: { location: string; phone: string; email: string; linkedin?: string; github?: string }): Paragraph {
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
  /* After LinkedIn, so the header order stays stable whether or not GitHub is present. */
  if (params.github) {
    const url = params.github.startsWith("http") ? params.github : `https://${params.github}`;
    children.push(sep(), link(params.github, url));
  }
  return new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 60 }, children });
}

/**
 * The header block: name, headline, contact — exactly as before Phase H when there are no
 * recognized certification badges. When the candidate has real preserved badge IMAGES (source
 * badges — see sourceBadgeAssets.ts), they ride the NAME line itself as one horizontal row,
 * right-tab-stopped to the content margin: the true top-right corner, matching the reference
 * resume exactly, safe only because an image contributes no text to the protected exact-name-match
 * invariant (see nameLine's own doc comment). The generic shaded-text-card fallback
 * (certificationBadges.ts) still rides the headline line instead, one line down, since its runs
 * carry real visible text that the name line can never safely host.
 */
function headerBlock(content: ResumeContent, badgeRuns: (TextRun | ImageRun)[], imageBadgesWidthTwips: number): Paragraph[] {
  const imageBadges = isImageOnlyBadgeSet(badgeRuns) ? badgeRuns : [];
  const textBadgeRuns = imageBadges.length === 0 ? (badgeRuns as TextRun[]) : [];
  return [
    nameLine(content.name, imageBadges, imageBadgesWidthTwips),
    headlineLine(content.tagline, textBadgeRuns),
    contactLine({
      location: content.location,
      phone: content.phone,
      email: content.email,
      linkedin: content.linkedin,
      github: content.github,
    }),
  ];
}

/**
 * keepNext so a heading never renders as the last line on a page, orphaned from its content.
 * Explicit zero indent so the bottom border always spans the exact same left/right content
 * boundary as every other section, regardless of any inherited style default.
 *
 * The reference achieves the same full-width rule by underlining the heading text and a trailing
 * tab run out to the right margin. A real paragraph border is the more robust of the two — it
 * cannot drift with the heading's text length — so that is what is kept here.
 */
function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    keepNext: true,
    indent: { left: 0, right: 0 },
    spacing: { before: SPACE_BEFORE_SECTION, after: SPACE_AFTER_SECTION_RULE },
    border: { bottom: { style: "single", size: 6, color: HEADING_RULE_COLOR, space: 2 } },
    children: [
      new TextRun({ text: text.toUpperCase(), bold: true, size: SIZE_HEADING, font: FONT, color: BLACK }),
    ],
  });
}

function bodyParagraph(text: string, keepWithNext = false): Paragraph {
  return new Paragraph({
    keepLines: true,
    widowControl: true,
    keepNext: keepWithNext,
    indent: { left: 0, right: 0 },
    spacing: { after: 60 },
    children: [run(text)],
  });
}

function skillGroupLine(label: string, items: string[]): Paragraph {
  return new Paragraph({
    keepLines: true,
    widowControl: true,
    indent: { left: 0, right: 0 },
    spacing: { before: SPACE_BETWEEN_SKILL_LINES, after: 0 },
    children: [
      new TextRun({ text: `${label}: `, bold: true, size: SIZE_BODY, font: FONT, color: BLACK }),
      run(items.join(", ")),
    ],
  });
}

/**
 * Company (and location, when the Master Resume states one) at the left, dates at the right —
 * a real right-tab-stop element (`Tab`), not a literal "\t" embedded in a text run. A raw tab
 * character inside <w:t> is not a paragraph-tab-stop instruction to most renderers (browsers,
 * some ATS parsers) — it just renders as an ordinary tab-width whitespace glyph, which is why
 * dates previously landed a few characters after the title instead of at the right margin. `Tab`
 * emits the dedicated OOXML <w:tab/> run element real Word requires.
 *
 * Stage 31 splits what used to be one "Title | Company ....... dates" line into the reference's
 * two lines: the employer and the tenure on the first, the job title on its own beneath. That is
 * the change that makes a multi-role history scannable — a reader's eye finds employers down one
 * column and dates down another, instead of parsing a pipe-separated compound on every role.
 */
function companyLine(company: string, location: string | undefined, dates: string): Paragraph {
  const left = location && location.trim().length > 0 ? `${company}, ${location.trim()}` : company;
  return new Paragraph({
    keepNext: true,
    indent: { left: 0, right: 0 },
    spacing: { before: SPACE_BEFORE_ROLE, after: 0 },
    tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }],
    children: [
      new TextRun({ text: left, bold: true, size: SIZE_EXPERIENCE_HEADING, font: FONT, color: BLACK }),
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

/** The job title on its own line. Stage 31.1 — bold, no italic (see labelledLine's note). */
function roleTitleLine(title: string): Paragraph {
  return new Paragraph({
    keepNext: true,
    indent: { left: 0, right: 0 },
    spacing: { before: 10, after: 0 },
    children: [
      new TextRun({ text: title, bold: true, size: SIZE_ROLE_TITLE, font: FONT, color: BLACK }),
    ],
  });
}

/**
 * `Project:` / `Environment:` — the reference's two labelled context lines around a role's bullets.
 *
 * Stage 31.1 — no italics anywhere in the document. The reference sets these lines (and the job
 * title) in italic, but italic body text is the one style choice here that actively works against
 * the document's job: it renders thinner on screen, is the first thing to degrade when an ATS
 * flattens formatting, and buys a distinction that weight and the bold label already carry. The
 * label stays bold so the line still reads as annotation rather than as another achievement claim.
 */
function labelledLine(label: string, value: string, keepWithNext: boolean): Paragraph {
  return new Paragraph({
    keepLines: true,
    widowControl: true,
    keepNext: keepWithNext,
    indent: { left: 0, right: 0 },
    spacing: { before: 30, after: 0 },
    children: [
      new TextRun({ text: `${label}: `, bold: true, size: SIZE_BODY, font: FONT, color: BLACK }),
      new TextRun({ text: value, size: SIZE_BODY, font: FONT, color: BLACK }),
    ],
  });
}

function bullet(text: string, keepWithNext: boolean): Paragraph {
  return new Paragraph({
    numbering: { reference: BULLET_REF, level: 0 },
    keepLines: true,
    widowControl: true,
    keepNext: keepWithNext,
    spacing: { before: SPACE_BETWEEN_BULLETS, after: 0 },
    children: [run(text)],
  });
}

/** A bulleted line whose leading phrase is emphasised — certifications and Key Projects both use it. */
function emphasisedBullet(lead: string, rest: string): Paragraph {
  const children = [
    new TextRun({ text: lead, bold: true, size: SIZE_BODY, font: FONT, color: BLACK }),
  ];
  if (rest.length > 0) children.push(run(rest));
  return new Paragraph({
    numbering: { reference: BULLET_REF, level: 0 },
    keepLines: true,
    widowControl: true,
    spacing: { before: SPACE_BETWEEN_BULLETS, after: 0 },
    children,
  });
}

function keyProjectBullet(project: KeyProject): Paragraph {
  const tech = project.technologies && project.technologies.length > 0 ? ` (${project.technologies.join(", ")})` : "";
  return emphasisedBullet(project.name, ` — ${project.description}${tech}`);
}

/**
 * Lays one education STRING out in the reference's two-line shape without changing a character of
 * it: degree at the left with the dates right-tabbed, institution beneath.
 *
 * The conventional form the writer is asked for is "<Degree>, <Institution> — <Dates>". Anything
 * this cannot split confidently is returned whole, to be rendered as a single ordinary line: a
 * line that does not match the convention is a line whose parts this function does not actually
 * know, and guessing where the institution ends would corrupt a verified fact for the sake of
 * layout. Nothing is ever dropped or truncated on either path.
 */
export function splitEducationLine(line: string): { degree: string; institution?: string; dates?: string } {
  const text = line.trim();
  // The dates tail is introduced by a spaced dash, never by the comma that separates degree from
  // institution and never by the hyphen inside "end-to-end". Stage 31.1 accepts a plain hyphen as
  // well as the em/en dash: the writer is now told to avoid em/en dashes entirely, and education
  // lines already stored with one must keep parsing exactly as before.
  const dashMatch = text.match(/\s+[—–-]\s+(.+)$/);
  const head = dashMatch ? text.slice(0, dashMatch.index).trim() : text;
  const dates = dashMatch ? dashMatch[1].trim() : undefined;

  // Institution is the final comma-separated clause of the head, and only when the head really
  // does have a degree part in front of it.
  const lastComma = head.lastIndexOf(",");
  if (lastComma <= 0 || lastComma === head.length - 1) {
    return dates ? { degree: head, dates } : { degree: head };
  }
  const degree = head.slice(0, lastComma).trim();
  const institution = head.slice(lastComma + 1).trim();
  if (degree.length === 0 || institution.length === 0) {
    return dates ? { degree: head, dates } : { degree: head };
  }
  return { degree, institution, ...(dates ? { dates } : {}) };
}

function educationParagraphs(line: string): Paragraph[] {
  const parsed = splitEducationLine(line);
  const out: Paragraph[] = [];
  const degreeChildren = [
    new TextRun({ text: parsed.degree, bold: true, size: SIZE_BODY, font: FONT, color: BLACK }),
  ];
  if (parsed.dates) {
    degreeChildren.push(
      new TextRun({
        children: [new Tab(), parsed.dates],
        bold: true,
        size: SIZE_BODY,
        font: FONT,
        color: BLACK,
      })
    );
  }
  out.push(
    new Paragraph({
      keepLines: true,
      widowControl: true,
      keepNext: Boolean(parsed.institution),
      indent: { left: 0, right: 0 },
      spacing: { before: 40, after: 0 },
      ...(parsed.dates ? { tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }] } : {}),
      children: degreeChildren,
    })
  );
  if (parsed.institution) {
    out.push(
      new Paragraph({
        keepLines: true,
        widowControl: true,
        indent: { left: 0, right: 0 },
        spacing: { before: 10, after: 0 },
        children: [run(parsed.institution)],
      })
    );
  }
  return out;
}

/** One employer: company/dates, title, optional Project:, bullets, optional Environment:. */
function experienceParagraphs(role: ExperienceEntry): Paragraph[] {
  const out: Paragraph[] = [
    companyLine(role.company, role.location, role.dates),
    roleTitleLine(role.title),
  ];
  if (role.projectDescription && role.projectDescription.trim().length > 0) {
    // keepNext: the scope line belongs with the bullets it introduces, never stranded at a page foot.
    out.push(labelledLine("Project", role.projectDescription.trim(), true));
  }
  // Stage 30 — bullets are NOT chained to each other.
  //
  // Previously every bullet but the last carried keepNext, which chained header -> bullet1 -> ...
  // -> bulletN into a single unbreakable block. Word then had to move an ENTIRE employer to the
  // next page whenever it did not fit in the remaining space, which is what produced the large
  // blank region at the foot of a page on the real corpus.
  //
  // Each bullet still keeps its OWN lines together (keepLines) and still has widow control, so a
  // single bullet is never split mid-sentence across a page boundary; only the boundary BETWEEN
  // bullets is now a legal break. No bullet is removed or shortened.
  for (const text of role.bullets) out.push(bullet(text, false));

  if (role.environment && role.environment.length > 0) {
    out.push(labelledLine("Environment", role.environment.join(", "), false));
  }
  return out;
}

export interface GenerateResumeDocxOptions {
  /**
   * The candidate's own Master Resume .docx file, resolved by the caller from a trusted
   * candidateId (see tailoringExecution.ts) — never taken from writer output. When it exists and
   * has embedded images, those images are extracted and preserved as real inline badges (see
   * sourceBadgeAssets.ts); otherwise the generic text-card fallback below is used, exactly as
   * before this option existed.
   */
  masterResumeDocxPath?: string;
}

export async function generateResumeDocx(
  content: ResumeContent,
  outputPath: string,
  options: GenerateResumeDocxOptions = {}
): Promise<void> {
  // Section order is the reference's, exactly: identity block, then what the candidate can do,
  // then proof they have done it, then credentials.
  //
  // Certification badges (image or generic text-card) are disabled per explicit user request —
  // both extraction and rendering are skipped entirely, keeping the header plain. The bulleted
  // Certifications section further down (the actual ATS-authoritative text) is completely
  // unaffected either way; this only turns off the decorative header row. The underlying modules
  // (sourceBadgeAssets.ts, certificationBadges.ts) are left intact, not deleted, in case this is
  // re-enabled later — this is a single, easily-reversible flag, not a rewrite.
  const BADGES_ENABLED = false;
  const certificationBadgeRuns: (TextRun | ImageRun)[] = BADGES_ENABLED ? buildCertificationBadgeRuns(content.certifications) : [];
  const imageBadgesWidthTwips = 0;

  const children: Paragraph[] = [
    ...headerBlock(content, certificationBadgeRuns, imageBadgesWidthTwips),

    sectionHeading("Professional Summary"),
    // Stage 31.1 — ONE paragraph, always.
    //
    // `summary` stays an array because the content contract, the reviewers and every stored
    // artifact already speak that shape, but the array is a list of SENTENCE GROUPS, not of
    // paragraphs. Rendering one paragraph per element is what turned the summary into a stack of
    // four mini-paragraphs that read as unbulleted bullets. Joining here makes the single-paragraph
    // rule structural: no writer output, however it is segmented, can produce a fragmented summary.
    bodyParagraph(content.summary.map((s) => s.trim()).filter((s) => s.length > 0).join(" ")),

    sectionHeading("Technical Skills"),
    ...content.skillGroups.map((g) => skillGroupLine(g.label, g.items)),
  ];

  // Certifications are a credential LIST in the reference, bulleted like every other list on the
  // page — not the run of unmarked body paragraphs they used to render as.
  if (content.certifications && content.certifications.length > 0) {
    children.push(sectionHeading("Certifications"));
    for (const cert of content.certifications) {
      children.push(bullet(cert, false));
    }
  }

  children.push(sectionHeading("Professional Experience"));
  for (const role of content.experience) {
    children.push(...experienceParagraphs(role));
  }

  // Omitted entirely — not rendered empty — when the candidate has no recorded project evidence.
  if (content.keyProjects && content.keyProjects.length > 0) {
    children.push(sectionHeading("Key Projects"));
    for (const project of content.keyProjects) {
      children.push(keyProjectBullet(project));
    }
  }

  children.push(sectionHeading("Education"));
  for (const line of content.education) {
    children.push(...educationParagraphs(line));
  }

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
