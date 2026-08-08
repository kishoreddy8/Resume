import type { ExtractedCompensation } from "./types";

const EMPTY: ExtractedCompensation = {
  min: null,
  max: null,
  currency: null,
  period: null,
  bonus: null,
  commission: null,
  equity: null,
};

/** "$120,000", "$120K", "120,000" → a plain number. Never converts units — a "K" suffix multiplies
 *  by 1000, that's it; hourly figures stay hourly, annual figures stay annual. */
function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[$,]/g, "").trim();
  const kMatch = cleaned.match(/^(\d+(?:\.\d+)?)\s*[kK]$/);
  if (kMatch) return Number(kMatch[1]) * 1000;
  const plain = cleaned.match(/^\d+(?:\.\d+)?$/);
  return plain ? Number(cleaned) : null;
}

const HOURLY_HINT = /\/\s?(?:hr|hour)\b|per\s+hour|hourly/i;
const RANGE_PATTERN =
  /\$?\s?(\d[\d,]*(?:\.\d+)?\s?[kK]?)\s?(?:-|–|to)\s?\$?\s?(\d[\d,]*(?:\.\d+)?\s?[kK]?)/;
const SINGLE_PATTERN = /\$\s?(\d[\d,]*(?:\.\d+)?\s?[kK]?)/;
const CURRENCY_PATTERN = /\b(USD|CAD|EUR|GBP)\b/i;

/**
 * Structures the raw salary substring already extracted by src/lib/extractSalary.ts — this never
 * re-scans the description from scratch, it only parses jobs.salary_text further.
 */
export function parseCompensation(salaryText: string | null, descriptionText: string | null): ExtractedCompensation {
  if (!salaryText) return EMPTY;

  const period: "annual" | "hourly" | null = HOURLY_HINT.test(salaryText) ? "hourly" : "annual";
  const currencyMatch = salaryText.match(CURRENCY_PATTERN);
  const currency = currencyMatch ? currencyMatch[1].toUpperCase() : "USD";

  const rangeMatch = salaryText.match(RANGE_PATTERN);
  let min: number | null = null;
  let max: number | null = null;
  if (rangeMatch) {
    min = parseAmount(rangeMatch[1]);
    max = parseAmount(rangeMatch[2]);
  } else {
    const singleMatch = salaryText.match(SINGLE_PATTERN);
    if (singleMatch) min = parseAmount(singleMatch[1]);
  }

  if (min === null && max === null) return { ...EMPTY, currency: null };

  const bonusMatch = descriptionText?.match(/\b(annual\s+)?bonus\b[^.;\n]{0,60}/i) ?? null;
  const commissionMatch = descriptionText?.match(/\bcommission\b[^.;\n]{0,60}/i) ?? null;
  const equityMatch = descriptionText?.match(/\b(equity|stock options?|RSUs?)\b[^.;\n]{0,60}/i) ?? null;

  return {
    min,
    max,
    currency,
    period,
    bonus: bonusMatch ? bonusMatch[0].trim() : null,
    commission: commissionMatch ? commissionMatch[0].trim() : null,
    equity: equityMatch ? equityMatch[0].trim() : null,
  };
}
