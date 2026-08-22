import { ShadingType, TextRun } from "docx";
import { FONT, SIZE_CONTACT } from "./constants";

/**
 * Phase H (Autonomous Tailoring Quality & Resilience Upgrade), clarified — certification
 * presentation.
 *
 * ARCHITECTURE: Certification (free text, from ResumeContent.certifications) -> normalized
 * certification identity (matched against BADGE_REGISTRY below) -> a small local shaded "badge"
 * run (never an image) -> right tab-stopped onto the header's headline/contact lines so a stack of
 * up to two reads as sitting beside the header, at the top right (see resume-template.ts's
 * headerBlock). The name line is never touched — see nameLine's own doc comment for why.
 *
 * NO LOGO ASSETS, AND NO TABLE. This deliberately never embeds an image, icon file, or any brand's
 * actual logo — trademark/licensing status for real vendor marks (AWS, Microsoft/Azure, Google
 * Cloud, Databricks, Snowflake, ...) is not something this codebase can safely clear, so every
 * badge here is a plain, neutral, LOCALLY-GENERATED shaded text run: real selectable text with a
 * background fill, never a picture. There is no "safe/approved logo asset" registry in this
 * codebase to draw from, so this shaded-text presentation IS the fallback described in the
 * clarification request — it is the only path, applied to every candidate, not a conditional
 * branch that sometimes reaches for real artwork. It is also deliberately NOT a table cell: this
 * codebase's own ATS-safety validator (validate-docx.ts) hard-fails any resume containing a
 * `<w:tbl>` element, so a true side-by-side column is not an available layout for this document —
 * see resume-template.ts's headerBlock for how the top-right placement is achieved instead, with a
 * plain paragraph-level right tab stop.
 *
 * NEVER INFERS. A badge appears only for a certification STRING ALREADY PRESENT in
 * ResumeContent.certifications (itself sourced from the Master Resume, never invented here — see
 * truthfulnessChecks.ts::checkEducationAndCertifications, which this module does not touch or
 * duplicate). This module never looks at Skills/MSI technology mentions — mentioning "Azure" or
 * "AWS" in Technical Skills never produces a badge; only a certification string matching a known
 * credential name does. No certification is ever added, removed, or renamed by this module; it
 * only decides whether an ALREADY-APPROVED certification also gets a small badge run next to the
 * header.
 *
 * ATS-SAFE BY CONSTRUCTION. The badge runs supplement, never replace, the existing bulleted
 * Certifications section further down the document — full certification names remain plain,
 * selectable text there regardless of whether a badge was recognized. A candidate with zero
 * certifications, or with only certifications this registry doesn't recognize, renders with no
 * badge runs at all and an unchanged header.
 */

export interface CertificationBadge {
  /** Short label shown on the badge — always real, human-legible text, never an icon-only glyph
   *  (color is never the sole carrier of meaning: the family name is always spelled out here). */
  label: string;
  /** Background fill, hex, no leading '#'. Chosen as a neutral, professional accent — not a copy of
   *  any vendor's actual brand color value. */
  fill: string;
  textColor: string;
}

interface BadgeRule {
  pattern: RegExp;
  badge: CertificationBadge;
}

/**
 * Matched against the full certification string (e.g. "Microsoft Certified: Azure Data Engineer
 * Associate (DP-203)"). Order matters: more specific patterns (e.g. a named Databricks/Snowflake
 * credential) are checked before the generic vendor-family fallback so a badge names the real
 * family the credential belongs to.
 */
const BADGE_REGISTRY: BadgeRule[] = [
  { pattern: /\bAWS\b|Amazon Web Services/i, badge: { label: "AWS", fill: "2B3A4A", textColor: "FFFFFF" } },
  { pattern: /\bAzure\b|\bMicrosoft Certified\b/i, badge: { label: "Azure", fill: "1F4E79", textColor: "FFFFFF" } },
  { pattern: /Google Cloud|\bGCP\b/i, badge: { label: "Google Cloud", fill: "2E5C3E", textColor: "FFFFFF" } },
  { pattern: /Databricks/i, badge: { label: "Databricks", fill: "7A3B12", textColor: "FFFFFF" } },
  // "SnowPro" is Snowflake's actual certification brand name (e.g. "SnowPro Core Certification") —
  // real-world credential text frequently omits the word "Snowflake" entirely.
  { pattern: /Snowflake|SnowPro/i, badge: { label: "Snowflake", fill: "2F6E8C", textColor: "FFFFFF" } },
];

// The header reserves the headline and contact lines for badge runs — the name line never carries
// one (see nameLine's doc comment in resume-template.ts), so two is the practical ceiling. That
// ceiling also keeps the block compact and secondary rather than visually outweighing the
// candidate's own identity text (per the clarification: "candidate identity remains visually
// dominant and the certification badges should be compact and secondary").
const MAX_BADGES = 2;

export function matchCertificationBadge(certificationText: string): CertificationBadge | null {
  const rule = BADGE_REGISTRY.find((r) => r.pattern.test(certificationText));
  return rule ? rule.badge : null;
}

/** One badge per recognized vendor FAMILY, not per certification string — a candidate with two
 *  distinct AWS credentials still gets a single "AWS" badge, keeping the compact block readable. */
function matchedBadges(certifications: string[] | undefined): CertificationBadge[] {
  if (!certifications || certifications.length === 0) return [];
  const seen = new Set<string>();
  const badges: CertificationBadge[] = [];
  for (const cert of certifications) {
    const badge = matchCertificationBadge(cert);
    if (!badge || seen.has(badge.label)) continue;
    seen.add(badge.label);
    badges.push(badge);
    if (badges.length >= MAX_BADGES) break;
  }
  return badges;
}

/** Whether the header should carry any badge runs at all. Zero recognized badges means the header
 *  renders in its original, unmodified shape. */
export function hasCertificationBadges(certifications: string[] | undefined): boolean {
  return matchedBadges(certifications).length > 0;
}

/**
 * Returns [] (never a placeholder run) when nothing is recognized — the caller must render the
 * plain header in that case. Each returned TextRun is one self-contained, single-line shaded
 * badge ("AZURE CERTIFIED", etc.), meant to be appended after a right tab stop on one header line.
 */
export function buildCertificationBadgeRuns(certifications: string[] | undefined): TextRun[] {
  return matchedBadges(certifications).map(
    (badge) =>
      new TextRun({
        text: ` ${badge.label.toUpperCase()} CERTIFIED `,
        bold: true,
        size: SIZE_CONTACT,
        font: FONT,
        color: badge.textColor,
        shading: { type: ShadingType.CLEAR, fill: badge.fill, color: "auto" },
      })
  );
}
