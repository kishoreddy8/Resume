import { htmlToBlockText } from "@/lib/parseSections";

/**
 * Splits a job's description into line-shaped chunks for cue-word windowing (skills/experience/
 * education classification needs "what sentence/bullet is this near", not just "is this word
 * anywhere in the JD"). Prefers descriptionHtml (block-boundary-preserving) over descriptionText
 * (single-line by construction — see stripHtml.ts) since it gives real line granularity; falls back
 * to a sentence split of descriptionText when no HTML is available (e.g. malformed/sparse JDs).
 */
export function toLines(descriptionHtml: string | null, descriptionText: string | null): string[] {
  if (descriptionHtml) {
    const lines = htmlToBlockText(descriptionHtml)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 0) return lines;
  }
  if (descriptionText) {
    return descriptionText
      .split(/(?<=[.!?])\s+(?=[A-Z(])|(?<=[.!?])\s*\n+\s*/)
      .map((l) => l.trim())
      .filter(Boolean);
  }
  return [];
}

/** Escapes a string for safe use inside a RegExp constructor. */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const REQUIRED_CUES =
  /\b(must have|must|required|require[sd]?|minimum(?:\s+of)?|need(?:s|ed)?(?:\s+to)?|demonstrated experience|mandatory)\b/i;
const PREFERRED_CUES =
  /\b(preferred|nice[\s-]to[\s-]have|bonus|(?:^|\s)plus\b|ideally|desirable|good to have|a plus)\b/i;

/** Returns the requirement-cue classification for a single line/sentence, or null if neither a
 *  required- nor preferred-signaling cue word is present — callers must not default this to
 *  Required (never fabricate a requirement level from silence). */
export function classifyCueLine(line: string): "Required" | "Preferred" | null {
  if (PREFERRED_CUES.test(line)) return "Preferred";
  if (REQUIRED_CUES.test(line)) return "Required";
  return null;
}

/** ~120 chars of context centered on a match, trimmed to word boundaries — matches the style of
 *  src/lib/h1b/keywordScan.ts's extractSnippet so evidence text reads consistently across the app. */
export function extractSnippet(text: string, matchIndex: number, matchLength: number, radius = 60): string {
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(text.length, matchIndex + matchLength + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}
