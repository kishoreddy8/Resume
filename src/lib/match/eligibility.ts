import type { H1bCompanyConfidence, RequirementTriState, SponsorshipPolarity } from "@/types";
import type { AppSettings } from "@/lib/settings";
import type { EligibilityResult, SponsorshipJobSignal } from "./types";

/**
 * Deterministic eligibility engine (Phase 2 Revision 4 §3). Reuses Phase 1's H1B combination
 * semantics EXACTLY as documented in src/lib/h1b/combineSignal.ts — this module never recomputes
 * sponsorship confidence, it only reads jobs.sponsorship_polarity and the company's OWN historical
 * h1b_confidence to decide what the sponsorship SIGNAL means for eligibility, preserving the
 * distinction Phase 1 already draws between JD-specific evidence and company-level historical
 * propensity (see combineH1bConfidence's doc comment — company history is positive evidence about
 * the COMPANY, never proof about one specific requisition).
 *
 * PASS means ONLY "no known hard blocker" — never "confirmed eligible" or "sponsorship confirmed".
 * Callers (the UI) must always render `reasons`/`sponsorship.note` alongside the status, never the
 * bare PASS label alone.
 */

export interface EligibilityJobInput {
  sponsorshipPolarity: SponsorshipPolarity;
  companyH1bConfidence: H1bCompanyConfidence;
  clearanceRequired: RequirementTriState | null;
  clearanceLevel: string | null;
  citizenshipRequired: RequirementTriState | null;
  workAuthorizationRequired: RequirementTriState | null;
}

const CLEARANCE_ORDINAL: Record<string, number> = {
  none: 0,
  "public trust": 1,
  secret: 2,
  "top secret": 3,
  "ts/sci": 4,
};

function clearanceOrdinal(level: string): number {
  return CLEARANCE_ORDINAL[level.trim().toLowerCase()] ?? 0;
}

/** Job's clearance_level is free text (src/lib/jobIntel/clearance.ts) — not guaranteed to match a
 *  known label exactly. An unparseable level with clearanceRequired==="Required" is still a real,
 *  stated requirement — treated conservatively as requiring AT LEAST "Public Trust", the lowest
 *  real clearance tier, rather than silently treated as satisfied by "None". */
function requiredClearanceOrdinal(levelText: string | null): number {
  if (!levelText) return 1;
  const known = Object.keys(CLEARANCE_ORDINAL).find((k) => levelText.toLowerCase().includes(k));
  return known ? CLEARANCE_ORDINAL[known] : 1;
}

function assessSponsorship(
  job: EligibilityJobInput,
  requiresSponsorship: boolean
): { signal: SponsorshipJobSignal; note: string; blocked: boolean; unknown: boolean } {
  if (!requiresSponsorship) {
    return { signal: "not_applicable", note: "Candidate does not require visa sponsorship — not a factor in eligibility.", blocked: false, unknown: false };
  }
  if (job.sponsorshipPolarity === "negative") {
    return {
      signal: "explicit_negative",
      note: "This posting explicitly states no visa sponsorship — hard blocker.",
      blocked: true,
      unknown: false,
    };
  }
  if (job.sponsorshipPolarity === "positive") {
    return {
      signal: "explicit_positive",
      note: "This posting explicitly offers sponsorship for this role — direct, role-specific evidence, though not a legal guarantee.",
      blocked: false,
      unknown: false,
    };
  }
  // Silent JD — fall back to the company's OWN historical confidence, exactly as
  // combineH1bConfidence does, but never presented as per-requisition proof.
  if (job.companyH1bConfidence !== "Unknown") {
    return {
      signal: "silent_company_history",
      note: `This posting does not itself state a sponsorship position. The employer has a historical H1B/LCA filing record (confidence: ${job.companyH1bConfidence}) — a positive signal about the company's general propensity, NOT confirmation that this specific requisition will sponsor. Verify directly.`,
      blocked: false,
      unknown: false,
    };
  }
  return {
    signal: "unknown",
    note: "No sponsorship signal available for this posting or employer — genuinely unknown, not assumed to pass.",
    blocked: false,
    unknown: true,
  };
}

export function evaluateEligibility(job: EligibilityJobInput, candidate: AppSettings["candidate"]): EligibilityResult {
  const reasons: string[] = [];
  let blocked = false;
  let unknown = false;

  const sponsorship = assessSponsorship(job, candidate.requiresSponsorship);
  if (sponsorship.blocked) {
    blocked = true;
    reasons.push(sponsorship.note);
  }
  if (sponsorship.unknown) unknown = true;

  if (job.clearanceRequired === "Required") {
    const required = requiredClearanceOrdinal(job.clearanceLevel);
    const held = clearanceOrdinal(candidate.clearanceLevel);
    if (held < required) {
      blocked = true;
      reasons.push(`This posting requires a security clearance${job.clearanceLevel ? ` (${job.clearanceLevel})` : ""} the candidate does not hold.`);
    }
  }

  if (job.citizenshipRequired === "Required" && !candidate.usCitizen) {
    blocked = true;
    reasons.push("This posting requires U.S. citizenship, which the candidate profile does not confirm.");
  }

  if (job.workAuthorizationRequired === "Required" && !candidate.workAuthorizedUS) {
    blocked = true;
    reasons.push("This posting requires existing U.S. work authorization, which the candidate profile does not confirm.");
  }

  const status: EligibilityResult["status"] = blocked ? "BLOCKED" : unknown ? "UNKNOWN" : "PASS";
  if (!blocked && unknown) reasons.push(sponsorship.note);
  if (status === "PASS" && reasons.length === 0) reasons.push("No known hard blocker identified.");

  return { status, reasons, sponsorship: { signal: sponsorship.signal, note: sponsorship.note } };
}
