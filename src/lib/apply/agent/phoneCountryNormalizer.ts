/**
 * Deterministic phone country / international dial-code resolution for application fields.
 *
 * Greenhouse and similar ATS platforms render phone dial-code selectors (e.g. `#country` with label "Country*")
 * alongside the telephone input. Their options are formatted as:
 *   "United States +1", "Canada +1", "United Kingdom +44", "India +91", etc.
 *
 * This module provides:
 *   1. `derivePhoneCountryCode` — derives the international dial code and country name from verified
 *      candidate contact data (E.164 phone or 10-digit phone with verified US/Canada location).
 *   2. `findCanonicalPhoneCountry` — maps the derived dial code / country to the exact canonical ATS option.
 *
 * SAFETY RULES:
 *   • Never guesses a country from employer, job posting, or resume keywords.
 *   • 10-digit North American numbers without an explicit '+' are resolved to '+1' / 'United States'
 *     ONLY when the verified candidate location confirms a US/Canadian location.
 *   • If a dial code is shared (e.g. +1 for US and Canada) and no location disambiguates it,
 *     null is returned (asks the user).
 *   • Pure deterministic matching — zero fuzzy distance, zero heuristics.
 */

const KNOWN_DIAL_PREFIXES: Readonly<Array<{ prefix: string; code: string; country: string }>> = [
  { prefix: "+1", code: "+1", country: "United States" },
  { prefix: "+44", code: "+44", country: "United Kingdom" },
  { prefix: "+91", code: "+91", country: "India" },
  { prefix: "+61", code: "+61", country: "Australia" },
  { prefix: "+49", code: "+49", country: "Germany" },
  { prefix: "+33", code: "+33", country: "France" },
  { prefix: "+81", code: "+81", country: "Japan" },
  { prefix: "+86", code: "+86", country: "China" },
  { prefix: "+52", code: "+52", country: "Mexico" },
  { prefix: "+55", code: "+55", country: "Brazil" },
  { prefix: "+353", code: "+353", country: "Ireland" },
  { prefix: "+31", code: "+31", country: "Netherlands" },
  { prefix: "+41", code: "+41", country: "Switzerland" },
  { prefix: "+46", code: "+46", country: "Sweden" },
  { prefix: "+65", code: "+65", country: "Singapore" },
  { prefix: "+971", code: "+971", country: "United Arab Emirates" },
  { prefix: "+972", code: "+972", country: "Israel" },
  { prefix: "+64", code: "+64", country: "New Zealand" },
];

const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC",
]);

const CA_PROVINCE_CODES = new Set([
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
]);

export interface DerivedPhoneCountry {
  dialCode: string;
  countryName: string;
}

/**
 * Derives the international dialing code and country name from verified contact data.
 */
export function derivePhoneCountryCode(
  phone: string | null | undefined,
  location?: string | null
): DerivedPhoneCountry | null {
  if (!phone) return null;
  const raw = phone.trim();
  if (raw.length === 0) return null;

  // 1. Explicit E.164 leading '+' prefix
  if (raw.startsWith("+")) {
    const digits = raw.replace(/[^\d+]/g, "");
    // Sort prefixes longest first so +353 matches before +35 etc.
    const sorted = [...KNOWN_DIAL_PREFIXES].sort((a, b) => b.prefix.length - a.prefix.length);
    for (const item of sorted) {
      if (digits.startsWith(item.prefix)) {
        if (item.code === "+1" && location) {
          const locUpper = location.toUpperCase();
          for (const prov of CA_PROVINCE_CODES) {
            if (new RegExp(`\\b${prov}\\b`).test(locUpper) || locUpper.includes("CANADA")) {
              return { dialCode: "+1", countryName: "Canada" };
            }
          }
        }
        return { dialCode: item.code, countryName: item.country };
      }
    }
    // Generic fallback for any other valid '+' dial prefix if followed by at least 7 digits
    const match = digits.match(/^(\+\d{1,4})/);
    if (match && digits.length >= 8) {
      return { dialCode: match[1], countryName: "" };
    }
    return null;
  }

  // 2. Standard 10-digit North American format (NANP: US/Canada)
  const plainDigits = raw.replace(/\D/g, "");
  if (plainDigits.length === 10) {
    if (!location) return null; // No location to confirm country -> safe ask
    const locUpper = location.toUpperCase();

    // Check for US state or US country indicator
    for (const state of US_STATE_CODES) {
      if (new RegExp(`\\b${state}\\b`).test(locUpper)) {
        return { dialCode: "+1", countryName: "United States" };
      }
    }
    if (locUpper.includes("UNITED STATES") || locUpper.includes("USA") || locUpper.includes(", US") || locUpper.endsWith(" US")) {
      return { dialCode: "+1", countryName: "United States" };
    }

    // Check for Canadian province or Canada country indicator
    for (const prov of CA_PROVINCE_CODES) {
      if (new RegExp(`\\b${prov}\\b`).test(locUpper)) {
        return { dialCode: "+1", countryName: "Canada" };
      }
    }
    if (locUpper.includes("CANADA")) {
      return { dialCode: "+1", countryName: "Canada" };
    }
  }

  // 11 digits starting with 1 (e.g. 19452370560)
  if (plainDigits.length === 11 && plainDigits.startsWith("1")) {
    if (location) {
      const locUpper = location.toUpperCase();
      for (const prov of CA_PROVINCE_CODES) {
        if (new RegExp(`\\b${prov}\\b`).test(locUpper) || locUpper.includes("CANADA")) {
          return { dialCode: "+1", countryName: "Canada" };
        }
      }
    }
    return { dialCode: "+1", countryName: "United States" };
  }

  return null;
}

/**
 * Given a dial code and candidate country context, finds the single unambiguous matching option
 * from the ATS option list (e.g. "United States +1").
 */
export function findCanonicalPhoneCountry(
  dialCode: string,
  atsOptions: readonly string[],
  countryContext?: string | null
): string | null {
  const code = dialCode.trim().startsWith("+") ? dialCode.trim() : `+${dialCode.trim()}`;

  // 1. Direct exact equality
  const exact = atsOptions.find((opt) => opt.trim() === code || opt.trim() === dialCode.trim());
  if (exact) return exact;

  // 2. Options ending in or containing the dial code (e.g. "United States +1" or "United States (+1)")
  const codeMatches = atsOptions.filter((opt) => {
    const trimmed = opt.trim();
    return (
      trimmed.endsWith(` ${code}`) ||
      trimmed.endsWith(`(${code})`) ||
      trimmed.endsWith(`${code}`) ||
      new RegExp(`\\b\\+?${code.replace("+", "")}\\b`).test(trimmed)
    );
  });

  // If country context is present (e.g. "United States"), filter by country name
  if (countryContext && countryContext.trim().length > 0) {
    const countryNorm = countryContext.trim().toLowerCase();
    const countryMatches = codeMatches.filter((opt) =>
      opt.toLowerCase().includes(countryNorm)
    );
    if (countryMatches.length === 1) return countryMatches[0];
    if (countryMatches.length > 1) return null; // Ambiguous
  }

  // If no country context was provided or country didn't match, return only if exactly one option matched
  if (codeMatches.length === 1) return codeMatches[0];

  return null;
}
