import type { EmploymentTypeNormalized } from "@/types";
import type { ExtractedEmploymentType } from "./types";

// Native ATS values seen in practice: Ashby/Lever give "Full-time"/"Part-time"/"Contract"/
// "Internship"/"Temporary"; Workday's timeType gives "Full time"/"Part time"; some feeds send
// PascalCase with no separator at all ("FullTime", "PartTime") — the separator is optional here for
// that reason, matching src/lib/jobIntel/location.ts's normalizeWorkplaceType's same pattern for
// "OnSite". Order matters: "Contract-to-Hire"/"Contract to hire" must be checked before the bare
// "Contract" pattern. Every pattern is word-boundary-anchored — "intern"/"temp" without \b would
// false-match substrings like "International" / "temperature"/"attempt" (caught via real-JD
// validation, see the backfill script's --verbose output).
const TYPE_PATTERNS: { type: EmploymentTypeNormalized; regex: RegExp }[] = [
  { type: "Contract-to-Hire", regex: /\bcontract[\s-]?to[\s-]?hire\b|\bc2h\b/i },
  { type: "Internship", regex: /\bintern(?:ship)?\b/i },
  { type: "Temporary", regex: /\btemp(?:orary)?\b/i },
  { type: "Part-Time", regex: /\bpart[\s-]?time\b/i },
  { type: "Contract", regex: /\bcontract(?:or)?\b/i },
  { type: "Full-Time", regex: /\bfull[\s-]?time\b/i },
];

function normalize(raw: string): EmploymentTypeNormalized | null {
  const match = TYPE_PATTERNS.find((p) => p.regex.test(raw));
  return match ? match.type : null;
}

export function normalizeEmploymentType(nativeValue: string | null, descriptionText: string | null): ExtractedEmploymentType {
  if (nativeValue) {
    const normalized = normalize(nativeValue);
    if (normalized) return { type: normalized, evidence: nativeValue };
  }
  if (descriptionText) {
    for (const { type, regex } of TYPE_PATTERNS) {
      const m = descriptionText.match(regex);
      if (m) return { type, evidence: m[0] };
    }
  }
  return { type: "Unknown", evidence: null };
}

// Vendor-language flags — surfaced via job_quality_flags rather than dedicated columns (matches
// the spec's own grouping of W2/C2C under quality/risk signals, not employment type).
const W2_ONLY = /\bw[\s-]?2\s+only\b|\bw2[\s-]?only\b/i;
const C2C_MENTIONED = /\bc2c\b|corp[\s-]to[\s-]corp/i;
const NO_C2C = /\bno\s+c2c\b|\bc2c\s+not\s+accepted\b/i;

export function extractVendorFlags(descriptionText: string | null): string[] {
  if (!descriptionText) return [];
  const flags: string[] = [];
  if (W2_ONLY.test(descriptionText)) flags.push("W2 Only");
  if (NO_C2C.test(descriptionText)) flags.push("No C2C");
  else if (C2C_MENTIONED.test(descriptionText)) flags.push("C2C");
  return flags;
}
