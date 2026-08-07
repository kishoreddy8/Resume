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

export function scanSponsorshipLanguage(text: string | null | undefined): {
  mentioned: boolean;
  polarity: SponsorshipPolarity;
} {
  if (!text) return { mentioned: false, polarity: "none" };

  for (const pattern of NEGATIVE_PATTERNS) {
    if (pattern.test(text)) return { mentioned: true, polarity: "negative" };
  }
  for (const pattern of POSITIVE_PATTERNS) {
    if (pattern.test(text)) return { mentioned: true, polarity: "positive" };
  }
  return { mentioned: false, polarity: "none" };
}
