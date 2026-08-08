import type { RequirementTriState } from "@/types";
import type { ExtractedClearance } from "./types";

// Deliberately separate from src/lib/h1b/keywordScan.ts's sponsorship patterns — clearance,
// citizenship, and general work-authorization language never touches sponsorship_polarity or
// h1b_combined_confidence, per the spec's "do not merge security-clearance restrictions with
// ordinary sponsorship logic."
const CLEARANCE_REQUIRED_PATTERN =
  /\b(security clearance required|must (?:have|hold|possess|obtain) (?:an?\s+)?(?:active\s+)?(?:security\s+)?clearance|active clearance required|clearance is required)\b/i;
const CLEARANCE_LEVEL_PATTERN = /\b(top secret\/?sci|ts\/sci|top secret|secret clearance|confidential clearance|public trust)\b/i;

const CITIZENSHIP_REQUIRED_PATTERN =
  /\b(u\.?s\.?\s*citizen(?:ship)?\s*(?:is\s*)?required|must be a\s+u\.?s\.?\s*citizen|us citizens only|citizens only)\b/i;

const WORK_AUTH_REQUIRED_PATTERN =
  /\b(must be authorized to work|authorized to work in the (?:us|u\.s\.|united states)|legally authorized to work)\b/i;

function classify(pattern: RegExp, text: string): { state: RequirementTriState; evidence: string | null } {
  const m = text.match(pattern);
  return m ? { state: "Required", evidence: m[0] } : { state: "Unknown", evidence: null };
}

export function extractClearance(descriptionText: string | null): ExtractedClearance {
  if (!descriptionText) {
    return { required: "Unknown", level: null, citizenshipRequired: "Unknown", workAuthorizationRequired: "Unknown", evidence: null };
  }

  const clearance = classify(CLEARANCE_REQUIRED_PATTERN, descriptionText);
  const levelMatch = descriptionText.match(CLEARANCE_LEVEL_PATTERN);
  const citizenship = classify(CITIZENSHIP_REQUIRED_PATTERN, descriptionText);
  const workAuth = classify(WORK_AUTH_REQUIRED_PATTERN, descriptionText);

  // A named clearance level (e.g. "Secret clearance") is itself strong evidence clearance is
  // required, even if the generic "clearance required" phrasing isn't also present.
  const required: RequirementTriState = clearance.state === "Required" || levelMatch ? "Required" : "Unknown";

  const evidenceParts = [clearance.evidence, levelMatch?.[0], citizenship.evidence, workAuth.evidence].filter(
    (v): v is string => Boolean(v)
  );

  return {
    required,
    level: levelMatch ? levelMatch[0] : null,
    citizenshipRequired: citizenship.state,
    workAuthorizationRequired: workAuth.state,
    evidence: evidenceParts.length > 0 ? evidenceParts.join(" | ") : null,
  };
}
