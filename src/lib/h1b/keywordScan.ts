import type { SponsorshipPolarity } from "@/types";

// Checked first: an explicit disqualifier should win over any positive-sounding phrase nearby.
const NEGATIVE_PATTERNS = [
  /no\s+(visa\s+)?sponsorship/i,
  /without\s+sponsorship/i,
  /will\s+not\s+sponsor/i,
  /unable\s+to\s+sponsor/i,
  /does\s+not\s+(offer|provide)\s+(visa\s+)?sponsorship/i,
  /not\s+able\s+to\s+provide\s+(visa\s+)?sponsorship/i,
  /must\s+be\s+authorized\s+to\s+work.*without\s+(the\s+need\s+for\s+)?sponsorship/i,
  /no\s+c2c/i,
];

const POSITIVE_PATTERNS = [
  /will\s+sponsor/i,
  /(visa\s+)?sponsorship\s+(is\s+)?available/i,
  /h-?1b\s+sponsorship/i,
  /sponsors?\s+work\s+visas/i,
  /open\s+to\s+sponsor(ing|ship)/i,
];

const SNIPPET_CONTEXT_CHARS = 100;

function extractSnippet(text: string, match: RegExpExecArray): string {
  const start = Math.max(0, match.index - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(text.length, match.index + match[0].length + SNIPPET_CONTEXT_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

export interface SponsorshipScanResult {
  mentioned: boolean;
  polarity: SponsorshipPolarity;
  /** The matched sentence/phrase with surrounding context, for display and transparency. */
  snippet: string | null;
}

export function scanSponsorshipLanguage(text: string | null | undefined): SponsorshipScanResult {
  if (!text) return { mentioned: false, polarity: "none", snippet: null };

  for (const pattern of NEGATIVE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return { mentioned: true, polarity: "negative", snippet: extractSnippet(text, match) };
  }
  for (const pattern of POSITIVE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return { mentioned: true, polarity: "positive", snippet: extractSnippet(text, match) };
  }
  return { mentioned: false, polarity: "none", snippet: null };
}
