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
//
// RULE ORDER IS LOAD-BEARING — matchKnownHeading returns the FIRST rule that matches, so a heading
// naming BOTH a preference and a qualification must be resolved by whichever rule sits earlier.
//
// STAGE 25A DEFECT (2,452 active jobs, measured on the real corpus). `niceToHave` used to sit AFTER
// `qualifications`, and `/qualif/` matches "Preferred Qualifications" — by far the most common way a
// JD labels its optional section ("Preferred Qualifications" 1,007 jobs, "Preferred Qualifications:"
// 631, "Preferred Qualifications (Desired Skills/Experience):" 460, ...). Every skill under such a
// heading was therefore stored with requirement_level 'Required' (see src/lib/jobIntel/skills.ts,
// which classifies purely by which section bucket a line landed in), inflating the Required
// requirement pool with genuinely optional asks and depressing required-coverage, criticality and
// readiness for one job in six. `niceToHave` now wins: an explicit preference cue in the heading is
// the more specific signal, and misrouting a requirement to Preferred is the conservative failure
// direction — it can never manufacture a Required requirement the posting did not state.
const SECTION_RULES: SectionRule[] = [
  {
    key: "responsibilities",
    keywords: /responsibilit|what you.?ll do|what you will do|the role|role overview|day.to.day|duties/i,
  },
  { key: "niceToHave", keywords: /nice to have|preferred|bonus|good to have/i },
  {
    // STAGE 25A DEFECT (+1,211 active jobs). `requirement` does not match the word "Required", so
    // real headings spelled "Required", "Required Education", "Required Work Experience" (506
    // occurrences across just the 4,349 jobs that ended up with no qualifications section at all)
    // matched NO rule — and an unmatched heading-shaped line RESETS the current section (see
    // parseDescriptionSections), so everything under them was silently discarded rather than
    // captured. "What you need" is the same class of miss: only the "what you'll need" contraction
    // was covered.
    key: "qualifications",
    keywords:
      /qualif|require(?:d|ment|ments)\b|what we.?re looking for|what you.?ll need|what you need|who you are|what we require|must have|basic (?:requirements|qualifications)/i,
  },
  { key: "skills", keywords: /\bskills\b|tech stack|technolog(?:y|ies)|competenc/i },
  { key: "benefits", keywords: /benefit|perks|what we offer|why join/i },
];

const MAX_HEADING_LENGTH = 60;
const MAX_HEADING_WORDS = 8;

/**
 * STAGE 25B — CONTEXT-AWARE SECTION TERMINATION.
 *
 * THE DEFECT. A heading-shaped line matching no SECTION_RULE used to reset the current section to
 * null, which silently discards everything after it. Two very different real-world lines hit that
 * path, and both lost genuine requirement evidence (1,558 active jobs measured):
 *   1. SUB-HEADINGS inside a qualifications list — "To be successful in this role you have:",
 *      "It also helps if you have:", "You should have:", "What You've Done:".
 *   2. Short requirement BULLETS that merely fit the heading shape — "Bachelor's degree",
 *      "High school diploma or GED", "Doctorate degree", "Universal EPA certification".
 * Traced on job 33046 (ServiceNow/Moveworks Staff SWE): line 17 "Qualifications" opened the section,
 * line 18 "To be successful in this role you have:" reset it to null, and lines 19-30 — the actual
 * 8+ years / Kubernetes / AWS-Azure-GCP / CI-CD / Go requirements — were dropped. Result: zero
 * sections, zero skills, and a UI reading "REQUIRED SKILLS: None extracted".
 *
 * WHY NOT JUST STOP RESETTING. Measured on the real 14,584-job corpus: simply keeping the section
 * open across every unmatched heading nearly DOUBLED captured requirement text (12.3M -> 21.9M
 * chars) and pulled EEO text into requirements for 19% of changed jobs, benefits for 13%,
 * compensation for 12%, drug-testing for 10%. A section with no recognized heading after it swallows
 * the entire rest of the document. That variant is rejected; see the Stage 25B regression test that
 * pins the no-bleed property.
 *
 * THE RULE. An unmatched heading-shaped line CLOSES the open section only when it reads like a
 * genuine new section LABEL. Three ordered signals, all evidence-driven:
 *   a. SECTION_TERMINATOR_PATTERNS — explicitly recognized non-requirement section labels
 *      (About/company, EEO/legal, accommodations, export control, compensation, background checks,
 *      agency notices, physical demands, ...). These close the section regardless of casing.
 *   b. A second-person LIST INTRODUCER ("... you have:", "What You've Done:") never closes a
 *      section — that phrasing introduces a list, it does not label a new one.
 *   c. Otherwise, close only if the line is LABEL-CASED (Title Case or ALL CAPS). Real section
 *      labels are noun-phrase labels ("Work Personas", "Additional Information", "Our Core Values");
 *      requirement bullets are sentence-cased ("Bachelor's degree", "High school diploma or GED").
 * Anything that survives all three is kept as CONTENT of the section already open — never as a
 * section opener, so this can only preserve evidence, never invent a new bucket.
 *
 * Net effect measured on the real corpus: +853 jobs gain a qualifications section, +516 Required and
 * +260 Preferred skill units, and only 64 jobs (0.44%) gain any boilerplate-matching requirement
 * unit — several of which are genuine requirements ("Pre-employment drug screen ... are required").
 */
