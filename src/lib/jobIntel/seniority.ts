import type { Seniority } from "@/types";
import type { ExtractedSeniority } from "./types";

// Order matters: more specific/senior patterns checked first so e.g. "Senior Manager" resolves to
// Manager-family seniority correctly rather than matching "Senior" alone, and "Team Lead" doesn't
// get swallowed by a looser "Lead" check placed too early.
const TITLE_PATTERNS: { level: Seniority; regex: RegExp }[] = [
  { level: "Intern", regex: /\bintern(ship)?\b/i },
  { level: "Director", regex: /\bdirector\b/i },
  { level: "Manager", regex: /\bmanager\b/i },
  { level: "Principal", regex: /\bprincipal\b/i },
  { level: "Staff", regex: /\bstaff\b/i },
  { level: "Lead", regex: /\blead\b/i },
  { level: "Senior", regex: /\b(senior|sr\.?)\b/i },
  { level: "Junior", regex: /\b(junior|jr\.?)\b/i },
  { level: "Entry", regex: /\bentry[\s-]level\b/i },
];

// JD-body fallback phrasing, used only when the title itself gives no signal (e.g. generic
// career_link titles like "Data Engineer", or a title that omits a level stated in the prose —
// "Ostium is looking for a senior-level data engineer..." with a bare "Data Engineer" title, found
// via real-JD validation). Order matches TITLE_PATTERNS' most-specific-first reasoning.
const BODY_PATTERNS: { level: Seniority; regex: RegExp }[] = [
  { level: "Director", regex: /\bdirector[\s-]level\b/i },
  { level: "Principal", regex: /\bprincipal[\s-]level\b/i },
  { level: "Staff", regex: /\bstaff[\s-]level\b/i },
  { level: "Lead", regex: /\blead[\s-]level\b|looking for a lead\b/i },
  { level: "Senior", regex: /\bsenior[\s-]level\b|looking for a senior\b|\bseasoned\b|\bextensive experience\b/i },
  { level: "Entry", regex: /entry[\s-]level position|no prior experience required|recent graduate/i },
];

export function extractSeniority(title: string): ExtractedSeniority {
  for (const { level, regex } of TITLE_PATTERNS) {
    const m = title.match(regex);
    if (m) return { level, evidence: title };
  }
  return { level: "Unknown", evidence: null };
}

/** Only consulted by the orchestrator when title-based extraction is Unknown. */
export function extractSeniorityFromBody(descriptionText: string | null): ExtractedSeniority {
  if (!descriptionText) return { level: "Unknown", evidence: null };
  for (const { level, regex } of BODY_PATTERNS) {
    const m = descriptionText.match(regex);
    if (m) return { level, evidence: m[0] };
  }
  return { level: "Unknown", evidence: null };
}
