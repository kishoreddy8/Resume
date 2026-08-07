/**
 * Best-effort fallback for ATS providers (Greenhouse, Lever) that don't expose a structured
 * compensation field. Ashby's own `compensation.scrapeableCompensationSalarySummary` should
 * always be preferred over this when present.
 */
const SALARY_PATTERNS: RegExp[] = [
  // "$120,000 - $150,000" / "$120K - $150K" / "$120,000–$150,000/year"
  /\$\s?\d[\d,]*(?:\.\d+)?\s?[kK]?\s?(?:-|–|to)\s?\$\s?\d[\d,]*(?:\.\d+)?\s?[kK]?(?:\s?\/?\s?(?:year|yr|hour|hr|annually))?/,
  // "$45/hr" or "$45 per hour"
  /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:\/|per)\s?(?:hour|hr)/i,
  // "120,000 - 150,000 USD"
  /\d[\d,]{4,}\s?(?:-|–|to)\s?\d[\d,]{4,}\s?(?:USD|CAD)/i,
];

export function extractSalaryText(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const pattern of SALARY_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0].trim();
  }
  return null;
}