const SECTION_TERMINATOR_PATTERNS: RegExp[] = [
  /^\s*about\b/i,
  /\bcompany (description|overview|profile|information)\b/i,
  /\bwho we are\b|\bour (story|mission|values|culture|company|commitment)\b/i,
  /\bequal (employment )?opportunity\b|\bEEO\b|\baffirmative action\b|\be-?verify\b/i,
  /\baccommodation/i,
  /\bexport control/i,
  /\badditional information\b/i,
  /\bwork personas?\b/i,
  /\bdisclaimer\b|\blegal notice\b|\bprivacy\b|\bnotice to\b/i,
  /\bbackground (check|screen)|drug (test|screen|free)|pre-?employment screening\b/i,
  /\b(how to apply|application (process|instructions|deadline|procedure))\b/i,
  /\bcompensation\b|\bpay (range|transparency|and benefits)\b|\bsalary (range|information)\b|\bbase pay\b|\btotal rewards\b|\bpay details\b/i,
  /\bphysical (demands|requirements)\b|\bwork environment\b|\bworking conditions\b/i,
  /\brecruitment fraud\b|\bstaffing agenc|\bagency (submissions|notice|policy)\b|\bthird[- ]party recruiters?\b/i,
  /\bprotected veterans?\b|\bdisability (status|accommodation)\b/i,
  /^\s*(job|position|role)\s+(description|summary|overview)\s*:?\s*$/i,
  /^\s*(overview|summary|introduction|next steps)\s*:?\s*$/i,
];

/** Stopwords that carry no capitalization signal in a Title-Cased label. */
const LABEL_CASE_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "on", "at", "to", "with", "is", "are", "as",
  "by", "from", "if", "it", "be", "you", "your", "we", "our", "us",
]);

/** ALL CAPS, or Title Case (every significant token starts uppercase) — how real labels are written. */
export function isLabelCased(line: string): boolean {
  const tokens = line.replace(/[:\-–—()&/,.]/g, " ").split(/\s+/).filter(Boolean);
  const letterTokens = tokens.filter((t) => /[A-Za-z]/.test(t));
  if (letterTokens.length === 0) return false;
  if (letterTokens.every((t) => t === t.toUpperCase())) return true;
  const significant = letterTokens.filter((t) => !LABEL_CASE_STOPWORDS.has(t.toLowerCase()));
  if (significant.length === 0) return false;
  return significant.every((t) => /^[A-Z0-9]/.test(t));
}

/** A second-person clause that introduces a list rather than labelling a new section. */
export function isListIntroducer(line: string): boolean {
  return /\b(you|your|you'?ll|you'?ve|you'?d)\b/i.test(line) && !/^\s*about\b/i.test(line);
}

/**
 * A list introducer that introduces an OPTIONAL list — "It also helps if you have:", "What will
 * make you stand out:", "It would be great if you had". Absorbing these into the surrounding
 * Required section would mark genuinely optional asks as Required, which is precisely the
 * fabrication Stage 25A fixed for "Preferred Qualifications" headings; they switch the section to
 * niceToHave instead.
 *
 * Gated on isListIntroducer (i.e. the line must be second-person) ON PURPOSE. The same preference
 * cues appear far more often on ordinary CONTENT bullets — "home care/health care background is a
 * plus" (23), "bilingual is a plus" (7), "bachelor's degree a plus" (4) — and those must never open
 * a section. Requiring the pronoun separates the introducer from the bullet.
 */
export function isPreferredListIntroducer(line: string): boolean {
  if (!isListIntroducer(line)) return false;
  return /also helps|stand ?out|would be (great|nice|a plus)|even better|extra credit|helpful if|nice if/i.test(line);
}

/** See SECTION_TERMINATOR_PATTERNS' doc comment for the full rule and the evidence behind it. */
export function closesSection(line: string): boolean {
  if (SECTION_TERMINATOR_PATTERNS.some((p) => p.test(line))) return true;
  if (isListIntroducer(line)) return false;
  return isLabelCased(line);
}

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
      const matched = matchKnownHeading(line);
      // Stage 25B: an unmatched heading-shaped line only ends an OPEN section when it reads like a
      // genuine new section label (see closesSection). Otherwise it is a sub-heading or a
      // heading-shaped requirement bullet, and its content stays where it belongs.
      if (matched === null && currentKey !== null && !closesSection(line)) {
        // A preferred list introducer opens the optional list rather than being absorbed into the
        // Required section around it — see isPreferredListIntroducer.
        if (isPreferredListIntroducer(line)) {
          flush();
          currentKey = "niceToHave";
          continue;
        }
        buffer.push(line);
        continue;
      }
      // Stage 25B: a sentence-cased line that "opens" the section it is ALREADY in is a requirement
      // bullet, not a heading — "Travel required" (52 occurrences on the real corpus) matches the
      // qualifications rule via `require(?:d)` while sitting inside an open Qualifications list.
      // Re-opening the same key is a no-op for the captured text either way, so the only effect of
      // treating it as a heading was to swallow the bullet itself. A genuine repeated label
      // ("Required Qualifications" twice) is label-cased and still handled as a heading.
      if (matched !== null && matched === currentKey && !isLabelCased(line)) {
        buffer.push(line);
        continue;
      }
      flush();
      currentKey = matched;
    } else if (currentKey) {
      buffer.push(line);
    }
  }
  flush();

  return Object.keys(sections).length > 0 ? sections : null;
}
