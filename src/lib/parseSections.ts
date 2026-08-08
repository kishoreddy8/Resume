import { decodeHtmlEntities } from "@/lib/stripHtml";
import type { DescriptionSections } from "@/types";

/**
 * Converts HTML to plain text but keeps block-level boundaries as newlines (stripHtml collapses
 * everything to one line, which destroys the heading structure section-parsing depends on).
 * Exported for reuse by src/lib/jobIntel/ — line-level structure is what several extractors
 * (skills, experience, education) need for cue-word windowing, and duplicating this HTML→text
 * conversion elsewhere would risk it drifting out of sync with section parsing.
 */
export function htmlToBlockText(html: string): string {
  const decoded = decodeHtmlEntities(html);
  return decoded
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

interface SectionRule {
  key: keyof DescriptionSections;
  keywords: RegExp;
}

// Keyword-contains rather than exact-line match, so "Core Responsibilities" / "What We Require"
// style real-world phrasing matches, not just the exact canonical phrase.
const SECTION_RULES: SectionRule[] = [
  {
    key: "responsibilities",
    keywords: /responsibilit|what you.?ll do|what you will do|the role|role overview|day.to.day|duties/i,
  },
  {
    key: "qualifications",
    keywords:
      /qualif|requirement|what we.?re looking for|what you.?ll need|who you are|what we require|must have|basic (?:requirements|qualifications)/i,
  },
  { key: "niceToHave", keywords: /nice to have|preferred|bonus|good to have/i },
  { key: "skills", keywords: /\bskills\b|tech stack|technolog(?:y|ies)|competenc/i },
  { key: "benefits", keywords: /benefit|perks|what we offer|why join/i },
];

const MAX_HEADING_LENGTH = 60;
const MAX_HEADING_WORDS = 8;

/**
 * A line is "heading-shaped" if it's short, has no sentence-ending punctuation, and isn't a bullet.
 *
 * Two additional exclusions were added after real-JD auditing found short (<=60 char, <=8 word)
 * ORDINARY content lines being misclassified as headings, which silently drops everything after
 * them up to the next recognized heading (a "heading-shaped but unmatched" line resets the current
 * section without capturing under any key — see parseDescriptionSections below):
 *   - 2+ commas: real section labels in this codebase's own data are always comma-free ("What
 *     You'll Do", "Technical requirements:"); a short requirement bullet that happens to fit the
 *     length/word budget ("Deep expertise with schema design, evolution, and iteration") reliably
 *     has 1+ commas from listing multiple things.
 *   - starts with a digit or "$": genuine headings are prose labels, never data values — this
 *     specifically fixes a recurring Workday salary-widget artifact ("$81,456.37-$112,002.51Pay
 *     Type:") that otherwise orphans everything between it and the next real heading in ~most
 *     Workday-sourced postings.
 * Both exclusions were verified against every currently-recognized heading in the live dataset
 * before adding (zero false negatives introduced).
 */
function looksLikeHeading(line: string): boolean {
  if (line.length === 0 || line.length > MAX_HEADING_LENGTH) return false;
  if (/[.!?,;]$/.test(line)) return false;
  if (/^[-•*]/.test(line)) return false;
  if (/^[$0-9]/.test(line)) return false;
  if ((line.match(/,/g) ?? []).length >= 2) return false;
  const wordCount = line.split(/\s+/).length;
  return wordCount <= MAX_HEADING_WORDS;
}

function matchKnownHeading(line: string): keyof DescriptionSections | null {
  for (const rule of SECTION_RULES) {
    if (rule.keywords.test(line)) return rule.key;
  }
  return null;
}

/**
 * Best-effort heading-based extraction — ATS providers don't give responsibilities/qualifications
 * as structured API fields, so this splits the description on heading-shaped lines. An unmatched
 * heading (e.g. "What We Value") ends the current section without being captured under any known
 * key, rather than bleeding into whichever section came before it. Returns null if no recognized
 * headings were found at all, so callers fall back to the full description.
 */
export function parseDescriptionSections(html: string | null): DescriptionSections | null {
  if (!html) return null;
  const lines = htmlToBlockText(html).split("\n");

  const sections: DescriptionSections = {};
  let currentKey: keyof DescriptionSections | null = null;
  let buffer: string[] = [];

  function flush() {
    if (currentKey && buffer.length > 0) {
      const text = buffer.join("\n").trim();
      if (text) sections[currentKey] = [sections[currentKey], text].filter(Boolean).join("\n");
    }
    buffer = [];
  }

  for (const line of lines) {
    if (looksLikeHeading(line)) {
      flush();
      currentKey = matchKnownHeading(line);
    } else if (currentKey) {
      buffer.push(line);
    }
  }
  flush();

  return Object.keys(sections).length > 0 ? sections : null;
}
